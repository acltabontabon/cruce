import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILED_FLIGHT_RETENTION_MS, FlightPlanInput } from "../../src/core/domain.ts";
import { SESSION_CLEANUP } from "../../src/demo/scenario.ts";
import { ControlTower, type TowerEnv } from "../../src/worker/control-tower.ts";
import worker from "../../src/worker/index.ts";
import { Tower } from "../../src/worker/tower.ts";

vi.mock("cloudflare:workers", () => {
	class Entrypoint {
		constructor(
			readonly ctx: DurableObjectState,
			readonly env: TowerEnv,
		) {}
	}
	return { DurableObject: Entrypoint, WorkerEntrypoint: Entrypoint, WorkflowEntrypoint: Entrypoint };
});
vi.mock("../../src/worker/git/sql-fs.ts", async () => {
	const { MemoryFs } = await import("../../src/worker/git/memory-fs.ts");
	return { SqlFs: MemoryFs };
});

function harness(live = false, extraBindings: Partial<TowerEnv> = {}) {
	const kv = new Map<string, unknown>();
	const pending: Promise<unknown>[] = [];
	const updates: string[] = [];
	let alarm: number | null = null;
	const storage = {
		kv: {
			get: (key: string) => structuredClone(kv.get(key)),
			put: (key: string, value: unknown) => kv.set(key, structuredClone(value)),
			delete: (key: string) => kv.delete(key),
		},
		sql: { exec: () => ({ toArray: () => [] }) },
		getAlarm: vi.fn(async () => alarm),
		setAlarm: vi.fn(async (at: number) => {
			alarm = at;
		}),
		deleteAlarm: vi.fn(async () => {
			alarm = null;
		}),
	};
	const ctx = {
		storage,
		getWebSockets: () => [{ send: (data: string) => updates.push(data) }],
		waitUntil: (work: Promise<unknown>) => pending.push(work),
	};
	const bindings: TowerEnv = {
		GIT_BACKEND: "local",
		ARTIFACTS_NAMESPACE: "local",
		...(live ? { ARTIFACTS: {} as Artifacts } : {}),
		...extraBindings,
	};
	let tower = new ControlTower(ctx as unknown as DurableObjectState, bindings);
	const flush = async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};
	const env = {
		CONTROL_TOWER: { getByName: () => tower },
		ARTIFACTS_NAMESPACE: "local",
		CRUCE_ADMIN_TOKEN: "test-controller",
		CRUCE_LEGACY_RUNTIME: "on",
		CRUCE_SECRET: "test-secret",
	};
	const request = (path: string, init?: RequestInit) =>
		worker.fetch(
			new Request(`https://cruce.test/api/projects/${path}`, init) as never,
			env as never,
			{ waitUntil: (p: Promise<unknown>) => pending.push(p) } as never,
		);
	return {
		get tower() {
			return tower;
		},
		restart: () => {
			tower = new ControlTower(ctx as unknown as DurableObjectState, bindings);
		},
		storage,
		updates,
		flush,
		request,
		fireAlarm: async () => {
			alarm = null;
			await tower.alarm();
			await flush();
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.UTC(2026, 9, 4));
});
afterEach(() => vi.useRealTimers());

describe("control tower presentation contract", () => {
	it("retains unsuccessful work through authenticated commands and returns explicit expiry after restart", async () => {
		const h = harness(true);
		const { flightId } = (await h.tower.command(
			"live",
			{ type: "launch", runtime: "external", title: "Recovery task", description: "Clean sessions", priority: "normal" },
			"controller",
		)) as { flightId: string };
		await h.tower.command("live", { type: "cancel", flightId }, "controller");
		await h.flush();
		const command = (keep: boolean, authorized = true) =>
			h.request("live/commands", {
				method: "POST",
				headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer test-controller" } : {}) },
				body: JSON.stringify({ type: "retain", flightId, keep }),
			});
		expect((await command(true, false)).status).toBe(401);
		expect((await command(true)).status).toBe(200);
		await h.flush();
		expect(await h.storage.getAlarm()).toBeNull();
		vi.setSystemTime(Date.now() + 2 * FAILED_FLIGHT_RETENTION_MS);
		h.restart();
		await h.tower.snapshot("live");
		await h.flush();
		expect((await h.tower.snapshot("live")).state.flights[0].cleanup?.keep).toBe(true);
		expect((await command(false)).status).toBe(200);
		await h.flush();
		expect((await h.tower.snapshot("live")).state.flights[0].cleanup?.status).toBe("complete");
		expect((await h.request(`live/history?target=${flightId}`)).status).toBe(401);
		expect((await h.request(`live/history?target=${flightId}`, { headers: { authorization: "Bearer test-controller" } })).status).toBe(410);
		expect((await h.request(`live/flights/${flightId}/changes`, { headers: { authorization: "Bearer test-controller" } })).status).toBe(
			410,
		);
	});

	it("keeps cleanup alarms when the demo is paused and preserves landed history after disposal", async () => {
		const h = harness();
		await h.tower.demo("demo", { op: "prepare" });
		while (!(await h.tower.snapshot("demo")).state.flights.some((f) => f.phase === "landed")) await h.tower.demo("demo", { op: "step" });
		await h.tower.demo("demo", { op: "pause" });
		await h.flush();
		const landed = (await h.tower.snapshot("demo")).state.flights.find((f) => f.phase === "landed")!;
		expect(landed.cleanup?.status).toBe("complete");
		expect((await h.request(`demo/history?target=${landed.id}`)).status).toBe(200);
		expect((await h.request(`demo/flights/${landed.id}/changes`)).status).toBe(200);
		await h.tower.command("demo", { type: "cancel", flightId: "F-021" }, "you");
		await h.flush();
		expect(await h.storage.getAlarm()).toBe(Date.now() + FAILED_FLIGHT_RETENTION_MS);
		vi.setSystemTime(Date.now() + FAILED_FLIGHT_RETENTION_MS);
		await h.fireAlarm();
		expect((await h.tower.snapshot("demo")).state.flights.find((f) => f.id === "F-021")?.cleanup?.status).toBe("complete");
	});

	it("terminates a live Workflow and sandbox immediately even when its published work is retained", async () => {
		const terminate = vi.fn(async () => {});
		const destroy = vi.fn(async () => {});
		const h = harness(true, {
			ANTHROPIC_API_KEY: "test-only",
			FLIGHT_WORKFLOW: {
				create: async ({ id }: { id: string }) => ({ id }),
				get: async () => ({ status: async () => ({ status: "running" }), terminate }),
			} as unknown as TowerEnv["FLIGHT_WORKFLOW"],
			FLIGHT_SANDBOX: { getByName: () => ({ destroy }) } as unknown as TowerEnv["FLIGHT_SANDBOX"],
		});
		const { flightId } = (await h.tower.command(
			"live",
			{ type: "launch", runtime: "sandbox", title: "Sandbox task", description: "Clean sessions", priority: "normal" },
			"controller",
		)) as { flightId: string };
		await h.tower.command("live", { type: "cancel", flightId }, "controller");
		await h.flush();
		expect(terminate).toHaveBeenCalledOnce();
		expect(destroy).toHaveBeenCalledOnce();
		expect((await h.tower.snapshot("live")).state.flights[0].cleanup?.deletedAt).toBeUndefined();
	});
	it("shares cold initialization between concurrent readers", async () => {
		const h = harness();
		const bootstrap = vi.spyOn(Tower.prototype, "bootstrap");
		try {
			const snapshots = await Promise.all([h.tower.snapshot("demo"), h.tower.snapshot("demo")]);
			expect(bootstrap).toHaveBeenCalledTimes(1);
			expect(snapshots[0].state.canonical.head).toBe(snapshots[1].state.canonical.head);
			expect(snapshots[0].state.log[0].type).toBe("project.ready");
		} finally {
			bootstrap.mockRestore();
		}
	});

	it("retries initialization after a bootstrap failure", async () => {
		const h = harness();
		const bootstrap = vi.spyOn(Tower.prototype, "bootstrap").mockRejectedValueOnce(new Error("temporary bootstrap failure"));
		try {
			await expect(h.tower.snapshot("demo")).rejects.toThrow("temporary bootstrap failure");
			const snapshot = await h.tower.snapshot("demo");
			expect(bootstrap).toHaveBeenCalledTimes(2);
			expect(snapshot.state.canonical.head).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			bootstrap.mockRestore();
		}
	});

	it("prepares a fresh demo once, preserves existing progress, and resets to the coordinated frame", async () => {
		const h = harness();
		const prepared = await Promise.all([h.tower.demo("demo", { op: "prepare" }), h.tower.demo("demo", { op: "prepare" })]);
		expect(prepared.map((s) => s.next)).toEqual([7, 7]);
		let snapshot = await h.tower.snapshot("demo");
		expect(snapshot.state.flights).toHaveLength(3);
		expect(snapshot.state.traffic.clearances["F-021"].status).toBe("partial");
		expect(snapshot.integrationBlockers["F-021"].join(" ")).toContain("holding");
		expect(snapshot.demo?.running).toBe(false);
		await h.tower.demo("demo", { op: "step" });
		expect((await h.tower.demo("demo", { op: "prepare" })).next).toBe(8);
		expect((await h.tower.demo("demo", { op: "reset" })).next).toBe(7);
		snapshot = await h.tower.snapshot("demo");
		expect(snapshot.state.flights.every((f) => f.publishes.length === 0)).toBe(true);
		expect(await h.storage.getAlarm()).toBeNull();
		expect(JSON.parse(h.updates.at(-1) as string).integrationBlockers).toEqual(snapshot.integrationBlockers);
	});

	it("replays from the beginning and cancels a paused demo alarm", async () => {
		const h = harness();
		await h.tower.demo("demo", { op: "prepare" });
		const replay = await h.tower.demo("demo", { op: "replay" });
		expect(replay).toMatchObject({ next: 0, running: true });
		expect((await h.tower.snapshot("demo")).state.flights).toHaveLength(0);
		expect(await h.storage.getAlarm()).toBeGreaterThan(Date.now());
		await h.tower.demo("demo", { op: "pause" });
		expect(await h.storage.getAlarm()).toBeNull();
	});

	it("arms external-agent expiry without postponing earlier alarms, then schedules terminal cleanup", async () => {
		const h = harness(true);
		const launched = (await h.tower.command(
			"live",
			{ type: "launch", runtime: "external", title: "Session cleanup", description: "Clean idle sessions", priority: "normal" },
			"controller",
		)) as { flightId: string };
		await h.flush();
		const first = await h.storage.getAlarm();
		expect(first).toBe(Date.now() + 30_000);
		vi.setSystemTime(Date.now() + 15_000);
		await h.tower.protocol("live", launched.flightId, { op: "heartbeat" });
		await h.flush();
		expect(await h.storage.getAlarm()).toBe(first);
		vi.setSystemTime(Date.now() + 31 * 60_000);
		await h.fireAlarm();
		expect((await h.tower.snapshot("live")).state.flights[0].phase).toBe("failed");
		expect(await h.storage.getAlarm()).toBe(Date.now() + FAILED_FLIGHT_RETENTION_MS);
	});

	it("restores held-run heartbeats and expires a silent zero-lease run through its alarm", async () => {
		const h = harness(true);
		const ids: string[] = [];
		for (const title of ["first session task", "waiting session task"]) {
			const run = (await h.tower.command(
				"live",
				{ type: "launch", runtime: "external", title, description: title, priority: "normal" },
				"controller",
			)) as { flightId: string };
			ids.push(run.flightId);
			await h.tower.protocol("live", run.flightId, { op: "plan", plan: FlightPlanInput.parse(SESSION_CLEANUP) });
		}
		let snapshot = await h.tower.snapshot("live");
		expect(snapshot.state.traffic.clearances[ids[1]].status).toBe("hold");
		expect(snapshot.state.leases.some((l) => l.flightId === ids[1])).toBe(false);
		vi.setSystemTime(Date.now() + 9 * 60_000);
		for (const id of ids) await h.tower.protocol("live", id, { op: "heartbeat" });
		await h.flush();
		h.restart();
		vi.setSystemTime(Date.now() + 9 * 60_000);
		await h.fireAlarm();
		expect((await h.tower.snapshot("live")).state.flights[1].phase).toBe("planned");
		vi.setSystemTime(Date.now() + 2 * 60_000);
		await h.tower.protocol("live", ids[0], { op: "heartbeat" });
		await h.fireAlarm();
		snapshot = await h.tower.snapshot("live");
		expect(snapshot.state.flights[1].phase).toBe("lost");
		expect(snapshot.state.flights[0].phase).toBe("executing");
		expect(snapshot.state.attention.some((a) => a.flights.includes(ids[1]))).toBe(true);
	});

	it("retains the acknowledged reroute receipt in both live and protocol status", async () => {
		const h = harness(true);
		const ids: string[] = [];
		for (const title of ["first session task", "waiting session task"]) {
			const run = (await h.tower.command(
				"live",
				{ type: "launch", runtime: "external", title, description: title, priority: "normal" },
				"controller",
			)) as { flightId: string };
			ids.push(run.flightId);
			await h.tower.protocol("live", run.flightId, { op: "plan", plan: FlightPlanInput.parse(SESSION_CLEANUP) });
		}
		const flightId = ids[1];
		await h.tower.command("live", { type: "reroute", flightId }, "controller");
		const pending = await h.tower.liveStatus("live", flightId);
		expect(pending.instruction?.status).toBe("pending");
		expect(await h.tower.protocol("live", flightId, { op: "status" })).toMatchObject({ instruction: pending.instruction });
		await h.tower.protocol("live", flightId, { op: "ack-instruction", instructionId: pending.instruction?.id as string });
		const acknowledged = await h.tower.liveStatus("live", flightId);
		expect(acknowledged.instruction).toMatchObject({ id: pending.instruction?.id, status: "acknowledged", issuedPlanVersion: 1 });
		expect(acknowledged.planVersion).toBe(1);
		expect(acknowledged.brief).toContain("This confirms receipt only");
		expect(await h.tower.protocol("live", flightId, { op: "status" })).toMatchObject({
			instruction: acknowledged.instruction,
			brief: acknowledged.brief,
		});
		await h.flush();
	});

	it("marks a failed external provisioning attempt terminal and keeps its cleanup alarm", async () => {
		const h = harness(true);
		const provision = vi.spyOn(Tower.prototype, "provision").mockRejectedValueOnce(new Error("fork unavailable"));
		try {
			await expect(
				h.tower.command(
					"live",
					{ type: "launch", runtime: "external", title: "Session cleanup", description: "Clean sessions", priority: "normal" },
					"controller",
				),
			).rejects.toThrow("fork unavailable");
			await h.flush();
			const run = (await h.tower.snapshot("live")).state.flights[0];
			expect(run.phase).toBe("failed");
			expect(run.failureReason).toContain("Launch failed: fork unavailable");
			expect(await h.storage.getAlarm()).toBe(Date.now() + FAILED_FLIGHT_RETENTION_MS);
		} finally {
			provision.mockRestore();
		}
	});

	it("marks a rejected Workflow creation terminal and keeps its cleanup alarm", async () => {
		const create = vi.fn().mockRejectedValue(new Error("Workflow unavailable"));
		const h = harness(true, {
			FLIGHT_WORKFLOW: {
				create,
				get: vi.fn().mockRejectedValue(new Error("Workflow does not exist")),
			} as unknown as TowerEnv["FLIGHT_WORKFLOW"],
			FLIGHT_SANDBOX: { getByName: () => ({ destroy: async () => {} }) } as unknown as TowerEnv["FLIGHT_SANDBOX"],
			ANTHROPIC_API_KEY: "test-only",
		});
		await expect(
			h.tower.command(
				"live",
				{ type: "launch", runtime: "sandbox", title: "Session cleanup", description: "Clean sessions", priority: "normal" },
				"controller",
			),
		).rejects.toThrow("Workflow unavailable");
		await h.flush();
		const run = (await h.tower.snapshot("live")).state.flights[0];
		expect(run.phase).toBe("failed");
		expect(run.failureReason).toContain("Launch failed: Workflow unavailable");
		expect(await h.storage.getAlarm()).toBe(Date.now() + FAILED_FLIGHT_RETENTION_MS);
	});

	it("validates changes requests and returns Git comparison data through HTTP", async () => {
		const h = harness();
		await h.tower.demo("demo", { op: "prepare" });
		await h.tower.demo("demo", { op: "step" });
		const response = await h.request("demo/flights/F-023/changes");
		expect(response.status).toBe(200);
		const data = (await response.json()) as { files: { path: string }[]; baseCommit: string; headCommit: string };
		expect(data.baseCommit).not.toBe(data.headCommit);
		expect(data.files.length).toBeGreaterThan(0);
		expect((await h.request("demo/flights/nope/changes")).status).toBe(400);
		expect((await h.request("demo/flights/F-023/changes?path=../secret")).status).toBe(400);
		expect((await h.request("demo/flights/F-023/changes?path=missing.ts")).status).toBe(404);
		expect((await h.request("demo/flights/F-999/changes")).status).toBe(404);
		const detail = await h.request(`demo/flights/F-023/changes?path=${encodeURIComponent(data.files[0].path)}`);
		expect(((await detail.json()) as { file: { patch: string } }).file.patch).toContain("@@");
	});

	it("returns actionable HTTP errors for invalid commands and unavailable reroutes", async () => {
		const h = harness();
		await h.tower.demo("demo", { op: "prepare" });
		const command = (path: string, body: unknown) =>
			h.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		expect((await command("live/commands", { type: "cancel", flightId: "F-031" })).status).toBe(401);
		const malformed = await command("demo/commands", { type: "launch", title: "x", description: "x" });
		expect(malformed.status).toBe(400);
		expect(((await malformed.json()) as { error: string }).error).toContain("title:");
		expect((await command("demo/commands", { type: "reroute", flightId: "F-023" })).status).toBe(409);
		expect((await command("demo/commands", { type: "reroute", flightId: "F-999" })).status).toBe(404);
	});
});
