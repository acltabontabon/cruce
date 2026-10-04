import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILED_FLIGHT_RETENTION_MS } from "../../src/core/domain.ts";
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

function harness() {
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
	};
	let tower = new ControlTower(ctx as unknown as DurableObjectState, bindings);
	const flush = async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};
	const env = {
		CONTROL_TOWER: { getByName: () => tower },
		ARTIFACTS_NAMESPACE: "local",
		CRUCE_SECRET: "test-secret",
	};
	const request = (path: string, init?: RequestInit) =>
		worker.fetch(
			new Request(`https://cruce.test/api/demo/${path}`, init) as never,
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
		const malformed = await command("demo/commands", { type: "cancel" });
		expect(malformed.status).toBe(400);
		expect(((await malformed.json()) as { error: string }).error).toContain("flightId:");
		expect((await command("demo/commands", { type: "reroute", flightId: "F-023" })).status).toBe(409);
		expect((await command("demo/commands", { type: "reroute", flightId: "F-999" })).status).toBe(404);
	});
});
