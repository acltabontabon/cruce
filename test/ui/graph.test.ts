import { describe, expect, it } from "vitest";
import { Controller } from "../../src/core/controller.ts";
import type { FlightPlanInput } from "../../src/core/domain.ts";
import { JWT_MIGRATION, ROTATION_V1, SESSION_CLEANUP } from "../../src/demo/scenario.ts";
import { buildStructure, layout, signatureOf } from "../../src/ui/radar/graph.ts";
import { freshState } from "../fixtures.ts";

function scenario(plans: FlightPlanInput[] = [ROTATION_V1, JWT_MIGRATION, SESSION_CLEANUP]) {
	const controller = new Controller(freshState(), 1000);
	for (const plan of plans) {
		const mission = controller.createMission({ title: plan.summary });
		const flight = controller.createFlight({ missionId: mission.id, agent: "mock" });
		controller.submitPlan(flight.id, plan);
	}
	return controller;
}

describe("Traffic graph", () => {
	it("starts with active areas and keeps the actual TokenValidator crossing visible", () => {
		const state = scenario().state;
		const graph = buildStructure(state);
		const resource = "s:src/auth/token-validator.ts#TokenValidator.validate";
		const crossing = graph.nodes.find((n) => n.resource === resource);
		expect(crossing?.kind).toBe("symbol");
		expect(crossing?.congestionKeys).toContain("F-021|F-022");
		expect(graph.nodes.find((n) => n.id === crossing?.parent)?.label).toBe("TokenValidator");
		expect(graph.edges.filter((e) => e.target === crossing?.id).map((e) => e.flightId)).toEqual(["F-021", "F-022"]);
		expect(graph.nodes.some((n) => n.label === "SessionService")).toBe(false);
		expect(graph.nodes.filter((n) => n.kind === "flight")).toHaveLength(3);
	});

	it("omits completed, cancelled and failed runs even while an old traffic snapshot references them", () => {
		const state = scenario().state;
		state.flights[0].phase = "landed";
		state.flights[1].phase = "failed";
		state.flights[2].phase = "cancelled";
		const graph = buildStructure(state);
		expect(graph.nodes).toEqual([]);
		expect(graph.edges).toEqual([]);
	});

	it("expands only active files and then their declared symbols", () => {
		const state = scenario([ROTATION_V1]).state;
		const overview = buildStructure(state);
		expect(overview.nodes.every((n) => n.kind === "flight" || n.kind === "module")).toBe(true);
		const modules = new Set(["auth"]);
		const files = buildStructure(state, { expandedModules: modules, expandedFiles: new Set() });
		expect(files.nodes.some((n) => n.label === "AuthService")).toBe(true);
		expect(files.nodes.some((n) => n.kind === "symbol")).toBe(false);
		const symbols = buildStructure(state, { expandedModules: modules, expandedFiles: new Set(["src/auth/auth-service.ts"]) });
		expect(symbols.nodes.some((n) => n.label === "refreshToken()")).toBe(true);
		expect(symbols.nodes.some((n) => n.label === "logout()")).toBe(false);
		expect(signatureOf(files)).not.toBe(signatureOf(symbols));
	});

	it("shows all crossing decisions when three runs share one member", () => {
		const plan: FlightPlanInput = {
			summary: "Update token validation",
			intent: "Update token validation",
			writeSet: [{ type: "symbol", resource: "TokenValidator.validate" }],
		};
		const graph = buildStructure(scenario([plan, plan, plan]).state);
		expect(graph.nodes.find((n) => n.label === "validate()")?.congestionKeys).toEqual(["F-021|F-022", "F-021|F-023", "F-022|F-023"]);
	});

	it("keeps mixed collapsed permissions explicit without marking the whole code area held", () => {
		const state = scenario([ROTATION_V1]).state;
		const clearance = state.traffic.clearances["F-021"];
		const resource = "s:src/auth/token-validator.ts#TokenValidator.validate";
		clearance.status = "partial";
		clearance.held = [{ resource, waitingOn: "controller", congestionKey: "manual", reason: "Waiting for a decision" }];
		clearance.cleared = clearance.cleared.filter((r) => r !== resource);
		const graph = buildStructure(state);
		const edge = graph.edges.find((e) => e.target === "module:auth");
		expect(edge?.state).toBe("partial");
		expect(edge?.label).toBe("Partial · 1 waiting");
		expect(edge?.heldResources).toEqual([resource]);
		expect(edge?.clearedResources).toContain("s:src/auth/auth-service.ts#AuthService.refreshToken");
	});

	it("does not request a new layout for activity or permission-only updates", () => {
		const state = scenario().state;
		const before = signatureOf(buildStructure(state));
		state.flights[0].activity = { text: "Updating independent code", at: 1001 };
		state.traffic.clearances["F-021"].held = [];
		state.traffic.clearances["F-021"].status = "clear";
		expect(signatureOf(buildStructure(state))).toBe(before);
	});

	it("lays out compound module routes and precise crossing routes with finite dimensions", async () => {
		const structure = buildStructure(scenario().state);
		const graph = await layout(structure);
		expect(graph.nodes).toHaveLength(structure.nodes.length);
		for (const node of graph.nodes) {
			expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
			expect(node.width).toBeGreaterThan(0);
			expect(node.height).toBeGreaterThan(0);
		}
		expect(graph.signature).toBe(signatureOf(structure));
	});
});
