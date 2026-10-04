import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../../src/core/domain.ts";
import { overlayFiles, SESSION_CLEANUP } from "../../src/demo/scenario.ts";
import { ProtocolRequest } from "../../src/shared/api.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { ProjectGit } from "../../src/worker/project-git.ts";
import { handleProtocol } from "../../src/worker/protocol.ts";
import { Tower } from "../../src/worker/tower.ts";

const project: ProjectInfo = {
	id: "live",
	name: "x",
	repo: "auth-service",
	namespace: "local",
	defaultBranch: "main",
	mode: "live",
	gitBackend: "simulated",
};

async function setup() {
	const kv = new Map<string, unknown>();
	const tower = new Tower(
		project,
		new ProjectGit(new GitWorkspace(new MemoryFs() as never), "auth-service"),
		{
			get: (k) => structuredClone(kv.get(k)) as never,
			put: (k, v) => kv.set(k, structuredClone(v)),
			delete: (k) => kv.delete(k),
			appendEvents: () => {},
		},
		{ onChange: () => {} },
		() => Date.now(),
		31,
	);
	await tower.bootstrap();
	const id = tower.mutate((c) => c.createFlight({ missionId: c.createMission({ title: "Session cleanup" }).id, agent: "external" }).id);
	await tower.provision(id);
	const call = (body: unknown) => handleProtocol(tower, id, ProtocolRequest.parse(body)) as Promise<Record<string, unknown>>;
	return { tower, id, call };
}

describe("agent protocol", () => {
	it("does not revive a Flight when provisioning finishes after cancellation", async () => {
		const { tower, id } = await setup();
		const artifact = tower.flight(id).artifact!;
		let finish!: () => void;
		vi.spyOn(tower.git, "createFlightWorkspace").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve(artifact);
				}),
		);
		const provisioning = tower.provision(id);
		tower.mutate((c) => c.cancel(id, "you"));
		await tower.closeFlight(id);
		finish();
		await expect(provisioning).rejects.toThrow("closed during provisioning");
		expect(tower.flight(id).phase).toBe("cancelled");
		expect(tower.cleanup.records()[0].provisionUntil).toBeUndefined();
	});
	it("rejects terminal checkout, refresh, heartbeat, and activity while preserving status", async () => {
		const { tower, id, call } = await setup();
		tower.mutate((c) => c.cancel(id, "you"));
		await tower.closeFlight(id);
		for (const request of [{ op: "checkout" }, { op: "refresh" }, { op: "heartbeat" }, { op: "activity", text: "late" }])
			await expect(call(request)).rejects.toThrow("cancelled");
		expect(await call({ op: "status" })).toMatchObject({ phase: "cancelled", artifact: null });
	});
	it("plan → status → publish → validate → land", async () => {
		const { tower, id, call } = await setup();
		const filed = await call({ op: "plan", plan: SESSION_CLEANUP });
		expect(filed.clearance).toBe("clear");
		const status = await call({ op: "status" });
		expect(status.cleared).toEqual(["SessionRepository", "SessionService"]);
		expect(String(status.brief)).toContain("You are cleared to modify");

		const parent = status.head as string;
		const published = await call({ op: "publish", parent, message: "cleanup", files: overlayFiles("f023-session-cleanup") });
		expect(published.approved).toBe(true);
		await call({ op: "validate", commit: published.commit, passed: true, summary: "11 passed" });
		const landed = await call({ op: "land" });
		expect(landed.landed).toBe(true);
		expect(tower.flight(id).phase).toBe("landed");
	});

	it("a publish outside clearance is rejected with the offending airspace and next step", async () => {
		const { call } = await setup();
		await call({ op: "plan", plan: SESSION_CLEANUP });
		const status = await call({ op: "status" });
		const out = await call({
			op: "publish",
			parent: status.head,
			message: "x",
			files: { "src/auth/backdoor.ts": "export const x = 1;\n" },
		});
		expect(out.approved).toBe(false);
		expect(String(out.next)).toContain("amendment");
		expect((out.outside as { path: string }[])[0].path).toBe("src/auth/backdoor.ts");
	});

	it("request grants independent airspace mid-flight", async () => {
		const { call } = await setup();
		await call({ op: "plan", plan: SESSION_CLEANUP });
		const out = await call({ op: "request", resources: [{ type: "component", resource: "AuditLog" }], reason: "audit the cleanup" });
		expect(out.planVersion).toBe(2);
		expect(out.granted).toContain("AuditLog");
	});

	it("delivers a persisted reroute in status and acknowledges only the matching request", async () => {
		const { tower, id, call } = await setup();
		await call({ op: "plan", plan: SESSION_CLEANUP });
		const instruction = tower.mutate((c) => {
			const other = c.createFlight({
				missionId: c.createMission({ title: "Urgent session change", priority: "critical" }).id,
				agent: "external",
			});
			c.submitPlan(other.id, SESSION_CLEANUP);
			return c.requestReroute(id, "developer");
		});
		const status = await call({ op: "status" });
		expect(status.instruction).toMatchObject({ id: instruction.id, status: "pending" });
		expect(status.brief).toContain(instruction.id);
		await expect(call({ op: "ack-instruction", instructionId: "unknown" })).rejects.toThrow("Unknown instruction");
		await call({ op: "ack-instruction", instructionId: instruction.id });
		await call({ op: "ack-instruction", instructionId: instruction.id });
		const acknowledged = await call({ op: "status" });
		expect(acknowledged.instruction).toMatchObject({ id: instruction.id, status: "acknowledged", issuedPlanVersion: 1 });
		expect(acknowledged.brief).toContain(`Acknowledged reroute request ${instruction.id}`);
		expect(acknowledged.brief).toContain("This confirms receipt only");
		expect(tower.flight(id).plan?.planVersion).toBe(1);
	});

	it("rejects malformed protocol requests at the schema boundary", () => {
		expect(ProtocolRequest.safeParse({ op: "publish", parent: "not-a-sha", message: "x", files: {} }).success).toBe(false);
		expect(ProtocolRequest.safeParse({ op: "teleport" }).success).toBe(false);
	});
});
