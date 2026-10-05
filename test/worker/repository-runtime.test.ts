import { afterEach, describe, expect, it, vi } from "vitest";
import { initialWorkspace, WorkspaceController } from "../../src/core/ownership.ts";
import type { Actor, Command, Repository, Session } from "../../src/shared/platform.ts";
import { type RepositoryHost, ResourceBoundary } from "../../src/worker/deployments.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { RepositoryRuntime } from "../../src/worker/repository-runtime.ts";
import type { Store } from "../../src/worker/store.ts";

const owner: Actor = { id: "human", userId: "owner", name: "Cris", kind: "human" };
const agent: Actor = { id: "agent", userId: "owner", name: "Codex", kind: "agent", connectionId: "oauth" };
const repo: Repository = {
	id: "repo",
	workspaceId: "workspace",
	name: "payments",
	defaultBranch: "trunk",
	createdAt: 1000,
	source: { kind: "local" },
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
const grant: import("../../src/worker/workspace-runtime.ts").ConnectionGrant = {
	actor: agent,
	scopes: ["cruce:read", "session:write", "revision:publish", "artifact:publish", "change:write", "preview:request"],
	repositories: [repo.id],
};
function memory(): Store {
	const map = new Map<string, unknown>();
	return {
		get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
		put: (key, value) => {
			map.set(key, structuredClone(value));
		},
		delete: (key) => {
			map.delete(key);
		},
	};
}
afterEach(() => vi.restoreAllMocks());
async function fixture() {
	const w = new WorkspaceController(
		initialWorkspace({ id: "workspace", name: "Workspace", handle: "workspace", ownerId: "owner", kind: "shared", createdAt: 1 }),
		1000,
	);
	w.repository(w.authority(owner), structuredClone(repo));
	const git = new GitWorkspace(new MemoryFs() as never);
	await git.ensureInit();
	const author = { name: "Agent", email: "agent@local", timestamp: 12345 };
	const base = await git.commit({
		ref: "refs/heads/trunk",
		parent: null,
		files: { "AGENTS.md": "Keep retries bounded", "src/pay.ts": "export const retry=1;" },
		message: "baseline",
		author,
	});
	const head = await git.commit({
		ref: "refs/heads/session",
		parent: base,
		files: { "src/pay.ts": "export const retry=3;" },
		message: "exact agent commit",
		author,
	});
	const host: RepositoryHost = {
		ensure: vi.fn(async (name) => ({ name, id: name, remote: `https://example.invalid/${name}`, created: true })),
		info: vi.fn(async (name) => ({ name, id: name, remote: `https://example.invalid/${name}` })),
		withToken: async (_name, _scope, fn) => ({ result: await fn("short-lived-test-token"), tokenId: "token-id" }),
	};
	const push = vi.spyOn(git, "push").mockResolvedValue({} as never);
	vi.spyOn(ResourceBoundary.prototype, "host").mockResolvedValue(host);
	const store = memory(),
		port = {
			authority: (g: typeof grant, id?: string) => w.authority(g.actor, id, g.scopes, g.repositories),
			repository: (g: typeof grant, id: string) => {
				w.authority(g.actor, id, g.scopes, g.repositories);
				return structuredClone(w.state.repositories.find((r) => r.id === id)!);
			},
			reserve: (
				g: typeof grant,
				id: string,
				key: string,
				fingerprint: string,
				action: Parameters<WorkspaceController["reserve"]>[3],
				sessionId?: string,
			) => w.reserve(w.authority(g.actor, id, g.scopes, g.repositories), key, fingerprint, action, sessionId),
			settle: (id: string, state: "complete" | "uncertain" | "released") => {
				w.state.reservations.find((r) => r.id === id)!.state = state;
			},
			resourceConfiguration: () => ({ namespace: "workspace", account: {}, policy: w.state.policy }),
		};
	const runtime = new RepositoryRuntime(store, git, port, {}, () => 1000);
	runtime.initialize(structuredClone(repo));
	let n = 0;
	const call = (tool: string, extra: Partial<Command> = {}, g = grant) =>
		runtime.command({ tool, workspaceId: repo.workspaceId, repositoryId: repo.id, idempotencyKey: `key-${++n}`, ...extra }, g);
	const s = (await call("start_session", { title: "Retry", baseRevision: base })) as Session;
	await call("attach_session", {
		sessionId: s.id,
		execution: { id: s.id, checkoutId: "checkout", machineId: "machine", kind: "worktree", owned: true },
	});
	const pack = Buffer.from(await git.exportPack(head)).toString("base64");
	return { w, git, host, push, store, runtime, call, session: s, base, head, pack };
}
describe("repository runtime", () => {
	it("local sessions and read snapshots never provision cloud resources", async () => {
		const f = await fixture();
		await f.call("get_repository");
		await f.call("heartbeat", { sessionId: f.session.id });
		expect(f.host.ensure).not.toHaveBeenCalled();
		expect(f.w.state.reservations).toHaveLength(0);
	});
	it("publishes exact history and retains it after session completion", async () => {
		const f = await fixture();
		const artifact = (await f.call("publish_revision", { sessionId: f.session.id, revision: f.head, pack: f.pack })) as {
			id: string;
			revision: string;
		};
		expect(artifact.revision).toBe(f.head);
		expect((await f.git.log(f.head))[0].message).toBe("exact agent commit");
		await f.call("end_session", { sessionId: f.session.id });
		const result = (await f.call("read_artifact", { artifactId: artifact.id })) as { artifact: { revision: string } };
		expect(result.artifact.revision).toBe(f.head);
		expect(f.runtime.state().artifacts).toHaveLength(1);
	});
	it("reconciles a failed publication with one reservation and one artifact", async () => {
		const f = await fixture();
		f.push.mockRejectedValueOnce(new Error("response lost after push"));
		const cmd = { sessionId: f.session.id, revision: f.head, pack: f.pack, idempotencyKey: "same-operation" };
		await expect(f.call("publish_revision", cmd)).rejects.toThrow("response lost");
		expect(f.w.state.reservations[0].state).toBe("uncertain");
		expect(f.runtime.state().artifacts).toHaveLength(0);
		const a = await f.call("publish_revision", cmd);
		expect(await f.call("publish_revision", cmd)).toEqual(a);
		expect(f.w.state.reservations).toHaveLength(1);
		expect(f.runtime.state().artifacts).toHaveLength(1);
		expect(f.push).toHaveBeenCalledTimes(2);
	});
	it("rechecks revoked repository membership even for replayed commands", async () => {
		const f = await fixture();
		const cmd = { sessionId: f.session.id, revision: f.head, pack: f.pack, idempotencyKey: "published" };
		await f.call("publish_revision", cmd);
		delete f.w.state.members.owner;
		await expect(f.call("publish_revision", cmd)).rejects.toThrow("denied");
	});
	it("rejects protected changes and never exposes rejected imported source", async () => {
		const f = await fixture();
		f.w.member(f.w.authority(owner), "dev", "developer");
		f.w.state.repositories[0].grants = [{ subject: "user", id: "dev", role: "write" }];
		f.w.state.repositories[0].policy.protectedPaths = ["src"];
		const dev = { ...grant, actor: { ...agent, userId: "dev", id: "dev-agent" } };
		const s = (await f.call("start_session", { title: "Protected", baseRevision: f.base }, dev)) as Session;
		await f.call(
			"attach_session",
			{ sessionId: s.id, execution: { id: s.id, checkoutId: "other", machineId: "machine", kind: "worktree", owned: true } },
			dev,
		);
		await expect(f.call("publish_revision", { sessionId: s.id, revision: f.head, pack: f.pack }, dev)).rejects.toThrow("Protected");
		expect(f.push).not.toHaveBeenCalled();
		await expect(f.call("get_source", { revision: f.head }, dev)).rejects.toThrow("unavailable");
	});
	it("deploys source artifacts, never a caller supplied alternate revision", async () => {
		const f = await fixture();
		const artifact = (await f.call("publish_revision", { sessionId: f.session.id, revision: f.head, pack: f.pack })) as { id: string };
		const human = { actor: owner, scopes: [], repositories: [repo.id] };
		const env = (await f.call(
			"configure_environment",
			{ environment: { name: "Staging", kind: "preview", workerName: "payments", smokeChecks: [] } },
			human,
		)) as { id: string };
		const deployment = (await f.call("request_preview", { environmentId: env.id, artifactId: artifact.id, revision: f.base })) as {
			id: string;
			revision: string;
			artifactId: string;
		};
		expect(deployment.revision).toBe(f.head);
		expect(deployment.artifactId).toBe(artifact.id);
		vi.spyOn(ResourceBoundary.prototype, "builds").mockResolvedValue({
			scriptTag: async () => "tag",
			buildFor: async () => ({ build_uuid: "build", status: "stopped", build_outcome: "fail" }),
		} as never);
		expect(await f.runtime.tick(deployment.id)).toBe("failed");
		expect(f.runtime.state().deployments[0].error).toContain("fail");
	});
});

describe("terminal and deployment recovery", () => {
	it("atomically binds human terminal credentials to one session and permits the original retry", async () => {
		const f = await fixture();
		const human = { actor: { ...owner, connectionId: "terminal" } };
		const fields = { title: "Human", baseRevision: f.base, idempotencyKey: "human-start" };
		const s = await f.call("start_session", fields, human);
		expect(await f.call("start_session", fields, human)).toEqual(s);
		await expect(f.call("start_session", { ...fields, idempotencyKey: "other-start" }, human)).rejects.toThrow("bound");
		await expect(f.call("heartbeat", { sessionId: f.session.id }, human)).rejects.toThrow("scope");
	});
	it("reports pinned instructions unavailable without publication and provides structural context after upload", async () => {
		const f = await fixture();
		expect(await f.call("get_context", { sessionId: f.session.id })).toMatchObject({ available: false });
		await f.call("publish_revision", { sessionId: f.session.id, revision: f.head, pack: f.pack });
		expect(await f.call("get_context", { sessionId: f.session.id })).toMatchObject({
			available: true,
			structure: { revision: f.base, indexer: "babel-typescript" },
		});
	});
	it("does not replay a superseded uncertain deployment over a newer request", async () => {
		const f = await fixture();
		const artifact = (await f.call("publish_revision", { sessionId: f.session.id, revision: f.head, pack: f.pack })) as { id: string };
		const env = (await f.call(
			"configure_environment",
			{ environment: { name: "Preview", kind: "preview", workerName: "worker", smokeChecks: [] } },
			{ actor: owner },
		)) as { id: string };
		const old = { environmentId: env.id, artifactId: artifact.id, idempotencyKey: "old-deploy" };
		f.push.mockRejectedValueOnce(new Error("lost push response"));
		await expect(f.call("request_preview", old)).rejects.toThrow("lost push response");
		const newer = (await f.call("request_preview", { ...old, idempotencyKey: "new-deploy" })) as { id: string };
		await expect(f.call("request_preview", old)).rejects.toThrow("superseded");
		const pushes = f.push.mock.calls.length;
		expect(await f.runtime.tick(newer.id, true)).toBe("failed");
		expect(f.push).toHaveBeenCalledTimes(pushes);
	});
});
