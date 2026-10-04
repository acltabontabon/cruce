import { describe, expect, it } from "vitest";
import { Controller, clearanceBrief } from "../../src/core/controller.ts";
import { changedRanges } from "../../src/core/line-diff.ts";
import type { ChangedFile } from "../../src/core/publish-gate.ts";
import { JWT_MIGRATION, overlayFiles, ROTATION_AMENDMENT, ROTATION_V1, ROTATION_V2, SESSION_CLEANUP } from "../../src/demo/scenario.ts";
import { buildIndex } from "../../src/intelligence/structural-index.ts";
import { freshState, indexAfter, mergedAfter, seed } from "../fixtures.ts";

/** The diff a scripted Flight step produces against a base file set. */
function diff(base: Record<string, string>, overlay: string): ChangedFile[] {
	return Object.entries(overlayFiles(overlay)).flatMap(([path, next]): ChangedFile[] => {
		const before = base[path];
		if (before === undefined) return [{ path, status: "added", ranges: [] }];
		if (before === next) return [];
		return [{ path, status: "modified", ranges: changedRanges(before, next) }];
	});
}

function setup() {
	let now = 1000;
	let state = freshState();
	const step = <T>(fn: (c: Controller) => T): T => {
		now += 1000;
		const c = new Controller(state, now);
		const out = fn(c);
		state = c.commit().state;
		return out;
	};
	const ids = step((c) =>
		[ROTATION_V1, JWT_MIGRATION, SESSION_CLEANUP].map((_, i) => {
			const m = c.createMission({ title: ["Refresh-token rotation", "JWT library migration", "Session cleanup"][i] });
			return c.createFlight({ missionId: m.id, agent: "mock" }).id;
		}),
	);
	return {
		step,
		ids,
		get state() {
			return state;
		},
	};
}

describe("controller lifecycle (the demo story)", () => {
	it("flies F-021, F-022 and F-023 from plans to landing", () => {
		const t = setup();
		const [F021, F022, F023] = t.ids;
		expect([F021, F022, F023]).toEqual(["F-021", "F-022", "F-023"]);

		t.step((c) => c.submitPlan(F023, SESSION_CLEANUP));
		t.step((c) => c.submitPlan(F022, JWT_MIGRATION));
		const first = t.step((c) => c.submitPlan(F021, ROTATION_V1));
		expect(first.clearance.status).toBe("partial");
		expect(t.state.traffic.clearances[F023].status).toBe("clear");
		expect(t.state.traffic.clearances[F022].status).toBe("clear");
		expect(t.state.flights.find((f) => f.id === F021)?.phase).toBe("executing");

		// Publish gate: logout is outside the cleared route → rejected, amendment requested.
		const rejected = t.step((c) => c.requestPublish(F021, "c1", diff(seed, "f021-rotation-1"), "step 1"));
		expect(rejected.approved).toBe(false);
		expect(rejected.outside.map((o) => o.resource)).toEqual(["s:src/auth/auth-service.ts#AuthService.logout"]);

		const amended = t.step((c) => c.requestAirspace(F021, ROTATION_AMENDMENT, "logout must revoke the family"));
		expect(amended.plan.planVersion).toBe(2);
		expect(amended.clearance.status).toBe("partial");
		expect(amended.clearance.cleared).toContain("s:src/auth/auth-service.ts#AuthService.logout");

		const accepted = t.step((c) => c.requestPublish(F021, "c1", diff(seed, "f021-rotation-1"), "step 1"));
		expect(accepted.approved).toBe(true);
		t.step((c) => c.recordPush(F021, "c1", "gate"));
		t.step((c) => c.recordValidation(F021, "c1", true, "12 passed"));
		expect(t.step((c) => c.landingBlockers(F021))).toEqual(["holding TokenValidator.validate"]);

		// F-022 publishes and lands first.
		expect(t.step((c) => c.requestPublish(F022, "c2", diff(seed, "f022-jwt-migration"), "migrate")).approved).toBe(true);
		t.step((c) => c.recordValidation(F022, "c2", true, "11 passed"));
		expect(t.step((c) => c.landingBlockers(F022))).toEqual([]);
		t.step((c) => c.land(F022, "m1", indexAfter("f022-jwt-migration").index, "Land F-022"));

		const f021 = t.state.flights.find((f) => f.id === F021);
		expect(f021?.stale?.byFlight).toBe(F022);
		expect(f021?.stale?.reasons.join(" ")).toContain("TokenValidator.validate contract changed");
		expect(f021?.stale?.reasons.join(" ")).toContain("assumption no longer holds");
		expect(t.state.traffic.clearances[F021].held.map((h) => h.waitingOn)).toEqual(["replan"]);
		expect(t.state.canonical.head).toBe("m1");

		// A stale Flight cannot publish until it re-plans.
		expect(t.step((c) => c.requestPublish(F021, "c3", [], "x")).reasons[0]).toContain("amend the Flight Plan");

		// F-023 lands independently; it does not affect F-021.
		expect(t.step((c) => c.requestPublish(F023, "c4", diff(seed, "f023-session-cleanup"), "cleanup")).approved).toBe(true);
		t.step((c) => c.recordValidation(F023, "c4", true, "11 passed"));
		t.step((c) => c.land(F023, "m2", indexAfter("f022-jwt-migration", "f023-session-cleanup").index, "Land F-023"));
		expect(t.state.flights.find((f) => f.id === F021)?.stale?.byFlight).toBe(F022);

		// F-021 refreshes onto the new baseline and files plan v3: TokenValidator becomes a read.
		t.step((c) => c.refreshBaseline(F021, "r1", "merged canonical"));
		const replanned = t.step((c) => c.submitPlan(F021, ROTATION_V2));
		expect(replanned.plan.planVersion).toBe(3);
		expect(replanned.clearance.status).toBe("clear");
		expect(replanned.plan.amendment?.removed).toContain("write TokenValidator.validate");
		expect(replanned.plan.amendment?.added).toContain("read TokenValidator.validate");

		const merged = mergedAfter("f022-jwt-migration", "f023-session-cleanup", "f021-rotation-1");
		const step2 = diff(merged.files, "f021-rotation-2");
		const publish2 = t.step((c) => c.requestPublish(F021, "c5", step2, "rotate", buildIndex(merged.files, "r1")));
		expect(publish2.outside).toEqual([]);
		expect(publish2.approved).toBe(true);
		expect(publish2.touched).toContain("s:src/auth/auth-service.ts#AuthService.refreshToken");
		t.step((c) => c.recordValidation(F021, "c5", true, "15 passed"));
		t.step((c) => c.land(F021, "m3", undefined, "Land F-021"));

		expect(t.state.flights.map((f) => f.phase)).toEqual(["landed", "landed", "landed"]);
		expect(t.state.canonical.history.map((h) => h.flightId)).toEqual([undefined, F022, F023, F021]);
		expect(t.state.leases).toEqual([]);
		const types = t.state.log.map((e) => e.type);
		for (const type of ["congestion.detected", "clearance", "publish.rejected", "plan.amended", "flight.stale", "flight.landed"]) {
			expect(types).toContain(type);
		}
	});

	it("an unauthorized new file is rejected by the publish gate", () => {
		const t = setup();
		t.step((c) => c.submitPlan("F-023", SESSION_CLEANUP));
		const r = t.step((c) => c.requestPublish("F-023", "x", [{ path: "src/auth/backdoor.ts", status: "added", ranges: [] }], "x"));
		expect(r.approved).toBe(false);
		expect(r.outside[0].reason).toContain("Authentication");
	});

	it("repeated violations escalate to a human", () => {
		const t = setup();
		t.step((c) => c.submitPlan("F-023", SESSION_CLEANUP));
		for (let i = 0; i < 3; i++)
			t.step((c) => c.requestPublish("F-023", `x${i}`, [{ path: "src/auth/x.ts", status: "added", ranges: [] }], "x"));
		expect(t.state.attention.map((a) => a.kind)).toContain("violation");
	});
});

describe("human overrides", () => {
	const flying = () => {
		const t = setup();
		t.step((c) => c.submitPlan("F-022", JWT_MIGRATION));
		t.step((c) => c.submitPlan("F-021", ROTATION_V1));
		return t;
	};

	it("persists reroute delivery without changing clearance or pretending the plan changed", () => {
		const t = flying();
		const before = t.state.traffic.clearances["F-021"];
		const instruction = t.step((c) => c.requestReroute("F-021", "developer"));
		expect(instruction.status).toBe("pending");
		expect(instruction.resources).toEqual(before.held.map((h) => h.resource));
		expect(t.step((c) => c.requestReroute("F-021", "developer")).id).toBe(instruction.id);
		expect(t.state.log.filter((e) => e.type === "agent.instruction")).toHaveLength(1);
		expect(clearanceBrief(t.state, "F-021")).toContain(`Pending reroute request ${instruction.id}`);
		const restored = new Controller(JSON.parse(JSON.stringify(t.state)), 20_000);
		expect(restored.flight("F-021").instruction?.id).toBe(instruction.id);
		expect(() => restored.ackInstruction("F-021", "wrong-id")).toThrow("Unknown instruction");
		restored.ackInstruction("F-021", instruction.id);
		restored.ackInstruction("F-021", instruction.id);
		const result = restored.commit();
		expect(result.events).toHaveLength(1);
		expect(result.state.flights.find((f) => f.id === "F-021")?.instruction?.status).toBe("acknowledged");
		expect(result.state.traffic.clearances["F-021"]).toEqual(before);
		expect(result.state.flights.find((f) => f.id === "F-021")?.plan?.planVersion).toBe(1);
		expect(clearanceBrief(result.state, "F-021")).not.toContain("Pending reroute");
		expect(clearanceBrief(result.state, "F-021")).toContain(
			`Acknowledged reroute request ${instruction.id} (issued for plan v1; current plan v1)`,
		);
		expect(clearanceBrief(result.state, "F-021")).toContain("This confirms receipt only");
		const next = new Controller(result.state, 21_000);
		expect(next.requestReroute("F-021", "developer").id).not.toBe(instruction.id);
		expect(() => next.ackInstruction("F-021", instruction.id)).toThrow("Unknown instruction");
	});

	it("rejects rerouting a finished run or a run with no waiting scope", () => {
		const t = flying();
		expect(() => t.step((c) => c.requestReroute("F-022", "developer"))).toThrow("no waiting scope");
		t.step((c) => c.cancel("F-021", "developer"));
		expect(() => t.step((c) => c.requestReroute("F-021", "developer"))).toThrow("cancelled");
	});

	it("ALLOW BOTH clears both Flights", () => {
		const t = flying();
		t.step((c) => c.applyOverride("F-021|F-022", "allow-both", "dev"));
		expect(t.state.traffic.clearances["F-021"].status).toBe("clear");
		expect(t.state.traffic.clearances["F-022"].status).toBe("clear");
		expect(t.state.traffic.congestions[0].resolution).toBe("override");
	});

	it("F-021 FIRST flips right-of-way; F-022 yields", () => {
		const t = flying();
		t.step((c) => c.applyOverride("F-021|F-022", "first", "dev", "F-021"));
		expect(t.state.traffic.clearances["F-021"].status).toBe("clear");
		expect(t.state.traffic.clearances["F-022"].status).toBe("partial");
		expect(t.state.log.some((e) => e.type === "lease.yielded" && e.flightId === "F-022")).toBe(true);
	});

	it("HOLD BOTH holds the contested airspace on both sides; undo restores automatic coordination", () => {
		const t = flying();
		t.step((c) => c.applyOverride("F-021|F-022", "hold-both", "dev"));
		expect(t.state.traffic.clearances["F-022"].held.length).toBeGreaterThan(0);
		expect(t.state.traffic.clearances["F-021"].held.length).toBeGreaterThan(0);
		t.step((c) => c.clearOverride("F-021|F-022", "dev"));
		expect(t.state.traffic.clearances["F-022"].status).toBe("clear");
	});
});

describe("validation evidence", () => {
	it("requires passing validation of the latest approved commit", () => {
		const t = setup();
		const id = "F-023";
		t.step((c) => c.submitPlan(id, SESSION_CLEANUP));
		t.step((c) => c.requestPublish(id, "first", diff(seed, "f023-session-cleanup"), "cleanup"));
		expect(t.step((c) => c.landingBlockers(id))).toContain("validation not reported");
		expect(() => t.step((c) => c.land(id, "merge", undefined, "integration"))).toThrow("validation not reported");
		expect(() => t.step((c) => c.recordValidation(id, "unknown", true, "passed"))).toThrow("no approved publish");
		expect(t.state.flights.find((f) => f.id === id)?.publishes[0].tests).toBeUndefined();
		t.step((c) => c.recordValidation(id, "first", false, "failed"));
		expect(t.step((c) => c.landingBlockers(id))).toContain("validation failed");
		t.step((c) => c.recordValidation(id, "first", true, "rerun passed"));
		expect(t.step((c) => c.landingBlockers(id))).toEqual([]);
		t.step((c) => c.requestPublish(id, "second", diff(seed, "f023-session-cleanup"), "updated cleanup"));
		t.step((c) => c.recordValidation(id, "first", true, "old commit still passes"));
		expect(t.step((c) => c.landingBlockers(id))).toContain("validation not reported");
		t.step((c) => c.requestPublish(id, "rejected", [{ path: "src/auth/backdoor.ts", status: "added", ranges: [] }], "outside scope"));
		expect(() => t.step((c) => c.recordValidation(id, "rejected", true, "passed"))).toThrow("no approved publish");
		t.step((c) => c.recordValidation(id, "second", true, "passed"));
		expect(t.step((c) => c.landingBlockers(id))).toEqual([]);
	});
});

describe("failure handling", () => {
	it("expires a silent fully held run with no leases, including a restored snapshot without a heartbeat", () => {
		let c = new Controller(freshState(), 0);
		for (const title of ["first", "waiting"]) {
			const f = c.createFlight({ missionId: c.createMission({ title }).id, agent: "external" });
			c.submitPlan(f.id, SESSION_CLEANUP);
		}
		let state = c.commit().state;
		expect(state.traffic.clearances["F-022"].status).toBe("hold");
		expect(state.leases.some((l) => l.flightId === "F-022")).toBe(false);
		expect(state.flights[1].lastHeartbeat).toBeUndefined();
		c = new Controller(JSON.parse(JSON.stringify(state)), 10 * 60_000);
		c.heartbeat("F-021");
		c.tick();
		state = c.commit().state;
		expect(state.flights[1].phase).toBe("lost");
		expect(state.flights[0].phase).toBe("executing");
		expect(state.attention.some((a) => a.kind === "flight-lost" && a.flights.includes("F-022"))).toBe(true);
	});

	it("keeps a held run alive using its persisted heartbeat rather than old plan-filing time", () => {
		let c = new Controller(freshState(), 0);
		for (const title of ["first", "waiting"]) {
			const f = c.createFlight({ missionId: c.createMission({ title }).id, agent: "external" });
			c.submitPlan(f.id, SESSION_CLEANUP);
		}
		c = new Controller(c.commit().state, 9 * 60_000);
		c.heartbeat("F-021");
		c.heartbeat("F-022");
		c = new Controller(JSON.parse(JSON.stringify(c.commit().state)), 18 * 60_000);
		c.tick();
		const state = c.commit().state;
		expect(state.flights[1].phase).toBe("planned");
		expect(state.traffic.clearances["F-022"].status).toBe("hold");
		expect(state.attention).toEqual([]);
	});

	it("a crashed agent loses its leases and dependents are re-evaluated", () => {
		let state = freshState();
		const run = (at: number, fn: (c: Controller) => void) => {
			const c = new Controller(state, at);
			fn(c);
			state = c.commit().state;
		};
		run(0, (c) => {
			for (const t of ["rotation", "jwt"]) c.createFlight({ missionId: c.createMission({ title: t }).id, agent: "mock" });
			c.submitPlan("F-022", JWT_MIGRATION);
			c.submitPlan("F-021", ROTATION_V1);
			c.heartbeat("F-021");
		});
		expect(state.traffic.clearances["F-021"].status).toBe("partial");
		// F-021 keeps heartbeating; F-022 goes silent past its lease TTL.
		run(9 * 60_000, (c) => c.heartbeat("F-021"));
		run(11 * 60_000, (c) => c.tick());
		expect(state.flights.find((f) => f.id === "F-022")?.phase).toBe("lost");
		expect(state.leases.every((l) => l.flightId === "F-021")).toBe(true);
		expect(state.traffic.clearances["F-021"].status).toBe("clear");
	});

	it("a plan timeout fails the Flight without executing code", () => {
		let state = freshState();
		let c = new Controller(state, 0);
		const f = c.createFlight({ missionId: c.createMission({ title: "slow" }).id, agent: "mock" });
		c.setPhase(f.id, "discovery");
		state = c.commit().state;
		c = new Controller(state, 31 * 60_000);
		c.tick();
		state = c.commit().state;
		expect(state.flights[0].phase).toBe("failed");
		expect(state.attention.map((a) => a.kind)).toContain("plan-timeout");
	});

	it("rejects malformed Flight Plans", () => {
		const c = new Controller(freshState(), 0);
		const f = c.createFlight({ missionId: c.createMission({ title: "x" }).id, agent: "mock" });
		expect(() => c.submitPlan(f.id, { summary: "" })).toThrow(/Invalid flight plan/);
	});
});

describe("publish gate: declared new members", () => {
	it("an insertion that adds a member declared in the plan is inside clearance", async () => {
		const { evaluatePublish } = await import("../../src/core/publish-gate.ts");
		const { changedRanges } = await import("../../src/core/line-diff.ts");
		const path = "src/sessions/session-service.ts";
		const before = seed[path];
		const after = before.replace(
			"\tend(id: string): boolean {",
			"\tendIdle(maxIdleMs: number): number {\n\t\treturn maxIdleMs;\n\t}\n\n\tend(id: string): boolean {",
		);
		const changes = [{ path, status: "modified" as const, ranges: changedRanges(before, after) }];
		const { baseIndex } = await import("../fixtures.ts");
		const cleared = [`s:${path}#SessionService.endIdle`];
		expect(evaluatePublish(cleared, changes, baseIndex).approved).toBe(true);
		// Editing an existing member that was not declared is still outside clearance.
		const edit = before.replace("return session;", "return { ...session };");
		const edits = [{ path, status: "modified" as const, ranges: changedRanges(before, edit) }];
		expect(evaluatePublish(cleared, edits, baseIndex).approved).toBe(false);
	});
});
