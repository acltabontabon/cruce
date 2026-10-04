import { describe, expect, it, vi } from "vitest";
import { FlightSandbox } from "../../src/worker/agents/flight-sandbox.ts";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: DurableObjectState,
			readonly env: unknown,
		) {}
	},
}));

describe("sandbox cleanup", () => {
	it("persists release across restarts, stops the container, and rejects delayed prepare/tasks", async () => {
		const kv = new Map<string, unknown>([
			["task", "execute"],
			["binding", { flightId: "F-001" }],
		]);
		let running = true;
		const destroy = vi.fn(async () => {
			running = false;
		});
		const deleteAlarm = vi.fn(async () => {});
		const ctx = {
			storage: {
				kv: {
					get: (key: string) => kv.get(key),
					put: (key: string, value: unknown) => kv.set(key, value),
					delete: (key: string) => kv.delete(key),
				},
				deleteAlarm,
			},
			container: {
				get running() {
					return running;
				},
				destroy,
			},
			blockConcurrencyWhile: (work: () => Promise<unknown>) => work(),
		} as unknown as DurableObjectState;
		const env = { CONTROL_TOWER: { getByName: () => ({ liveStatus: async () => ({ terminal: false }) }) } } as never;
		await new FlightSandbox(ctx, env).destroy();
		expect(destroy).toHaveBeenCalledOnce();
		expect(deleteAlarm).toHaveBeenCalledOnce();
		expect(kv.has("binding")).toBe(false);
		expect(kv.has("task")).toBe(false);
		const restored = new FlightSandbox(ctx, env);
		await expect(
			restored.prepare({
				projectId: "demo",
				flightId: "F-001",
				namespace: "cruce",
				repo: "auth-service--f001",
				remote: "https://example.test/repo.git",
				head: "base",
			}),
		).rejects.toThrow("released");
		await expect(restored.startTask("late work", "late")).rejects.toThrow("released");
		await restored.destroy();
		expect(destroy).toHaveBeenCalledOnce();
	});
});
