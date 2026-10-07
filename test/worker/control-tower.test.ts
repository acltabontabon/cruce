import { afterEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "../../src/shared/platform.ts";
import { ControlTower } from "../../src/worker/control-tower.ts";
import { RepositoryRuntime } from "../../src/worker/repository-runtime.ts";
import type { Store } from "../../src/worker/store.ts";
import { memory } from "./artifacts-fixture.ts";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: DurableObjectState,
			readonly env: unknown,
		) {}
	},
}));
vi.mock("../../src/worker/store.ts", async (original) => ({ ...(await original<object>()), sqlStore: (store: Store) => store }));
afterEach(() => vi.restoreAllMocks());

const repository: Repository = {
	id: "repo",
	namespaceId: "team",
	name: "Source",
	defaultBranch: "main",
	createdAt: 1000,
	storageName: "repo-repo",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
function tower() {
	const { store } = memory();
	let alarm: number | null = null;
	const storage = {
		sql: store,
		transactionSync: <T>(run: () => T) => run(),
		getAlarm: vi.fn(async () => alarm),
		setAlarm: vi.fn(async (at: number) => {
			alarm = at;
		}),
	};
	const env = { NAMESPACE: { getByName: vi.fn(() => ({})) }, OAUTH_KV: {} };
	return { store, storage, env, tower: new ControlTower({ storage } as unknown as DurableObjectState, env as never) };
}

describe("cleanup recovery alarm", () => {
	it("does nothing for an unregistered repository, without opening storage or provider state", async () => {
		const f = tower();
		const recover = vi.spyOn(RepositoryRuntime.prototype, "recoverCleanup");
		await f.tower.alarm();
		expect(recover).not.toHaveBeenCalled();
		expect(f.env.NAMESPACE.getByName).not.toHaveBeenCalled();
		expect(f.store.put).not.toHaveBeenCalled();
		expect(f.storage.setAlarm).not.toHaveBeenCalled();
	});
	it("resumes recorded cleanup and only ever moves the wakeup earlier", async () => {
		const f = tower();
		f.store.put("repository", { repository, workspaces: [] });
		const requested = [5000, 9000, 3000];
		const recover = vi.spyOn(RepositoryRuntime.prototype, "recoverCleanup").mockImplementation(async function (this: RepositoryRuntime) {
			await this.recovery!.schedule(requested.shift()!);
		});
		for (let n = 0; n < 3; n++) await f.tower.alarm();
		expect(recover).toHaveBeenCalledTimes(3);
		expect(f.env.NAMESPACE.getByName).toHaveBeenCalledWith("team");
		expect(f.storage.setAlarm.mock.calls.map(([at]) => at)).toEqual([5000, 3000]);
	});
});
