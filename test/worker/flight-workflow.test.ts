import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { FlightInstruction } from "../../src/core/domain.ts";
import { FlightWorkflow } from "../../src/worker/agents/flight-workflow.ts";

vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown,
		) {}
	},
}));

function harness(
	mode:
		| "held"
		| "reroute"
		| "cancel"
		| "late-reroute"
		| "stale-during-tests"
		| "missing-amendment"
		| "gate-exhausted"
		| "repeated-replans"
		| "missing-tests",
) {
	const calls: string[] = [];
	const validations: { passed?: boolean; summary?: string }[] = [];
	const instruction: FlightInstruction = {
		id: "F-031:reroute:11",
		kind: "reroute",
		resources: ["TokenValidator"],
		requestedAt: 1,
		requestedBy: "developer",
		issuedPlanVersion: 1,
		status: "pending",
	};
	const current = {
		phase: "executing",
		terminal: false,
		planVersion: 1,
		clearance: "hold",
		cleared: 0,
		held: 1,
		stale: null as { reasons: string[] } | null,
		published: false,
		publishedPlanVersion: 0,
		instruction: mode === "reroute" ? instruction : (null as FlightInstruction | null),
	};
	if (mode !== "held" && mode !== "reroute") Object.assign(current, { clearance: "clear", cleared: 1, held: 0 });
	if (mode === "missing-amendment" || mode === "repeated-replans") current.stale = { reasons: ["Baseline changed"] };
	if (mode === "gate-exhausted") Object.assign(current, { published: true, publishedPlanVersion: 1 });
	let waits = 0;
	let execution = 0;
	const tower = {
		liveProvision: async () => ({ namespace: "local", repo: "x", remote: "local://x", baseCommit: "base" }),
		liveMission: async () => ({ flightId: "F-031", title: "Token task", description: "Keep all task requirements" }),
		liveStatus: async () => ({ ...structuredClone(current), brief: `${current.clearance}, plan ${current.planVersion}` }),
		liveActivity: async () => undefined,
		liveRefresh: async () => {
			calls.push("refresh");
			return { head: "refreshed" };
		},
		protocol: async (
			_project: string,
			_flight: string,
			request: { op: string; instructionId?: string; passed?: boolean; summary?: string },
		) => {
			calls.push(request.op);
			if (request.op === "validate") validations.push(request);
			if (request.op === "ack-instruction" && current.instruction) {
				expect(request.instructionId).toBe(current.instruction.id);
				current.instruction.status = "acknowledged";
			}
			if (request.op === "publish") {
				if (mode === "gate-exhausted")
					return { approved: false, commit: "rejected", outside: [{ resource: "TokenValidator", reason: "outside clearance" }] };
				current.published = true;
				current.publishedPlanVersion = current.planVersion;
				return { approved: true, commit: "published", outside: [] };
			}
			if (request.op === "land") return { landed: !current.stale, reason: current.stale ? "stale baseline" : undefined };
			return { ok: true };
		},
	};
	const sandbox = {
		prepare: async () => ({ head: "base" }),
		startTask: async (prompt: string, label: string) => {
			calls.push(label);
			if (label.includes("reroute")) {
				expect(prompt).toContain("Do not implement changes during this step");
				Object.assign(current, { clearance: "clear", cleared: 1, held: 0, planVersion: 2 });
			}
			if (label.startsWith("execute")) {
				execution++;
				if (mode === "cancel") Object.assign(current, { terminal: true, phase: "cancelled" });
				if (mode === "late-reroute" && execution === 1) current.instruction = instruction;
			}
			if (label.startsWith("replan") && mode !== "missing-amendment") {
				current.planVersion++;
				current.stale = mode === "repeated-replans" ? { reasons: ["Another baseline change"] } : null;
			}
			return "started";
		},
		changes: async () => ({ "src/token.ts": "updated" }),
		syncTo: async () => ({ head: "published" }),
		runTests: async () => {
			if (mode === "stale-during-tests" && current.planVersion === 1) current.stale = { reasons: ["Baseline changed during tests"] };
			if (mode === "missing-tests") return { passed: false, summary: "Missing test script: validation could not run" };
			return { passed: true, summary: "1 passed" };
		},
		destroy: async () => {
			calls.push("destroy");
		},
	};
	const steps = {
		do: async (_label: string, _config: unknown, action: () => Promise<unknown>) => action(),
		waitForEvent: async (_label: string, config: { type: string; timeout: string }) => {
			expect(config.type).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/);
			if (config.type.startsWith("agent-")) return { payload: { status: { state: "succeeded", result: "done" } } };
			expect(config.timeout).toBe("1 minute");
			waits++;
			if (waits === 20) Object.assign(current, { clearance: "clear", cleared: 1, held: 0 });
			throw new Error("event timeout");
		},
	};
	const workflow = new FlightWorkflow(
		{} as ExecutionContext,
		{
			CONTROL_TOWER: { getByName: () => tower },
			FLIGHT_SANDBOX: { getByName: () => sandbox },
		} as never,
	);
	return {
		calls,
		validations,
		current,
		run: () =>
			workflow.run(
				{ payload: { projectId: "live", flightId: "F-031" } } as WorkflowEvent<{ projectId: string; flightId: string }>,
				steps as unknown as WorkflowStep,
			),
	};
}

describe("live workflow coordination boundaries", () => {
	it("records missing-test validation as failure and never requests integration", async () => {
		const h = harness("missing-tests");
		await expect(h.run()).rejects.toThrow("Validation failed: Missing test script: validation could not run");
		expect(h.validations).toEqual([expect.objectContaining({ passed: false, summary: "Missing test script: validation could not run" })]);
		expect(h.calls).toContain("fail");
		expect(h.calls).not.toContain("land");
		expect(h.calls.at(-1)).toBe("destroy");
	});

	it("can wait beyond the execution-round limit while heartbeating, then work once", async () => {
		const h = harness("held");
		expect(await h.run()).toEqual({ phase: "landed" });
		expect(h.calls.filter((c) => c === "heartbeat")).toHaveLength(20);
		expect(h.calls.filter((c) => c.startsWith("execute"))).toHaveLength(1);
		expect(h.calls).not.toContain("fail");
	});

	it.each(["reroute", "late-reroute"] as const)("delivers %s before publishing and acknowledges it", async (mode) => {
		const h = harness(mode);
		expect(await h.run()).toEqual({ phase: "landed" });
		expect(h.current.instruction?.status).toBe("acknowledged");
		expect(h.calls.indexOf("ack-instruction")).toBeLessThan(h.calls.indexOf("publish"));
		expect(h.calls).not.toContain("heartbeat");
	});

	it("does not publish after cancellation during agent execution", async () => {
		const h = harness("cancel");
		expect(await h.run()).toEqual({ phase: "cancelled" });
		expect(h.calls).not.toContain("publish");
		expect(h.calls.at(-1)).toBe("destroy");
	});

	it("replans instead of idling when the baseline changed during tests", async () => {
		const h = harness("stale-during-tests");
		expect(await h.run()).toEqual({ phase: "landed" });
		expect(h.calls).toContain("refresh");
		expect(h.current.planVersion).toBe(2);
		expect(h.calls).not.toContain("heartbeat");
	});

	it("fails once a replan task returns without an amended plan", async () => {
		const h = harness("missing-amendment");
		await expect(h.run()).rejects.toThrow("did not file an amended plan");
		expect(h.calls.filter((c) => c.startsWith("replan"))).toHaveLength(1);
		expect(h.calls).toContain("fail");
		expect(h.calls).not.toContain("land");
	});

	it("counts actual replanning work against the work budget", async () => {
		const h = harness("repeated-replans");
		await expect(h.run()).rejects.toThrow("did not land within 8 rounds");
		expect(h.calls.filter((c) => c.startsWith("replan"))).toHaveLength(8);
		expect(h.calls).toContain("fail");
	});

	it("does not integrate an older approved commit after the publish gate exhausts retries", async () => {
		const h = harness("gate-exhausted");
		await expect(h.run()).rejects.toThrow("Publish gate rejected changes after 3 attempts");
		expect(h.calls.filter((c) => c === "publish")).toHaveLength(3);
		expect(h.calls.filter((c) => c.startsWith("correct"))).toHaveLength(2);
		expect(h.calls).not.toContain("land");
		expect(h.calls).not.toContain("heartbeat");
		expect(h.calls).toContain("fail");
	});
});
