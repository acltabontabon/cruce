import { describe, expect, it } from "vitest";
import { Controller } from "../../src/core/controller.ts";
import type { FlightPlanInput } from "../../src/core/domain.ts";
import { candidatePairs, RuleBasedDecisionJudge } from "../../src/intelligence/judge.ts";
import { freshState } from "../fixtures.ts";

function flights(plans: FlightPlanInput[]) {
	const c = new Controller(freshState(), 0);
	for (const p of plans) {
		const f = c.createFlight({ missionId: c.createMission({ title: p.summary }).id, agent: "mock" });
		c.submitPlan(f.id, p);
	}
	return c.state;
}

describe("bounded judgment (level 4)", () => {
	it("escalates opposite moves of the same concept", async () => {
		const s = flights([
			{
				summary: "a",
				intent: "Move token validation into AuthMiddleware so routes are checked once",
				writeSet: [{ type: "symbol", resource: "AuthMiddleware.requireAuth" }],
			},
			{
				summary: "b",
				intent: "Centralize token validation in AuthService and simplify the middleware",
				writeSet: [{ type: "symbol", resource: "AuthService.introspect" }],
			},
		]);
		const findings = await new RuleBasedDecisionJudge().judge(candidatePairs(s.flights, s.index));
		expect(findings).toHaveLength(1);
		expect(findings[0].recommendation).toBe("escalate");
	});

	it("stays quiet for unrelated intents and for different modules", async () => {
		const s = flights([
			{ summary: "a", intent: "Rotate refresh tokens on use", writeSet: [{ type: "symbol", resource: "AuthService.refreshToken" }] },
			{ summary: "b", intent: "End idle sessions", writeSet: [{ type: "component", resource: "SessionService" }] },
		]);
		expect(candidatePairs(s.flights, s.index)).toEqual([]);
		expect(await new RuleBasedDecisionJudge().judge(candidatePairs(s.flights, s.index))).toEqual([]);
	});

	it("findings reach the traffic picture as level-4 congestion and attention, never as holds", async () => {
		const s = flights([
			{
				summary: "a",
				intent: "Move token validation into AuthMiddleware",
				writeSet: [{ type: "symbol", resource: "AuthMiddleware.requireAuth" }],
			},
			{
				summary: "b",
				intent: "Centralize token validation in AuthService",
				writeSet: [{ type: "symbol", resource: "AuthService.introspect" }],
			},
		]);
		const findings = await new RuleBasedDecisionJudge().judge(candidatePairs(s.flights, s.index));
		const c = new Controller(s, 1);
		c.setSemantic(findings);
		const t = c.state.traffic;
		expect(t.congestions.some((x) => x.level === 4)).toBe(true);
		expect(t.attention.some((a) => a.kind === "semantic")).toBe(true);
		expect(Object.values(t.clearances).every((x) => x.status === "clear")).toBe(true);
	});
});
