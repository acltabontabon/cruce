import { describe, expect, it } from "vitest";
import { Controller } from "../../src/core/controller.ts";
import type { FlightPlanInput } from "../../src/core/domain.ts";
import { JWT_MIGRATION, ROTATION_V1, SESSION_CLEANUP } from "../../src/demo/scenario.ts";
import { freshState } from "../fixtures.ts";

function fly(plans: Record<string, { plan: FlightPlanInput; priority?: "normal" | "critical" }>, order = Object.keys(plans)) {
	const c = new Controller(freshState(), 1000);
	const ids: Record<string, string> = {};
	for (const name of Object.keys(plans)) {
		const m = c.createMission({ title: name, priority: plans[name].priority });
		ids[name] = c.createFlight({ missionId: m.id, agent: "mock" }).id;
	}
	let t = 1;
	for (const name of order) {
		(c as unknown as { now: number }).now = 1000 + t++;
		c.submitPlan(ids[name], plans[name].plan);
	}
	return { c, ids, traffic: c.state.traffic };
}

describe("clearance engine", () => {
	it("clears independent Flights automatically", () => {
		const { traffic, ids } = fly({ sessions: { plan: SESSION_CLEANUP }, jwt: { plan: JWT_MIGRATION } });
		expect(traffic.congestions).toEqual([]);
		expect(traffic.clearances[ids.sessions].status).toBe("clear");
		expect(traffic.clearances[ids.jwt].status).toBe("clear");
	});

	it("gives the contract owner right-of-way and the other Flight PARTIAL clearance", () => {
		const { traffic, ids } = fly({ rotation: { plan: ROTATION_V1 }, jwt: { plan: JWT_MIGRATION }, sessions: { plan: SESSION_CLEANUP } });
		const rotation = traffic.clearances[ids.rotation];
		expect(traffic.clearances[ids.sessions].status).toBe("clear");
		expect(traffic.clearances[ids.jwt].status).toBe("clear");
		expect(rotation.status).toBe("partial");
		expect(rotation.cleared).toEqual([
			"f:src/persistence/refresh-token-repository.ts",
			"s:src/auth/auth-service.ts#AuthService.refreshToken",
		]);
		expect(rotation.held.map((h) => h.resource)).toEqual(["s:src/auth/token-validator.ts#TokenValidator.validate"]);
		expect(rotation.held[0].waitingOn).toBe(ids.jwt);

		const congestion = traffic.congestions.find((x) => x.flights.includes(ids.rotation) && x.flights.includes(ids.jwt));
		expect(congestion?.rightOfWay).toMatchObject({ winner: ids.jwt, loser: ids.rotation, rule: "contract-owner" });
		expect(congestion?.why).toContain("Both intend to modify TokenValidator.validate().");
		expect(congestion?.why.some((w) => w.includes("assumes"))).toBe(true);
		expect(congestion?.plan[0]).toContain(`${ids.jwt} receives full clearance`);
		expect(congestion?.level).toBe(1);
		expect(congestion?.severity).toBe("critical");
	});

	it("notes distinct symbols in one file as separate airspace", () => {
		const { traffic, ids } = fly({ rotation: { plan: ROTATION_V1 }, jwt: { plan: JWT_MIGRATION } });
		expect(traffic.clearances[ids.rotation].cautions.join()).toContain("AuthService.refreshToken");
	});

	it("priority beats contract ownership", () => {
		const { traffic, ids } = fly({ rotation: { plan: ROTATION_V1, priority: "critical" }, jwt: { plan: JWT_MIGRATION } });
		expect(traffic.clearances[ids.rotation].status).toBe("clear");
		expect(traffic.clearances[ids.jwt].status).toBe("partial");
	});

	it("holds a Flight entirely when every write is contested", () => {
		const onlyValidate: FlightPlanInput = { ...ROTATION_V1, writeSet: [{ type: "symbol", resource: "TokenValidator.validate" }] };
		const { traffic, ids } = fly({ a: { plan: onlyValidate }, jwt: { plan: JWT_MIGRATION } });
		expect(traffic.clearances[ids.a].status).toBe("hold");
	});

	it("contract change under a declared read: both fly, reader lands after", () => {
		const reader: FlightPlanInput = {
			summary: "Audit tokens",
			intent: "read-only use of validate",
			readSet: [{ type: "symbol", resource: "TokenValidator.validate" }],
			writeSet: [{ type: "component", resource: "AuditLog" }],
		};
		const { traffic, ids } = fly({ reader: { plan: reader }, jwt: { plan: JWT_MIGRATION } });
		expect(traffic.clearances[ids.reader].status).toBe("clear");
		expect(traffic.clearances[ids.reader].landAfter).toEqual([{ flightId: ids.jwt, reason: expect.any(String) }]);
		expect(traffic.landingOrder?.indexOf(ids.jwt)).toBeLessThan(traffic.landingOrder?.indexOf(ids.reader) ?? -1);
	});

	it("detects and breaks a deadlock in declared dependencies", () => {
		const a: FlightPlanInput = {
			summary: "a",
			intent: "a",
			writeSet: [{ type: "component", resource: "AuditLog" }],
			dependencies: ["F-022"],
		};
		const b: FlightPlanInput = {
			summary: "b",
			intent: "b",
			writeSet: [{ type: "component", resource: "SessionService" }],
			dependencies: ["F-021"],
		};
		const { traffic } = fly({ a: { plan: a }, b: { plan: b } });
		expect(traffic.deadlocks).toEqual([["F-021", "F-022"]]);
		expect(traffic.attention.some((x) => x.kind === "deadlock")).toBe(true);
	});

	it("a contested-write cycle is broken by giving one Flight right-of-way", () => {
		// A writes X, contract on Y; B writes Y, contract on X → each changes the other's contract.
		const a: FlightPlanInput = {
			summary: "a",
			intent: "a",
			writeSet: [{ type: "symbol", resource: "SessionService.start" }],
			contractSet: [{ resource: "SessionRepository.save", change: "signature" }],
		};
		const b: FlightPlanInput = {
			summary: "b",
			intent: "b",
			writeSet: [{ type: "symbol", resource: "SessionRepository.save" }],
			contractSet: [{ resource: "SessionService.start", change: "signature" }],
		};
		const { traffic, ids } = fly({ a: { plan: a }, b: { plan: b } });
		const statuses = [traffic.clearances[ids.a].status, traffic.clearances[ids.b].status].sort();
		expect(statuses).toEqual(["clear", "hold"]);
		expect(traffic.deadlocks).toEqual([]);
	});
});
