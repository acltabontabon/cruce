import { describe, expect, it, vi } from "vitest";
import { Controller, clearanceBrief } from "../../src/core/controller.ts";
import type { FlightInstruction } from "../../src/core/domain.ts";
import { JWT_MIGRATION, ROTATION_V1 } from "../../src/demo/scenario.ts";
import { type CoordinationStatus, deliverInstruction, waitForTrafficChange } from "../../src/worker/agents/coordination.ts";
import { freshState } from "../fixtures.ts";

const instruction: FlightInstruction = {
	id: "F-021:reroute:10",
	kind: "reroute",
	resources: ["s:src/auth/token-validator.ts#TokenValidator.validate"],
	requestedAt: 100,
	requestedBy: "developer",
	issuedPlanVersion: 1,
	status: "pending",
};
const status: CoordinationStatus = { phase: "executing", planVersion: 1, clearance: "partial", brief: "Cleared: AuthService", instruction };
const mission = { flightId: "F-021", title: "Rotate tokens", description: "Keep replay protection" };

describe("agent instruction delivery shared by sandbox and external runners", () => {
	it("acknowledges only after the agent receives the request successfully", async () => {
		const calls: string[] = [];
		await expect(
			deliverInstruction(
				status,
				mission,
				async (prompt) => {
					expect(prompt).toContain("TokenValidator.validate");
					expect(prompt).toContain("Preserve all existing working-tree changes");
					expect(prompt).toContain("do not drop task requirements");
					calls.push("agent");
				},
				async (id) => {
					calls.push(id);
				},
			),
		).resolves.toBe(true);
		expect(calls).toEqual(["agent", instruction.id]);
	});

	it("leaves failed delivery pending and does not redeliver acknowledged or terminal requests", async () => {
		const ack = vi.fn();
		await expect(
			deliverInstruction(
				status,
				mission,
				async () => {
					throw new Error("agent unavailable");
				},
				ack,
			),
		).rejects.toThrow("unavailable");
		expect(ack).not.toHaveBeenCalled();
		const run = vi.fn();
		await expect(
			deliverInstruction({ ...status, instruction: { ...instruction, status: "acknowledged" } }, mission, run, ack),
		).resolves.toBe(false);
		await expect(deliverInstruction({ ...status, phase: "cancelled" }, mission, run, ack)).resolves.toBe(false);
		expect(run).not.toHaveBeenCalled();
	});
});

describe("healthy coordination waits", () => {
	it("renews partial-clearance leases through many idle polls without spending execution rounds", async () => {
		let state = freshState();
		let now = 0;
		const mutate = (fn: (c: Controller) => void) => {
			const c = new Controller(state, now);
			fn(c);
			state = c.commit().state;
		};
		mutate((c) => {
			for (const title of ["rotation", "jwt"]) c.createFlight({ missionId: c.createMission({ title }).id, agent: "external" });
			c.submitPlan("F-022", JWT_MIGRATION);
			c.submitPlan("F-021", ROTATION_V1);
		});
		const current = (): CoordinationStatus => ({
			phase: state.flights[0].phase,
			planVersion: 1,
			clearance: state.traffic.clearances["F-021"].status,
			brief: clearanceBrief(state, "F-021"),
		});
		const heartbeats: number[] = [];
		const result = await waitForTrafficChange(current(), {
			heartbeat: async (attempt) => {
				heartbeats.push(attempt);
				mutate((c) => {
					c.heartbeat("F-021");
					c.heartbeat("F-022");
				});
			},
			wait: async (attempt) => {
				now += 60_000;
				mutate((c) => {
					c.tick();
					if (attempt === 20) c.applyOverride("F-021|F-022", "allow-both", "developer");
				});
			},
			status: async () => current(),
		});
		expect(heartbeats).toHaveLength(20);
		expect(result.clearance).toBe("clear");
		expect(state.flights.every((f) => f.phase === "executing")).toBe(true);
		expect(state.leases.some((l) => l.flightId === "F-021")).toBe(true);
	});

	it("returns immediately for pending instructions and wakes on cancellation", async () => {
		const wait = vi.fn();
		expect(await waitForTrafficChange(status, { heartbeat: vi.fn(), wait, status: async () => status })).toBe(status);
		expect(wait).not.toHaveBeenCalled();
		const before = { ...status, instruction: undefined };
		expect(
			(await waitForTrafficChange(before, { heartbeat: vi.fn(), wait, status: async () => ({ ...before, phase: "cancelled" }) })).phase,
		).toBe("cancelled");
	});

	it("returns immediately when the run is already stale at the integration boundary", async () => {
		const before = { ...status, instruction: undefined, stale: { reasons: ["TokenValidator changed during tests"] } };
		const wait = vi.fn();
		expect(await waitForTrafficChange(before, { heartbeat: vi.fn(), wait, status: async () => before })).toBe(before);
		expect(wait).not.toHaveBeenCalled();
	});
});
