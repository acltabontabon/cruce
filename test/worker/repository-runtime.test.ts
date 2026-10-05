import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import type { Actor, Command, Proposal, Repository, Workspace } from "../../src/shared/platform.ts";
import { type RepositoryHost, ResourceBoundary } from "../../src/worker/artifacts.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { RepositoryRuntime } from "../../src/worker/repository-runtime.ts";
import type { Store } from "../../src/worker/store.ts";
import { gitServer } from "../git/http-fixture.ts";

const owner: Actor = { id: "human", userId: "owner", name: "Cris", kind: "human" };
const agent: Actor = { id: "agent", userId: "owner", name: "Codex", kind: "agent", connectionId: "oauth" };
const repo: Repository = {
	id: "repo",
	namespaceId: "namespace",
	name: "payments",
	defaultBranch: "trunk",
	createdAt: 1000,
	storageName: "repo-repo",
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
const grant: import("../../src/worker/namespace-runtime.ts").ConnectionGrant = {
	actor: agent,
	scopes: ["cruce:read", "workspace:write", "revision:publish", "artifact:publish", "change:write"],
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
async function fixture(_hosted = true) {
	const w = new NamespaceController(
		initialNamespace({ id: "namespace", name: "Namespace", handle: "namespace", ownerId: "owner", kind: "shared", createdAt: 1 }),
		1000,
	);
	const repository = structuredClone(repo);
	w.repository(w.authority(owner), repository);
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
		ref: "refs/heads/workspace",
		parent: base,
		files: { "src/pay.ts": "export const retry=3;" },
		message: "exact agent commit",
		author,
	});
	const host: RepositoryHost = {
		remove: vi.fn(async () => true),
		gitRequest: vi.fn(async () => new Response("git")),
		fork: vi.fn(async (_source, name) => ({ name, id: name, remote: `https://example.invalid/${name}`, created: true })),
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
				action: Parameters<NamespaceController["reserve"]>[3],
				workspaceId?: string,
			) => w.reserve(w.authority(g.actor, id, g.scopes, g.repositories), key, fingerprint, action, workspaceId),
			settle: (id: string, state: "complete" | "uncertain" | "released") => {
				w.state.reservations.find((r) => r.id === id)!.state = state;
			},
			resourceConfiguration: () => ({ namespace: "namespace", account: {}, policy: w.state.policy }),
		};
	const runtime = new RepositoryRuntime(store, git, port, {}, () => 1000);
	runtime.initialize(repository);
	{
		const state = runtime.state();
		state.sourceHead = base;
		state.canonical = {
			id: repository.storageName!,
			name: repository.storageName!,
			remote: `https://example.invalid/${repository.storageName}`,
		};
		store.put("repository", state);
	}
	let n = 0;
	const call = async (tool: string, extra: Partial<Command> & { pack?: string } = {}, g = grant) => {
		const { pack, ...fields } = extra;
		if (pack) {
			await git.importPack(Buffer.from(pack, "base64"));
			vi.spyOn(git, "fetch").mockResolvedValueOnce(extra.revision!);
			fields.ref = "work";
		}
		return runtime.command({ tool, namespaceId: repo.namespaceId, repositoryId: repo.id, idempotencyKey: `key-${++n}`, ...fields }, g);
	};
	const s = (await call("start_workspace", { title: "Retry", baseRevision: base })) as Workspace;
	const execution = { id: s.id, checkoutId: "checkout", machineId: "machine", kind: "worktree" as const, owned: true };
	await call("attach_workspace", { workspaceId: s.id, execution });
	const pack = Buffer.from(await git.exportPack(head)).toString("base64");
	return { w, git, host, push, store, port, runtime, call, workspace: s, execution, base, head, pack };
}
describe("repository runtime", () => {
	it("forks canonical directly and keeps hosted identity out of local execution metadata", async () => {
		const f = await fixture(true);
		expect(f.host.fork).toHaveBeenCalledWith("repo-repo", expect.any(String), expect.any(String));
		expect(f.host.ensure).not.toHaveBeenCalled();
		expect(f.runtime.state().workspaces[0].fork).toMatchObject({ state: "ready" });
		expect(f.runtime.state().workspaces[0].execution).not.toHaveProperty("storageName");
	});
	it("authorizes each Git request and confines writes to the owning active fork", async () => {
		const f = await fixture(true);
		const request = (id: string, write = false) =>
			new Request(`https://cruce.example/mcp/git/namespace/repo/${id}.git/info/refs?service=git-${write ? "receive" : "upload"}-pack`);
		await expect(f.runtime.gitRequest(request("canonical", true), grant)).rejects.toThrow("human promotion");
		expect(await (await f.runtime.gitRequest(request("canonical"), grant)).text()).toBe("git");
		f.w.member(f.w.authority(owner), "dev", "developer");
		f.w.state.repositories[0].grants = [{ subject: "user", id: "dev", role: "write" }];
		await expect(
			f.runtime.gitRequest(request(f.workspace.id, true), {
				...grant,
				actor: { ...agent, id: "dev-agent", userId: "dev", connectionId: "dev" },
			}),
		).rejects.toThrow("another user");
		await expect(
			f.runtime.gitRequest(request(f.workspace.id, true), { ...grant, scopes: ["cruce:read", "workspace:write"] }),
		).rejects.toThrow("scopes");
		const push = () =>
			new Request(`https://cruce.example/mcp/git/namespace/repo/${f.workspace.id}.git/git-receive-pack`, {
				method: "POST",
				body: "same-push-bytes",
			});
		vi.mocked(f.host.gitRequest).mockRejectedValueOnce(new Error("lost response"));
		await expect(f.runtime.gitRequest(push(), grant)).rejects.toThrow("lost response");
		await f.runtime.gitRequest(push(), grant);
		expect(f.w.state.reservations.filter((r) => r.action === "revision.publish")).toHaveLength(1);
		f.w.state.policy.rules["revision.publish"] = "deny";
		await expect(f.runtime.gitRequest(push(), grant)).rejects.toThrow("denies");
		f.w.state.policy.rules["revision.publish"] = "allow";
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		await expect(f.runtime.gitRequest(push(), grant)).rejects.toThrow("ended");
		delete f.w.state.members.owner;
		await expect(f.runtime.gitRequest(request("canonical"), grant)).rejects.toThrow("denied");
	});
	it("seals an exact pushed fork ref into separate immutable artifact storage", async () => {
		const f = await fixture(true);
		vi.spyOn(f.git, "fetch").mockResolvedValue(f.head);
		const artifact = await f.call("publish_revision", { workspaceId: f.workspace.id, ref: "work", revision: f.head });
		expect(artifact).toMatchObject({ revision: f.head, storage: { repository: "repo-repo-artifacts" } });
		await expect(f.call("publish_revision", { workspaceId: f.workspace.id, ref: "work", revision: f.base })).rejects.toThrow("ref moved");
	});
	it("refuses cleanup of live or unretained work and reconciles asynchronous deletion with one operation", async () => {
		const f = await fixture(true);
		const fields = { workspaceId: f.workspace.id, idempotencyKey: "cleanup" };
		await expect(f.call("cleanup_workspace", fields)).rejects.toThrow("End the workspace");
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		const refs = vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: "refs/heads/work", oid: f.head }]);
		await expect(f.call("cleanup_workspace", fields)).rejects.toThrow("Unretained");
		expect(f.host.remove).not.toHaveBeenCalled();
		refs.mockResolvedValue([{ ref: "refs/heads/trunk", oid: f.base }]);
		vi.mocked(f.host.remove).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		expect(await f.call("cleanup_workspace", fields)).toMatchObject({ state: "deleting" });
		expect(f.w.state.reservations.at(-1)?.state).toBe("uncertain");
		expect(await f.call("cleanup_workspace", fields)).toMatchObject({ state: "deleted" });
		expect(await f.call("cleanup_workspace", fields)).toMatchObject({ state: "deleted" });
		expect(f.host.remove).toHaveBeenCalledTimes(2);
		expect(f.w.state.reservations.filter((r) => r.action === "workspace.cleanup")).toHaveLength(1);
		expect(f.runtime.state().workspaces[0].baseRevision).toBe(f.base);
	});
	it("rejects unavailable hosted baselines before provisioning any fork resources", async () => {
		const f = await fixture(true);
		const s = (await f.call("start_workspace", { title: "Missing base", baseRevision: "d".repeat(40) })) as Workspace;
		const calls = vi.mocked(f.host.ensure).mock.calls.length,
			reservations = f.w.state.reservations.length;
		await expect(
			f.call("attach_workspace", {
				workspaceId: s.id,
				execution: { id: s.id, checkoutId: "missing", machineId: "machine", kind: "worktree", owned: true },
			}),
		).rejects.toThrow("unavailable");
		expect(f.host.ensure).toHaveBeenCalledTimes(calls);
		expect(f.w.state.reservations).toHaveLength(reservations);
	});
	it("pins a reconciled publication's review base across uncertain push retries even as upstream advances", async () => {
		const f = await fixture();
		const upstream = await f.git.commit({
			ref: "refs/heads/upstream",
			parent: f.base,
			files: { "other.txt": "upstream" },
			message: "Upstream",
			author: { name: "Other", email: "other@local", timestamp: 12346 },
		});
		const merged = await f.git.merge({
			ours: "refs/heads/workspace",
			theirs: "refs/heads/upstream",
			message: "Integrate",
			author: { name: "Agent", email: "agent@local", timestamp: 12347 },
		});
		if (!merged.oid) throw new Error("Fixture merge failed");
		const state = f.runtime.state();
		state.sourceHead = upstream;
		f.store.put("repository", state);
		const fields = {
			workspaceId: f.workspace.id,
			revision: merged.oid,
			pack: Buffer.from(await f.git.exportPack(merged.oid)).toString("base64"),
			idempotencyKey: "pinned-publication",
		};
		f.push.mockRejectedValueOnce(new Error("push response lost"));
		await expect(f.call("publish_revision", fields)).rejects.toThrow("lost");
		const next = await f.git.commit({
			ref: "refs/heads/upstream",
			parent: upstream,
			files: { "next.txt": "next" },
			message: "Advance again",
			author: { name: "Other", email: "other@local", timestamp: 12348 },
		});
		const advanced = f.runtime.state();
		advanced.sourceHead = next;
		f.store.put("repository", advanced);
		expect(await f.call("publish_revision", fields)).toMatchObject({ revision: merged.oid, baseRevision: upstream });
		expect(f.w.state.reservations.filter((r) => r.action === "revision.publish")).toHaveLength(1);
		expect(f.runtime.state().workspaces[0].baseRevision).toBe(f.base);
	});
	it("gives hosted writers distinct forks and reconciles uncertain attachment without another reservation", async () => {
		const f = await fixture(true);
		const other = { ...grant, actor: { ...agent, id: "other-agent", connectionId: "other-oauth" } };
		const s = (await f.call("start_workspace", { title: "Other", baseRevision: f.base }, other)) as Workspace;
		const attach = {
			workspaceId: s.id,
			execution: { id: s.id, checkoutId: "other", machineId: "machine", kind: "worktree" as const, owned: true },
			idempotencyKey: "retry-fork",
		};
		vi.mocked(f.host.fork!).mockRejectedValueOnce(new Error("fork response lost"));
		await expect(f.call("attach_workspace", attach, other)).rejects.toThrow("lost");
		await f.call("attach_workspace", attach, other);
		await f.call("attach_workspace", attach, other);
		const workspaces = f.runtime.state().workspaces;
		expect(workspaces[0].fork?.name).not.toBe(workspaces[1].fork?.name);
		expect(f.w.state.reservations.filter((r) => r.workspaceId === s.id)).toHaveLength(1);
		expect(f.w.state.reservations.at(-1)?.state).toBe("complete");
	});
	it("reconciles a persistent fork after upstream promotion without rewriting its starting revision or old review", async () => {
		const f = await fixture(true);
		const original = (await f.call("publish_revision", { workspaceId: f.workspace.id, revision: f.head, pack: f.pack })) as { id: string };
		const oldProposal = (await f.call("create_proposal", { artifactId: original.id })) as { id: string };
		const upstream = await f.git.commit({
			ref: "refs/heads/upstream",
			parent: f.base,
			files: { "AGENTS.md": "Keep retries bounded and verify" },
			message: "Upstream instructions",
			author: { name: "Other", email: "other@local", timestamp: 12346 },
		});
		const other = { ...grant, actor: { ...agent, id: "other-agent", connectionId: "other-oauth" } };
		const s = (await f.call("start_workspace", { title: "Instructions", baseRevision: f.base }, other)) as Workspace;
		await f.call(
			"attach_workspace",
			{ workspaceId: s.id, execution: { id: s.id, checkoutId: "other", machineId: "machine", kind: "worktree", owned: true } },
			other,
		);
		const artifact = (await f.call(
			"publish_revision",
			{ workspaceId: s.id, revision: upstream, pack: Buffer.from(await f.git.exportPack(upstream)).toString("base64") },
			other,
		)) as { id: string };
		const proposal = (await f.call("create_proposal", { artifactId: artifact.id }, other)) as { id: string };
		const human = { actor: owner, scopes: [], repositories: [repo.id] };
		await f.call(
			"review_proposal",
			{ proposalId: proposal.id, revision: upstream, outcome: "approve", reason: "Verified instructions" },
			human,
		);
		const fetch = vi.spyOn(f.git, "fetch").mockResolvedValue(f.base);
		vi.spyOn(f.git, "remoteRefs")
			.mockResolvedValueOnce([{ ref: "refs/heads/trunk", oid: f.base }])
			.mockResolvedValueOnce([{ ref: "refs/heads/trunk", oid: upstream }]);
		await f.call("promote_proposal", { proposalId: proposal.id }, human);
		await f.call("report_change", {
			workspaceId: f.workspace.id,
			execution: f.execution,
			revision: f.head,
			changes: [{ path: "renamed.md", previousPath: "AGENTS.md", status: "renamed" }],
		});
		const reservations = f.w.state.reservations.length,
			pushes = f.push.mock.calls.length;
		expect(await f.call("get_workspace_updates", { workspaceId: f.workspace.id })).toMatchObject({
			revision: upstream,
			status: "available",
			available: true,
			comparison: "diverged",
			overlappingPaths: ["AGENTS.md"],
		});
		expect(await f.call("get_git_access", { workspaceId: f.workspace.id })).toMatchObject({ canonicalWrite: false });
		expect(f.w.state.reservations).toHaveLength(reservations);
		expect(f.push).toHaveBeenCalledTimes(pushes);
		const merged = await f.git.merge({
			ours: "refs/heads/workspace",
			theirs: "refs/heads/upstream",
			message: "Integrate upstream",
			author: { name: "Agent", email: "agent@local", timestamp: 12347 },
		});
		if (!merged.oid) throw new Error("Fixture merge failed");
		const reconciled = (await f.call("publish_revision", {
			workspaceId: f.workspace.id,
			revision: merged.oid,
			pack: Buffer.from(await f.git.exportPack(merged.oid)).toString("base64"),
		})) as { id: string; baseRevision: string; storage: { repository: string } };
		expect(reconciled.baseRevision).toBe(upstream);
		expect(reconciled.storage.repository).toBe("repo-repo-artifacts");
		expect(f.runtime.state().workspaces[0]).toMatchObject({ baseRevision: f.base, integratedRevision: upstream });
		const next = (await f.call("create_proposal", { artifactId: reconciled.id })) as { id: string; base: string };
		expect(next.base).toBe(upstream);
		expect(f.runtime.state().proposals.find((p) => p.id === oldProposal.id)?.base).toBe(f.base);
		await f.call(
			"review_proposal",
			{ proposalId: next.id, revision: merged.oid, outcome: "approve", reason: "Verified reconciled work" },
			human,
		);
		fetch.mockResolvedValue(upstream);
		vi.mocked(f.git.remoteRefs)
			.mockResolvedValueOnce([{ ref: "refs/heads/trunk", oid: upstream }])
			.mockResolvedValueOnce([{ ref: "refs/heads/trunk", oid: merged.oid }]);
		await f.call("promote_proposal", { proposalId: next.id }, human);
		expect(f.runtime.state().sourceHead).toBe(merged.oid);
		expect(await f.call("get_workspace_updates", { workspaceId: f.workspace.id })).toMatchObject({
			status: "current",
			comparison: "current",
		});
	});
	it("rejects fabricated integration, foreign fetches, stale fetch targets and revoked retries", async () => {
		const f = await fixture();
		await f.call("publish_revision", { workspaceId: f.workspace.id, revision: f.head, pack: f.pack });
		const upstream = await f.git.commit({
			ref: "refs/heads/new-source",
			parent: f.base,
			files: { "other.txt": "upstream" },
			message: "Upstream",
			author: { name: "Other", email: "other@local", timestamp: 12346 },
		});
		const state = f.runtime.state();
		state.sourceHead = upstream;
		f.store.put("repository", state);
		await expect(
			f.call("publish_revision", { workspaceId: f.workspace.id, revision: f.head, baseRevision: upstream, pack: f.pack }),
		).rejects.toThrow("Integrate");
		const fields = { workspaceId: f.workspace.id, revision: f.head, pack: f.pack, idempotencyKey: "publish-retry" };
		await f.call("publish_revision", fields);
		delete f.w.state.members.owner;
		await expect(f.call("publish_revision", fields)).rejects.toThrow("denied");
	});
	it("read snapshots and heartbeats never provision additional cloud resources", async () => {
		const f = await fixture();
		await f.call("get_repository");
		const before = f.runtime.state();
		expect(await f.call("get_workspace_updates", { workspaceId: f.workspace.id })).toMatchObject({
			status: "current",
			available: true,
			comparison: "current",
			changes: [],
		});
		expect(f.runtime.state()).toEqual(before);
		await f.call("heartbeat", { workspaceId: f.workspace.id, execution: f.execution });
		expect(f.host.ensure).not.toHaveBeenCalled();
		expect(f.w.state.reservations).toHaveLength(1);
	});
	it("keeps reported heads separate from authoritative canonical source", async () => {
		const f = await fixture();
		await f.call("report_change", { workspaceId: f.workspace.id, execution: f.execution, revision: "e".repeat(40), changes: [] });
		expect(await f.call("get_workspace_updates", { workspaceId: f.workspace.id })).toMatchObject({
			status: "current",
			trust: "accepted",
			available: true,
			changes: [],
		});
		expect(await f.call("get_git_access", { workspaceId: f.workspace.id })).toMatchObject({ canonicalWrite: false });
		expect(f.host.ensure).not.toHaveBeenCalled();
		expect(f.w.state.reservations).toHaveLength(1);
	});
	it("publishes exact history and retains it after workspace completion", async () => {
		const f = await fixture();
		const artifact = (await f.call("publish_revision", { workspaceId: f.workspace.id, revision: f.head, pack: f.pack })) as {
			id: string;
			revision: string;
		};
		expect(artifact.revision).toBe(f.head);
		expect((await f.git.log(f.head))[0].message).toBe("exact agent commit");
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		const result = (await f.call("read_artifact", { artifactId: artifact.id })) as { artifact: { revision: string } };
		expect(result.artifact.revision).toBe(f.head);
		expect(f.runtime.state().artifacts).toHaveLength(1);
	});
	it("reconciles a failed publication with one reservation and one artifact", async () => {
		const f = await fixture();
		f.push.mockRejectedValueOnce(new Error("response lost after push"));
		const cmd = { workspaceId: f.workspace.id, revision: f.head, pack: f.pack, idempotencyKey: "same-operation" };
		await expect(f.call("publish_revision", cmd)).rejects.toThrow("response lost");
		expect(f.w.state.reservations.at(-1)?.state).toBe("uncertain");
		expect(f.runtime.state().artifacts).toHaveLength(0);
		vi.spyOn(f.git, "fetch").mockRejectedValue(new Error("fork ref has advanced"));
		const a = await f.runtime.command(
			{
				tool: "publish_revision",
				namespaceId: repo.namespaceId,
				repositoryId: repo.id,
				workspaceId: f.workspace.id,
				revision: f.head,
				ref: "work",
				idempotencyKey: "same-operation",
			},
			grant,
		);
		expect(await f.call("publish_revision", cmd)).toEqual(a);
		expect(f.w.state.reservations.filter((r) => r.action === "revision.publish")).toHaveLength(1);
		expect(f.runtime.state().artifacts).toHaveLength(1);
		expect(f.push).toHaveBeenCalledTimes(3);
	});
	it("rechecks revoked repository membership even for replayed commands", async () => {
		const f = await fixture();
		const cmd = { workspaceId: f.workspace.id, revision: f.head, pack: f.pack, idempotencyKey: "published" };
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
		const s = (await f.call("start_workspace", { title: "Protected", baseRevision: f.base }, dev)) as Workspace;
		await f.call(
			"attach_workspace",
			{ workspaceId: s.id, execution: { id: s.id, checkoutId: "other", machineId: "machine", kind: "worktree", owned: true } },
			dev,
		);
		await expect(f.call("publish_revision", { workspaceId: s.id, revision: f.head, pack: f.pack }, dev)).rejects.toThrow("Protected");
		expect(f.push.mock.calls.every(([input]) => input.remoteRef === "refs/heads/cruce-base")).toBe(true);
		await expect(f.call("get_source", { revision: f.head }, dev)).rejects.toThrow("unavailable");
	});
});

describe("terminal recovery and pinned context", () => {
	it("atomically binds human terminal credentials to one workspace and permits the original retry", async () => {
		const f = await fixture();
		const human = { actor: { ...owner, connectionId: "terminal" } };
		const fields = { title: "Human", baseRevision: f.base, idempotencyKey: "human-start" };
		const s = await f.call("start_workspace", fields, human);
		expect(await f.call("start_workspace", fields, human)).toEqual(s);
		await expect(f.call("start_workspace", { ...fields, idempotencyKey: "other-start" }, human)).rejects.toThrow("bound");
		await expect(f.call("heartbeat", { workspaceId: f.workspace.id, execution: f.execution }, human)).rejects.toThrow("scope");
	});
	it("continues a workspace from another checkout and tool without reprovisioning its fork", async () => {
		const f = await fixture(true);
		const claude = { ...grant, actor: { ...agent, id: "agent-claude", name: "Claude Code", connectionId: "oauth-claude" } };
		const elsewhere = { id: f.workspace.id, checkoutId: "laptop-2", machineId: "machine-2", kind: "worktree" as const, owned: true };
		const fork = f.runtime.state().workspaces[0].fork;
		await expect(f.call("attach_workspace", { workspaceId: f.workspace.id, execution: elsewhere }, claude)).rejects.toThrow(
			"detach it first",
		);
		await f.call("detach_workspace", { workspaceId: f.workspace.id }, { actor: owner, scopes: [], repositories: [repo.id] });
		expect(f.runtime.state().workspaces[0]).toMatchObject({ state: "detached", fork });
		await f.call("attach_workspace", { workspaceId: f.workspace.id, execution: elsewhere }, claude);
		await expect(f.call("heartbeat", { workspaceId: f.workspace.id, execution: f.execution })).rejects.toThrow("different execution");
		await f.call("heartbeat", { workspaceId: f.workspace.id, execution: elsewhere });
		const published = (await f.call("publish_revision", { workspaceId: f.workspace.id, revision: f.head, pack: f.pack }, claude)) as {
			actor: { id: string };
		};
		expect(published.actor.id).toBe("agent-claude");
		const continued = f.runtime.state().workspaces[0];
		expect(continued).toMatchObject({ state: "active", baseRevision: f.base, fork, createdBy: { id: "agent" } });
		expect(continued.execution).toMatchObject({ checkoutId: "laptop-2", attachedBy: { id: "agent-claude" } });
		expect(f.host.fork).toHaveBeenCalledTimes(1);
		expect(f.w.state.reservations.filter((r) => r.action === "workspace.fork")).toHaveLength(1);
	});
});

it("clones, pushes and fetches with native Git through the workspace gateway while canonical stays unchanged", async () => {
	const f = await fixture(true);
	const root = await mkdtemp(join(tmpdir(), "cruce-native-git-"));
	const canonical = join(root, "canonical.git"),
		fork = join(root, "fork.git");
	const command = (args: string[], input?: Uint8Array) => execFileSync("git", args, { input, stdio: "pipe" });
	const native = async (args: string[]) =>
		(await promisify(execFile)("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
	let origin = "";
	const server = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const request = new Request(`${origin}${req.url}`, {
				method: req.method,
				...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
			});
			const result = await f.runtime.gitRequest(request, grant);
			res.writeHead(result.status, Object.fromEntries(result.headers));
			res.end(Buffer.from(await result.arrayBuffer()));
		} catch {
			res.writeHead(403).end("denied");
		}
	});
	try {
		for (const directory of [canonical, fork]) {
			command(["init", "--bare", "--initial-branch=trunk", directory]);
			command(["--git-dir", directory, "index-pack", "--stdin"], await f.git.exportPack(f.base));
			command(["--git-dir", directory, "update-ref", "refs/heads/trunk", f.base]);
		}
		vi.mocked(f.host.gitRequest).mockImplementation(async (name, request) => {
			const url = new URL(request.url),
				advertisement = url.pathname.endsWith("/info/refs");
			const service = advertisement ? url.searchParams.get("service")! : url.pathname.split("/").at(-1)!;
			const directory = name === "repo-repo" ? canonical : fork;
			const bytes = command(
				[service.replace("git-", ""), "--stateless-rpc", ...(advertisement ? ["--advertise-refs"] : []), directory],
				advertisement ? undefined : new Uint8Array(await request.arrayBuffer()),
			);
			const prefix = `# service=${service}\n`;
			return new Response(
				advertisement ? Buffer.concat([Buffer.from(`${(prefix.length + 4).toString(16).padStart(4, "0")}${prefix}0000`), bytes]) : bytes,
				{ headers: { "content-type": `application/x-${service}-${advertisement ? "advertisement" : "result"}` } },
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture port");
		origin = `http://127.0.0.1:${address.port}`;
		const remote = `${origin}/mcp/git/namespace/repo/${f.workspace.id}.git`;
		const clone = join(root, "checkout");
		await native(["clone", `${origin}/mcp/git/namespace/repo/canonical.git`, clone]);
		await native(["-C", clone, "remote", "add", "work", remote]);
		await writeFile(join(clone, "native.txt"), "Native Git commit\n");
		await native(["-C", clone, "add", "native.txt"]);
		await native(["-C", clone, "-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-m", "Native workspace work"]);
		const revision = await native(["-C", clone, "rev-parse", "HEAD"]);
		await native(["-C", clone, "push", "work", "HEAD:refs/heads/work"]);
		await native(["-C", clone, "fetch", "work", "work"]);
		expect(await native(["-C", clone, "rev-parse", "FETCH_HEAD"])).toBe(revision);
		expect(await native(["--git-dir", canonical, "rev-parse", "trunk"])).toBe(f.base);
		await expect(native(["-C", clone, "push", "origin", "HEAD:trunk"])).rejects.toThrow();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});

describe("exact approved-base promotion", () => {
	async function prepared() {
		const f = await fixture();
		const middle = await f.git.commit({
			ref: "refs/heads/middle",
			parent: f.base,
			files: { intermediate: "ancestor" },
			message: "Intermediate",
			author: { name: "Fixture", email: "fixture@local", timestamp: 12346 },
		});
		const candidate = await f.git.commit({
			ref: "refs/heads/candidate",
			parent: middle,
			files: { "src/pay.ts": "approved" },
			message: "Approved",
			author: { name: "Fixture", email: "fixture@local", timestamp: 12347 },
		});
		const artifact = (await f.call("publish_revision", {
			workspaceId: f.workspace.id,
			revision: candidate,
			pack: Buffer.from(await f.git.exportPack(candidate)).toString("base64"),
		})) as { id: string };
		const proposal = (await f.call("create_proposal", { artifactId: artifact.id, title: "Reviewed candidate" })) as Proposal;
		await f.call(
			"review_proposal",
			{ proposalId: proposal.id, revision: candidate, outcome: "approve", reason: "Exact source reviewed" },
			{ actor: owner },
		);
		f.push.mockRestore();
		const remote = await gitServer(f.git, f.base, [middle, candidate]);
		vi.mocked(f.host.info).mockResolvedValue({ name: repo.storageName!, id: repo.storageName!, remote: remote.url });
		const cmd: Command = {
			tool: "promote_proposal",
			namespaceId: repo.namespaceId,
			repositoryId: repo.id,
			proposalId: proposal.id,
			idempotencyKey: "exact-promotion",
		};
		const run = (runtime = f.runtime) => runtime.command(cmd, { actor: owner });
		const restart = () => new RepositoryRuntime(f.store, f.git, f.port, {}, () => 1001);
		return { ...f, proposal, middle, candidate, remote, cmd, run, restart };
	}
	it.each([
		["beforeAdvertisement", "middle"],
		["beforeUpdate", "middle"],
		["beforeAdvertisement", "candidate"],
		["beforeUpdate", "candidate"],
	] as const)("rejects movement at %s to %s", async (window, revision) => {
		const f = await prepared();
		try {
			f.remote[window] = () => f.remote.setHead(f[revision]);
			await expect(f.run()).rejects.toThrow();
			expect(f.remote.head()).toBe(f[revision]);
			expect(f.runtime.state().sourceHead).toBe(f.base);
			expect(f.runtime.state().promotions[0].state).not.toBe("complete");
			await expect(f.run(f.restart())).rejects.toThrow();
			expect(f.remote.updates).toBe(window === "beforeAdvertisement" ? 0 : 1);
			expect(f.w.state.reservations.at(-1)?.state).toBe("uncertain");
		} finally {
			await f.remote.close();
		}
	});

	it("retries unavailable pre-push observations under the same prepared operation", async () => {
		const f = await prepared();
		try {
			vi.spyOn(f.git, "remoteRefs").mockRejectedValueOnce(new Error("observation unavailable"));
			await expect(f.run()).rejects.toThrow("observation unavailable");
			expect(f.remote.updates).toBe(0);
			expect(f.runtime.state().promotions[0]).toMatchObject({ state: "uncertain", operation: { phase: "prepared" } });
			await f.run(f.restart());
			expect(f.remote.updates).toBe(1);
			expect(f.remote.head()).toBe(f.candidate);
			expect(f.w.state.reservations.filter((r) => r.id === "human:exact-promotion")).toHaveLength(1);
		} finally {
			await f.remote.close();
		}
	});
	it("refuses a pre-existing candidate instead of inferring acceptance", async () => {
		const f = await prepared();
		try {
			f.remote.setHead(f.candidate);
			await expect(f.run()).rejects.toThrow("Canonical moved");
			expect(f.remote.updates).toBe(0);
			expect(f.runtime.state().sourceHead).toBe(f.base);
			expect(f.runtime.state().proposals[0].state).toBe("rejected");
		} finally {
			await f.remote.close();
		}
	});
	it("reconciles a lost successful push response after restart without re-pushing", async () => {
		const f = await prepared();
		try {
			f.remote.afterUpdate = () => {
				throw new Error("response lost after ref update");
			};
			await expect(f.run()).rejects.toThrow();
			expect(f.remote.head()).toBe(f.candidate);
			expect(f.runtime.state().sourceHead).toBe(f.base);
			expect(f.runtime.state().promotions[0]).toMatchObject({ state: "uncertain", operation: { phase: "attempted" } });
			expect(await f.run(f.restart())).toMatchObject({ state: "complete", from: f.base, to: f.candidate });
			await f.run(f.restart());
			expect(f.remote.updates).toBe(1);
			expect(f.runtime.state().promotions).toHaveLength(1);
			expect(f.runtime.state().activity.filter((e) => e.kind === "source_promoted")).toHaveLength(1);
			expect(f.w.state.reservations.filter((r) => r.id === "human:exact-promotion")).toHaveLength(1);
			expect(f.w.state.reservations.at(-1)?.state).toBe("complete");
		} finally {
			await f.remote.close();
		}
	});
	it.each(["confirmed", "complete"])("recovers a persistence failure at %s", async (phase) => {
		const f = await prepared();
		try {
			const put = f.store.put.bind(f.store);
			let interrupted = false;
			vi.spyOn(f.store, "put").mockImplementation((key, value) => {
				const promotion = (value as import("../../src/shared/platform.ts").RepositoryState).promotions?.[0];
				if (
					!interrupted &&
					key === "repository" &&
					(phase === "complete" ? promotion?.state === "complete" : promotion?.operation?.phase === "confirmed")
				) {
					interrupted = true;
					throw new Error("interrupted persistence");
				}
				put(key, value);
			});
			await expect(f.run()).rejects.toThrow("interrupted persistence");
			expect(f.remote.head()).toBe(f.candidate);
			expect(f.runtime.state().sourceHead).toBe(f.base);
			await f.run(f.restart());
			expect(f.remote.updates).toBe(1);
			expect(f.runtime.state().promotions[0].state).toBe("complete");
		} finally {
			await f.remote.close();
		}
	});
	it("persists provenance before settlement and repairs only settlement on retry", async () => {
		const f = await prepared();
		try {
			vi.spyOn(f.port, "settle").mockImplementationOnce(() => {
				throw new Error("settlement interrupted");
			});
			await expect(f.run()).rejects.toThrow("settlement interrupted");
			expect(f.runtime.state().promotions[0].state).toBe("complete");
			expect(f.runtime.state().sourceHead).toBe(f.candidate);
			await f.run(f.restart());
			expect(f.remote.updates).toBe(1);
			expect(f.w.state.reservations.at(-1)?.state).toBe("complete");
		} finally {
			await f.remote.close();
		}
	});
	it("serializes concurrent promotions and rejects reused operation inputs", async () => {
		const f = await prepared();
		try {
			const competing = (await f.call("create_proposal", { artifactId: f.proposal.artifactId, title: "Competing promotion" })) as Proposal;
			await f.call(
				"review_proposal",
				{ proposalId: competing.id, revision: f.candidate, outcome: "approve", reason: "Exact source inspected" },
				{ actor: owner },
			);
			const results = await Promise.allSettled([
				f.run(),
				f.runtime.command({ ...f.cmd, proposalId: competing.id, idempotencyKey: "competing" }, { actor: owner }),
			]);
			expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
			await expect(f.runtime.command({ ...f.cmd, proposalId: "changed" }, { actor: owner })).rejects.toThrow("identity reused");
			expect(f.remote.updates).toBe(1);
		} finally {
			await f.remote.close();
		}
	});
	it("rechecks revoked authority on uncertain and completed retries", async () => {
		const f = await prepared();
		try {
			f.remote.afterUpdate = () => {
				throw new Error("lost response");
			};
			await expect(f.run()).rejects.toThrow();
			const authority = vi.spyOn(f.port, "authority").mockImplementation(() => {
				throw new Error("revoked");
			});
			await expect(f.run(f.restart())).rejects.toThrow("revoked");
			expect(f.runtime.state().sourceHead).toBe(f.base);
			authority.mockRestore();
			await f.run(f.restart());
			vi.spyOn(f.port, "authority").mockImplementation(() => {
				throw new Error("revoked");
			});
			await expect(f.run(f.restart())).rejects.toThrow("revoked");
			expect(f.remote.updates).toBe(1);
		} finally {
			await f.remote.close();
		}
	});
	it("does not adopt unrelated remote history while reconciling an interrupted update", async () => {
		const f = await prepared();
		try {
			f.remote.afterUpdate = () => {
				throw new Error("lost response");
			};
			await expect(f.run()).rejects.toThrow();
			f.remote.setHead(f.middle);
			await expect(f.run(f.restart())).rejects.toThrow("outcome differs");
			expect(f.remote.updates).toBe(1);
			expect(f.runtime.state().sourceHead).toBe(f.base);
			expect(f.runtime.state().proposals[0].state).toBe("rejected");
			expect(f.w.state.reservations.at(-1)?.state).toBe("uncertain");
		} finally {
			await f.remote.close();
		}
	});
	it("fails closed on missing source", async () => {
		const f = await prepared();
		try {
			vi.spyOn(f.git, "exportPack").mockRejectedValueOnce(new Error("Missing source"));
			await expect(f.run()).rejects.toThrow("Missing source");
			expect(f.remote.updates).toBe(0);
			expect(f.runtime.state().sourceHead).toBe(f.base);
		} finally {
			await f.remote.close();
		}
	});
	it("rechecks source and authority while resuming an uncertain operation", async () => {
		const f = await prepared();
		try {
			f.remote.afterUpdate = () => {
				throw new Error("lost response");
			};
			await expect(f.run()).rejects.toThrow();
			vi.spyOn(f.git, "exportPack").mockRejectedValueOnce(new Error("Missing retained source"));
			await expect(f.run(f.restart())).rejects.toThrow("Missing retained source");
			expect(f.runtime.state().sourceHead).toBe(f.base);
			expect(f.remote.updates).toBe(1);
			expect(f.w.state.reservations.at(-1)?.state).toBe("uncertain");
		} finally {
			await f.remote.close();
		}
	});
	it("refuses canonical provider identity replacement", async () => {
		const f = await prepared();
		try {
			vi.mocked(f.host.info).mockResolvedValue({ name: repo.storageName!, id: "replacement", remote: f.remote.url });
			await expect(f.run()).rejects.toThrow("identity changed");
			expect(f.remote.updates).toBe(0);
			expect(f.runtime.state().sourceHead).toBe(f.base);
		} finally {
			await f.remote.close();
		}
	});
	it("rechecks authority immediately before sending the approved update", async () => {
		const f = await prepared();
		try {
			f.remote.beforeAdvertisement = () => {
				vi.spyOn(f.port, "authority").mockImplementation(() => {
					throw new Error("revoked before update");
				});
			};
			await expect(f.run()).rejects.toThrow("revoked before update");
			expect(f.remote.updates).toBe(0);
			expect(f.runtime.state().sourceHead).toBe(f.base);
		} finally {
			await f.remote.close();
		}
	});
});
