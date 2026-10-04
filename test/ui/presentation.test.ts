import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Controller } from "../../src/core/controller.ts";
import type { FlightPhase } from "../../src/core/domain.ts";
import type { AttentionItem } from "../../src/core/traffic.ts";
import { DEMO_FLIGHTS, JWT_MIGRATION, ROTATION_V1 } from "../../src/demo/scenario.ts";
import { agentName, attentionItems, counts, decisionLabel, flightBadge, scopeOf } from "../../src/ui/model.ts";
import { ContextPanel } from "../../src/ui/panels/Context.tsx";
import { Traffic } from "../../src/ui/panels/Traffic.tsx";
import { TaskRow, Work } from "../../src/ui/panels/Work.tsx";
import { freshState } from "../fixtures.ts";

function scenario() {
	const controller = new Controller(freshState(), 1000);
	for (const demo of DEMO_FLIGHTS) {
		const mission = controller.createMission({ ...demo.mission });
		const flight = controller.createFlight({ missionId: mission.id, agent: "mock" });
		controller.submitPlan(flight.id, demo.plan);
	}
	return controller;
}

const decision: AttentionItem = {
	id: "semantic:F-021|F-022",
	kind: "semantic",
	severity: "high",
	flights: ["F-021", "F-022"],
	title: "Confirm these intentions are compatible",
	detail: "The two changes may require a decision.",
};

describe("task presentation", () => {
	it("keeps partially cleared work Working and names the waiting scope", () => {
		const state = scenario().state;
		const badge = flightBadge(state.flights[0], state.traffic.clearances["F-021"], state);
		expect(badge).toMatchObject({ label: "Working", tone: "working", detail: "Waiting on TokenValidator.validate()" });
		expect(counts(state)).toMatchObject({ active: 3, overlapping: 2, automatic: 1, attention: 0 });
		expect(agentName(state.flights[0])).toBe("Demo agent");
	});

	it("labels a whole-run hold Waiting without claiming partial clearance", () => {
		const controller = new Controller(freshState(), 1000);
		for (const plan of [{ ...ROTATION_V1, writeSet: [{ type: "symbol" as const, resource: "TokenValidator.validate" }] }, JWT_MIGRATION]) {
			const mission = controller.createMission({ title: plan.summary });
			const flight = controller.createFlight({ missionId: mission.id, agent: "mock" });
			controller.submitPlan(flight.id, plan);
		}
		const state = controller.state;
		expect(flightBadge(state.flights[0], state.traffic.clearances["F-021"], state).label).toBe("Waiting");
		const markup = renderToStaticMarkup(createElement(TaskRow, { flight: state.flights[0], state, onSelect: () => {} }));
		expect(markup).not.toContain("Partial clearance");
	});

	it("deduplicates attention and prioritizes it over automatic replanning", () => {
		const state = scenario().state;
		state.attention.push(decision);
		state.traffic.attention.push({ ...decision });
		state.flights[0].stale = { since: 1001, byFlight: "F-022", reasons: ["Contract changed"], newBaseline: "next" };
		expect(attentionItems(state)).toHaveLength(1);
		expect(counts(state).attention).toBe(1);
		expect(flightBadge(state.flights[0], state.traffic.clearances["F-021"], state).label).toBe("Needs attention");
	});

	it("shows automatic stale-plan recovery as Planning before a full replan hold", () => {
		const state = scenario().state;
		state.flights[0].stale = { since: 1001, byFlight: "F-022", reasons: ["Contract changed"], newBaseline: "next" };
		state.traffic.clearances["F-021"].status = "hold";
		expect(flightBadge(state.flights[0], state.traffic.clearances["F-021"], state)).toMatchObject({
			label: "Planning",
			detail: `Updating plan after ${state.flights[1].title} completed`,
		});
	});

	it.each<[FlightPhase, string]>([
		["landed", "Done"],
		["cancelled", "Cancelled"],
		["failed", "Failed"],
		["lost", "Failed"],
	])("keeps terminal %s distinct from stale attention", (phase, label) => {
		const state = scenario().state;
		state.attention.push(decision);
		state.flights[0].phase = phase;
		state.flights[0].failureReason = "Agent stopped";
		expect(flightBadge(state.flights[0], state.traffic.clearances["F-021"], state).label).toBe(label);
	});

	it.each<[FlightPhase, string, string]>([
		["queued", "Waiting", "Queued"],
		["provisioning", "Waiting", "Preparing workspace"],
		["discovery", "Exploring", "Reading the repository"],
	])("does not claim execution before a plan for %s", (phase, label, detail) => {
		const controller = new Controller(freshState(), 1000);
		const mission = controller.createMission({ title: "New task" });
		const flight = controller.createFlight({ missionId: mission.id, agent: "mock" });
		controller.setPhase(flight.id, phase);
		expect(flightBadge(flight, undefined, controller.state)).toMatchObject({ label, detail });
	});

	it.each<[FlightPhase, string]>([
		["publishing", "Publishing changes"],
		["validating", "Running validation"],
		["landing", "Checking integration"],
	])("uses Checking only when %s is reported", (phase, detail) => {
		const state = scenario().state;
		const flight = state.flights[2];
		flight.phase = phase;
		expect(flightBadge(flight, state.traffic.clearances[flight.id], state)).toMatchObject({ label: "Checking", detail });
	});

	it("does not invent running checks or completion from a published commit", () => {
		const state = scenario().state;
		const flight = state.flights[2];
		flight.publishes.push({ at: 1002, commit: "abc1234", approved: true, verified: true, touched: [], outside: [], message: "Changes" });
		expect(flightBadge(flight, state.traffic.clearances[flight.id], state).label).toBe("Working");
		flight.publishes[0].tests = { passed: true, summary: "11 tests passed (reported by agent)" };
		expect(flightBadge(flight, state.traffic.clearances[flight.id], state).label).toBe("Working");
	});

	it("distinguishes human intervention and unresolved decisions from automatic handling", () => {
		const controller = scenario();
		controller.applyOverride("F-021|F-022", "accept", "you");
		const congestion = controller.state.traffic.congestions.find((c) => c.key === "F-021|F-022")!;
		expect(decisionLabel(congestion)).toBe("Human override");
		expect(counts(controller.state).automatic).toBe(0);
		expect(decisionLabel({ ...congestion, resolution: "attention", override: undefined })).toBe("Needs a decision");
	});
});

describe("first frame", () => {
	it("introduces the repository, three tasks, automatic overlap and no human action", () => {
		const state = scenario().state;
		const markup = renderToStaticMarkup(
			createElement(Work, {
				state,
				busy: false,
				attentionOnly: false,
				onSelect: () => {},
				onAttention: () => {},
				act: async () => {},
			}),
		);
		expect(markup).toContain("auth-service");
		for (const demo of DEMO_FLIGHTS) expect(markup).toContain(demo.mission.title);
		expect(markup).toContain("0 need your attention");
		expect(markup).toContain("2 tasks overlap");
		expect(markup).toContain("Cruce handled it");
		expect(markup).toContain("Waiting on TokenValidator.validate()");
		expect(markup).toContain("Partial clearance");
		expect(markup).toContain('aria-label="Active work"');
		expect(markup).not.toMatch(/\b(?:Flight|Mission|Airspace|Landing|LANDED|CLEAR|HOLD)\b/);
	});

	it("keeps lost terminal runs visible when filtering for unresolved attention", () => {
		const controller = scenario();
		controller.fail("F-021", "Agent connection lost", true);
		const markup = renderToStaticMarkup(
			createElement(Work, {
				state: controller.state,
				busy: false,
				attentionOnly: true,
				onSelect: () => {},
				onAttention: () => {},
				act: async () => {},
			}),
		);
		expect(markup).toContain('aria-label="Tasks needing attention"');
		expect(markup).toContain('class="task-row task-row-done"');
		expect(markup).toContain("Agent connection lost");
		expect(markup).not.toContain("Nothing needs your attention");
	});

	it("does not claim the repository is up to date when every run failed or was cancelled", () => {
		const controller = scenario();
		controller.fail("F-021", "Build failed");
		controller.cancel("F-022", "you");
		controller.cancel("F-023", "you");
		const markup = renderToStaticMarkup(
			createElement(Work, {
				state: controller.state,
				busy: false,
				attentionOnly: false,
				onSelect: () => {},
				onAttention: () => {},
				act: async () => {},
			}),
		);
		expect(markup).not.toContain("Your repository is up to date");
		expect(markup).toContain("No active work");
	});

	it("shows the failure reason ahead of an earlier successful validation in a closed run", () => {
		const controller = scenario();
		const flight = controller.state.flights[0];
		flight.publishes.push({
			at: 1001,
			commit: "abc1234",
			approved: true,
			outside: [],
			touched: [],
			message: "Partial work",
			tests: { passed: true, summary: "12 tests passed" },
		});
		controller.fail(flight.id, "Agent process exited unexpectedly");
		const markup = renderToStaticMarkup(createElement(TaskRow, { state: controller.state, flight, onSelect: () => {} }));
		expect(markup).toContain("Agent process exited unexpectedly");
		expect(markup).not.toContain("12 tests passed");
	});

	it("preserves actual file names in scope summaries", () => {
		const controller = new Controller(freshState(), 1000);
		const mission = controller.createMission({ title: "Update package metadata" });
		const flight = controller.createFlight({ missionId: mission.id, agent: "mock" });
		controller.submitPlan(flight.id, {
			summary: "Update package metadata",
			objective: "Update package metadata",
			writeSet: [{ type: "file", resource: "package.json" }],
		});
		expect(scopeOf(flight, controller.state)).toContain("package.json");
	});
});

describe("decision and validation provenance", () => {
	const common = {
		git: null,
		projectId: "demo",
		integrationBlockers: {},
		busy: false,
		onSelect: () => {},
		act: async () => {},
		onHistory: () => {},
		onTraffic: () => {},
	};
	it("keeps a semantic escalation visible when structural sequencing was already automatic", () => {
		const controller = scenario();
		controller.setSemantic([
			{
				flights: ["F-021", "F-022"],
				summary: "The intended token lifetimes may contradict each other.",
				confidence: 0.82,
				recommendation: "escalate",
				source: "bounded judge",
			},
		]);
		const state = controller.state;
		const crossing = state.traffic.congestions.find((c) => c.key === "F-021|F-022")!;
		// The controller retains the structural rule while separately requesting semantic review.
		expect(crossing.resolution).toBe("auto");
		expect(counts(state)).toMatchObject({ automatic: 0, attention: 1 });
		expect(decisionLabel(crossing, state)).toBe("Needs a decision");
		const work = renderToStaticMarkup(
			createElement(Work, {
				state,
				busy: false,
				attentionOnly: false,
				onSelect: () => {},
				onAttention: () => {},
				act: async () => {},
			}),
		);
		expect(work).toContain("Decision needed");
		expect(work).not.toContain("Cruce handled it");
		const detail = renderToStaticMarkup(
			createElement(ContextPanel, { ...common, state, selection: { kind: "congestion", key: crossing.key } }),
		);
		expect(detail).toContain("<h1>These tasks need a decision</h1>");
		expect(detail).toContain("The intended token lifetimes may contradict each other.");
		expect(detail).toContain("Source: Semantic check");
		const traffic = renderToStaticMarkup(
			createElement(Traffic, {
				state,
				git: null,
				selection: { kind: "congestion", key: crossing.key },
				onSelect: () => {},
				onOpen: () => {},
			}),
		);
		expect(traffic).toContain("Needs a decision");
		expect(traffic).not.toContain("Handled automatically");
	});

	it("does not misattribute unrelated run attention to an automatic crossing", () => {
		const state = scenario().state;
		state.attention.push({ ...decision, id: "lost:F-023", kind: "flight-lost", flights: ["F-023"] });
		const crossing = state.traffic.congestions.find((c) => c.key === "F-021|F-022")!;
		expect(counts(state).automatic).toBe(1);
		expect(decisionLabel(crossing, state)).toBe("Handled automatically");
	});

	it("describes a hold-both override as held shared changes, not unrestricted continuation", () => {
		const controller = scenario();
		controller.applyOverride("F-021|F-022", "hold-both", "you");
		const markup = renderToStaticMarkup(
			createElement(ContextPanel, { ...common, state: controller.state, selection: { kind: "congestion", key: "F-021|F-022" } }),
		);
		expect(markup).toContain("Shared changes are on hold");
		expect(markup).not.toContain("<h1>Work can continue</h1>");
		expect(markup).toContain("Source: Human override");
	});

	it("renders missing-test-script validation as Skipped with neutral treatment", () => {
		const state = scenario().state;
		state.flights[2].publishes.push({
			at: 1001,
			commit: "abc1234",
			approved: true,
			touched: [],
			outside: [],
			message: "Changes",
			tests: { passed: true, summary: "no test script (validation skipped)" },
		});
		const markup = renderToStaticMarkup(createElement(ContextPanel, { ...common, state, selection: { kind: "flight", id: "F-023" } }));
		expect(markup).toContain('class="validation-result muted"');
		expect(markup).toContain("Skipped</span>");
		expect(markup).not.toContain("Passed</span>");
	});
});
