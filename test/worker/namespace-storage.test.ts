import { describe, expect, it, vi } from "vitest";
import type { Actor, Repository } from "../../src/shared/platform.ts";
import type { StorageEnv } from "../../src/worker/artifacts.ts";
import { NamespaceRuntime } from "../../src/worker/namespace-runtime.ts";
import { memoryStore, type Store } from "../../src/worker/store.ts";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: DurableObjectState,
			readonly env: StorageEnv,
		) {}
	},
}));
vi.mock("../../src/worker/store.ts", async (original) => ({ ...(await original<object>()), sqlStore: (store: Store) => store }));
const owner: Actor = { id: "owner", userId: "owner", kind: "human", name: "Owner" };
function fixture() {
	const data = new Map<string, unknown>();
	const store: Store = {
		...memoryStore(data),
		get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
		put: vi.fn((key, value) => {
			data.set(key, structuredClone(value));
		}),
		delete: vi.fn((key) => {
			data.delete(key);
		}),
	};
	const get = vi.fn();
	const env: StorageEnv = {
		ARTIFACTS: { get } as unknown as Artifacts,
		CRUCE_STORAGE_ACCOUNT_ID: "a".repeat(32),
		CRUCE_ARTIFACTS_NAMESPACE: "cruce",
	};
	const runtime = new NamespaceRuntime({ storage: { sql: store } } as unknown as DurableObjectState, env);
	runtime.initialize({ id: "team", ownerId: "owner", name: "Team", handle: "team", kind: "shared", createdAt: 1 });
	const repo: Repository = {
		id: "repo",
		namespaceId: "team",
		name: "source",
		defaultBranch: "main",
		createdAt: 1,
		storageName: "repo-repo",
		grants: [],
		policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
	};
	runtime.saveRepository({ actor: owner }, repo);
	return { data, store, env, runtime, get };
}
describe("namespace storage gate", () => {
	it("reads inherited storage without writing or provisioning", () => {
		const f = fixture();
		vi.mocked(f.store.put).mockClear();
		expect(f.runtime.snapshot({ actor: owner }).storage).toEqual({ mode: "deployment", ready: true });
		expect(f.runtime.resourceConfiguration().binding).toBeUndefined();
		expect(f.store.put).not.toHaveBeenCalled();
		expect(f.get).not.toHaveBeenCalled();
	});
	it("reserves resources without a customer account and reuses the reservation on retry", async () => {
		const f = fixture();
		const first = await f.runtime.reserve({ actor: owner }, "repo", "operation", "input", "repository.create");
		expect((await f.runtime.reserve({ actor: owner }, "repo", "operation", "input", "repository.create")).id).toBe(first.id);
		expect(f.runtime.snapshot({ actor: owner }).reservations).toHaveLength(1);
		expect(f.runtime.resourceConfiguration().binding).toEqual({ accountId: "a".repeat(32), namespace: "cruce" });
		expect(f.data.has("resource-account")).toBe(false);
		expect(f.get).not.toHaveBeenCalled();
	});
	it("checks current authority and namespace budgets before pinning storage", async () => {
		const f = fixture();
		await expect(
			f.runtime.reserve({ actor: { ...owner, id: "outsider", userId: "outsider" } }, "repo", "denied", "input", "repository.create"),
		).rejects.toThrow();
		const policy = f.runtime.snapshot({ actor: owner }).policy;
		f.runtime.policy({ actor: owner }, { ...policy, dailyLimit: 0 });
		await expect(f.runtime.reserve({ actor: owner }, "repo", "budget", "input", "repository.create")).rejects.toThrow();
		expect(f.runtime.resourceConfiguration().binding).toBeUndefined();
		expect(f.runtime.snapshot({ actor: owner }).reservations).toHaveLength(0);
		expect(f.get).not.toHaveBeenCalled();
	});
	it("rejects a changed deployment binding even on reservation replay", async () => {
		const f = fixture();
		await f.runtime.reserve({ actor: owner }, "repo", "operation", "input", "repository.create");
		f.env.CRUCE_STORAGE_ACCOUNT_ID = "b".repeat(32);
		await expect(f.runtime.reserve({ actor: owner }, "repo", "operation", "input", "repository.create")).rejects.toThrow(
			"identity changed",
		);
		expect(f.runtime.snapshot({ actor: owner }).reservations).toHaveLength(1);
		expect(f.get).not.toHaveBeenCalled();
	});
});
