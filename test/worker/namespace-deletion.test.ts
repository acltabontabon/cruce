import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { namespaceDeletionView } from "../../src/core/namespace-lifecycle.ts";
import { initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { initialRepository } from "../../src/core/platform.ts";
import type { Actor, Command, Repository, Workspace } from "../../src/shared/platform.ts";
import type { StorageEnv } from "../../src/worker/artifacts.ts";
import { Directory } from "../../src/worker/directory.ts";
import type { ConnectionGrant } from "../../src/worker/namespace-runtime.ts";
import { NamespaceRuntime } from "../../src/worker/namespace-runtime.ts";
import { RepositoryLifecycleRuntime } from "../../src/worker/repository-lifecycle.ts";
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
const developer: Actor = { id: "dev", userId: "dev", kind: "human", name: "Developer" };
const agent: Actor = { id: "agent-c", userId: "owner", kind: "agent", name: "Agent", connectionId: "c" };
const console_ = (actor: Actor): ConnectionGrant => ({ actor });
const repository = (id: string, name: string): Repository => ({
	id,
	namespaceId: "team",
	name,
	defaultBranch: "main",
	createdAt: 1,
	storageName: `repo-${id}`,
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
});

/** A Namespace DO whose repositories run the real repository deletion against it, as Control Towers would. */
function fixture(kind: "shared" | "personal" = "shared") {
	const data = new Map<string, unknown>();
	const store: Store = { ...memoryStore(data), get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined };
	const removed: string[] = [];
	let present = false;
	const remove = vi.fn(async (name: string) => {
		removed.push(name);
		return !present;
	});
	const retire = vi.fn(async (_id: string, _members: string[]) => {});
	const towers = new Map<string, { store: Store; runtime: () => RepositoryLifecycleRuntime }>();
	let alarm: number | null = null;
	const env = {
		ARTIFACTS: { get: vi.fn() } as unknown as Artifacts,
		CRUCE_STORAGE_ACCOUNT_ID: "a".repeat(32),
		CRUCE_ARTIFACTS_NAMESPACE: "cruce",
		DIRECTORY: { getByName: () => ({ retire }) },
		CONTROL_TOWER: {
			getByName: (id: string) => ({
				command: async (repo: Repository, cmd: Command, grant: ConnectionGrant) => {
					const tower = towers.get(id)!;
					if (cmd.tool === "get_repository") return { lifecycle: await tower.runtime().view(repo, grant, ns.authority(grant, id)) };
					return tower.runtime().command(repo, cmd, grant);
				},
			}),
		},
	};
	const ctx = {
		storage: {
			sql: store,
			getAlarm: async () => alarm,
			setAlarm: async (at: number) => {
				alarm = at;
			},
		},
	};
	const ns = new NamespaceRuntime(ctx as unknown as DurableObjectState, env as never);
	ns.initialize({ id: "team", ownerId: "owner", name: "Team", handle: "team", kind, createdAt: 1 });
	const add = (repo: Repository, workspaces: Partial<Workspace>[] = []) => {
		ns.saveRepository(console_(owner), repo);
		const repoStore = memoryStore();
		const state = initialRepository(repo);
		state.canonical = { id: `${repo.id}-canonical`, name: repo.storageName, remote: "https://example.invalid/canonical" };
		state.workspaces = workspaces as Workspace[];
		repoStore.put("repository", state);
		const port = {
			authority: (g: ConnectionGrant, rid: string) => ns.authority(g, rid),
			lifecycle: (g: ConnectionGrant, rid: string, lifecycle: NonNullable<Repository["lifecycle"]>) => ns.lifecycle(g, rid, lifecycle),
			lifecycleReservations: async (g: ConnectionGrant, rid: string, operationId?: string) => ns.lifecycleReservations(g, rid, operationId),
			releaseReservation: (g: ConnectionGrant, rid: string, reservationId: string) => ns.releaseReservation(g, rid, reservationId),
			reserve: (g: ConnectionGrant, rid: string, key: string, fingerprint: string, action: "repository.delete", storage?: boolean) =>
				ns.reserve(g, rid, key, fingerprint, action, undefined, storage),
			settle: (rid: string, state: "complete" | "uncertain") => ns.settle(rid, state),
			host: async () => ({ remove }) as never,
			schedule: async () => {},
			resetCache: () => {},
		};
		towers.set(repo.id, { store: repoStore, runtime: () => new RepositoryLifecycleRuntime(repoStore, port, Date.now) });
	};
	const remove_ = (key = "delete-team", confirmation = "team", actor = owner) =>
		ns.deleteNamespace(console_(actor), { confirmation, idempotencyKey: key });
	return {
		ns,
		store,
		add,
		towers,
		removed,
		retire,
		remove: remove_,
		alarm: () => alarm,
		keep: (value: boolean) => {
			present = value;
		},
	};
}
const liveWorkspace = (id: string): Partial<Workspace> => ({
	id,
	state: "active",
	execution: { mode: "worktree" } as never,
	fork: { id: `${id}-fork-id`, name: `${id}-fork`, remote: "https://example.invalid/fork", state: "ready" },
});

describe("permanent namespace deletion", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => vi.useRealTimers());

	it("deletes every repository, ending their live work, then retires the namespace", async () => {
		const f = fixture();
		f.ns.member(console_(owner), "dev", "developer");
		f.add(repository("r1", "api"), [liveWorkspace("w1")]);
		f.add(repository("r2", "web"));
		await f.ns.lifecycle(console_(owner), "r2", { state: "archived", at: 1, actorId: "owner", operationId: "archive" });
		const view = f.ns.snapshot(console_(owner));
		expect(view.lifecycle).toBeUndefined();

		expect(await f.remove()).toEqual({ state: "deleted" });
		expect(f.removed).toEqual(expect.arrayContaining(["repo-r1", "w1-fork", "repo-r2"]));
		expect(f.retire).toHaveBeenCalledWith("team", ["owner", "dev"]);
		expect(() => f.ns.authority(console_(owner))).toThrow("Namespace has been deleted");
		expect(() => f.ns.snapshot(console_(owner))).toThrow("Namespace has been deleted");
		// The original request replays without repeating anything.
		await expect(f.remove()).rejects.toThrow("Namespace has been deleted");
	});

	it("requires the console owner of a shared namespace and the exact handle", async () => {
		const f = fixture();
		f.ns.member(console_(owner), "dev", "maintainer");
		f.add(repository("r1", "api"));
		await expect(f.remove("k", "team", { ...developer, id: "dev" })).rejects.toThrow("Human namespace owner required");
		await expect(f.remove("k", "team", agent)).rejects.toThrow("Human namespace owner required");
		await expect(f.remove("k", "team", { ...owner, connectionId: "terminal" })).rejects.toThrow("Human namespace owner required");
		await expect(f.remove("k", "api")).rejects.toThrow("Type the namespace handle to confirm deletion");
		expect(f.ns.snapshot(console_(owner)).lifecycle).toBeUndefined();

		const personal = fixture("personal");
		await expect(personal.remove()).rejects.toThrow("A personal namespace belongs to its account");
	});

	it("waits for unsettled operations in any repository before freezing anything", async () => {
		const f = fixture();
		f.add(repository("r1", "api"));
		await f.ns.reserve(console_(owner), "r1", "fork", "input", "workspace.fork", "w1");
		await expect(f.remove()).rejects.toThrow("Namespace deletion has blockers");
		expect(f.ns.snapshot(console_(owner)).lifecycle).toBeUndefined();
		expect(f.removed).toEqual([]);
	});

	it("refuses before freezing when installation storage is unavailable, unless nothing needs storage", async () => {
		const f = fixture();
		f.add(repository("r1", "api"));
		f.store.put("resource-account", { legacy: true });
		await expect(f.remove()).rejects.toThrow("Namespace deletion has blockers");
		expect(f.ns.snapshot(console_(owner)).lifecycle).toBeUndefined();
		expect(f.removed).toEqual([]);

		const empty = fixture();
		empty.store.put("resource-account", { legacy: true });
		expect(await empty.remove()).toEqual({ state: "deleted" });
	});

	it("freezes the namespace while repository cleanup finishes, then completes from its alarm", async () => {
		const f = fixture();
		f.ns.member(console_(owner), "dev", "developer");
		f.add(repository("r1", "api"), [liveWorkspace("w1")]);
		f.keep(true);
		expect(await f.remove()).toEqual({ state: "deleting" });
		expect(f.alarm()).toBeGreaterThan(Date.now());

		// Only the console owner still reaches the namespace; nothing new can start.
		expect(() => f.ns.authority(console_(developer), "r1")).toThrow("Namespace is being deleted");
		expect(() => f.ns.authority({ actor: agent, scopes: ["cruce:read"], repositories: "all" }, "r1")).toThrow("Namespace is being deleted");
		expect(f.ns.authority(console_(owner), "r1").namespaceDeleting).toBe(true);
		expect(() => f.ns.saveRepository(console_(owner), repository("r9", "new"))).toThrow("Namespace is being deleted");
		expect(() => f.ns.member(console_(owner), "dev")).toThrow("Namespace is being deleted");
		await expect(f.ns.reserve(console_(owner), "r1", "fork", "input", "workspace.fork", "w1")).rejects.toThrow(
			"Namespace is being deleted",
		);
		const snapshot = f.ns.snapshot(console_(owner));
		expect(snapshot.lifecycle?.state).toBe("deleting");
		expect(snapshot.deletion).toEqual({ idempotencyKey: "delete-team" });
		// A different request cannot take over the authorized deletion.
		await expect(f.remove("other")).rejects.toThrow("Resume the existing namespace deletion");

		f.keep(false);
		// An alarm before the next attempt is due only waits.
		await f.ns.alarm();
		expect(f.ns.snapshot(console_(owner)).lifecycle?.state).toBe("deleting");
		vi.setSystemTime(Date.now() + 30_000);
		await f.ns.alarm();
		expect(f.retire).toHaveBeenCalledWith("team", ["owner", "dev"]);
		expect(() => f.ns.authority(console_(owner))).toThrow("Namespace has been deleted");
	});

	it("resumes a repository deletion the owner had already started", async () => {
		const f = fixture();
		f.add(repository("r1", "api"));
		f.add(repository("r2", "web"));
		f.keep(true);
		const started = await f.towers
			.get("r1")!
			.runtime()
			.command(
				f.ns.repository(console_(owner), "r1"),
				{ tool: "delete_repository", namespaceId: "team", repositoryId: "r1", idempotencyKey: "own", confirmation: "api" },
				console_(owner),
			);
		expect(started).toMatchObject({ state: "deleting" });
		f.keep(false);
		expect(await f.remove()).toEqual({ state: "deleted" });
		expect(f.retire).toHaveBeenCalled();
	});

	it("blocks with the repository's reason when its deletion cannot continue, and resumes on retry", async () => {
		const f = fixture();
		f.add(repository("r1", "api"));
		f.add(repository("r2", "web"));
		const policy = f.ns.snapshot(console_(owner)).policy;
		const deny = { rules: { ...policy.rules, "repository.delete": "deny" as const } };
		f.ns.policy(console_(owner), deny);
		await expect(f.remove()).rejects.toThrow("Namespace deletion has blockers");

		f.ns.policy(console_(owner), policy);
		f.keep(true);
		expect(await f.remove()).toMatchObject({ state: "deleting" });
		// Policy changed after authorization: the next attempt blocks, and its alarm does not retry a blocked deletion.
		f.ns.policy(console_(owner), deny);
		f.keep(false);
		vi.setSystemTime(Date.now() + 30_000);
		await f.ns.alarm();
		expect(f.ns.snapshot(console_(owner)).deletion?.reason).toBe("api: Resource policy denies this operation");
		await f.ns.alarm();
		expect(f.retire).not.toHaveBeenCalled();
		// The owner can still correct the policy and retry the same deletion.
		f.ns.policy(console_(owner), policy);
		expect(await f.remove()).toEqual({ state: "deleted" });
	});
});

describe("namespace deletion view", () => {
	it("sums the work it ends and names each repository's blockers", () => {
		const c = new NamespaceController(
			initialNamespace({ id: "team", ownerId: "owner", name: "Team", handle: "team", kind: "shared", createdAt: 1 }),
			1,
		);
		const view = namespaceDeletionView(
			c.state,
			c.authority(owner),
			[
				{
					repository: repository("r1", "api"),
					lifecycle: {
						state: "active",
						owner: true,
						blockers: [],
						deletionBlockers: ["Recover unfinished promotions."],
						unfinished: { workspaces: 2, attached: 1, changes: 1 },
					},
				},
				{
					repository: { ...repository("r2", "web"), lifecycle: { state: "archived", at: 1, actorId: "owner", operationId: "a" } },
					lifecycle: {
						state: "archived",
						owner: true,
						blockers: [],
						deletionBlockers: [],
						unfinished: { workspaces: 0, attached: 0, changes: 0 },
						transition: { tool: "restore_repository", idempotencyKey: "r" },
					},
				},
				{ repository: repository("r3", "docs") },
			],
			{ mode: "deployment", ready: true },
		);
		expect(view).toMatchObject({
			state: "active",
			deletable: true,
			owner: true,
			repositories: 3,
			archived: 1,
			unfinished: { workspaces: 2, attached: 1, changes: 1 },
			blockers: [
				"api: Recover unfinished promotions.",
				"web: Retry the unfinished archive or restore.",
				"docs: Repository could not be read; retry when it is available.",
			],
		});
	});
});

describe("directory retirement", () => {
	function directory() {
		const data = new Map<string, unknown>();
		const d = new Directory({ storage: { sql: memoryStore(data) } } as unknown as DurableObjectState, {} as never);
		const user = d.login({ tenantId: "t", developerId: "u", email: "owner@example.com" });
		return { d, user, data };
	}
	it("frees the handle, hides the namespace from members and never recreates its stable ID", () => {
		const { d, user } = directory();
		const team = d.create(user, { handle: "team", name: "Team" }, "team-id");
		expect(d.namespaces(user.id).map((n) => n.id)).toContain("team-id");
		d.retire("team-id", [user.id]);
		d.retire("team-id", [user.id]);
		expect(d.namespaces(user.id).map((n) => n.id)).not.toContain("team-id");
		expect(() => d.create(user, { handle: "team", name: "Team" }, "team-id")).toThrow("Namespace has been deleted");
		expect(d.create(user, { handle: team.handle, name: "Team again" }, "new-id").handle).toBe("team");
	});
	it("refuses to retire a personal namespace", () => {
		const { d, user } = directory();
		expect(() => d.retire(user.personalNamespaceId, [user.id])).toThrow("A personal namespace belongs to its account");
	});
});
