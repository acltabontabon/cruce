import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/core/errors.ts";
import { initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { STATE_LIMITS } from "../../src/shared/limits.ts";
import type { Actor, ArchiveBundle, Command, Proposal, Repository, RepositorySnapshot, Workspace } from "../../src/shared/platform.ts";
import { type RepositoryHost, ResourceBoundary } from "../../src/worker/artifacts.ts";
import { diagnosticId } from "../../src/worker/diagnostics.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { RepositoryRuntime } from "../../src/worker/repository-runtime.ts";
import { memoryStore, type Store } from "../../src/worker/store.ts";
import { gitServer } from "../git/http-fixture.ts";
import { nativeRepository } from "../git/native-fixture.ts";

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
/** Hot and archived workspaces: finished work leaves hot state once its fork is gone. */
function everyWorkspace(runtime: RepositoryRuntime, store: Store) {
	return [...runtime.state().workspaces, ...store.scan<ArchiveBundle>("archive:").map(({ value }) => value.workspace)];
}
function memory(): Store {
	const map = new Map<string, unknown>();
	return {
		...memoryStore(map),
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
			resourceConfiguration: () => ({ namespace: "namespace", binding: undefined, legacyAccount: false, policy: w.state.policy }),
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
	it("repairs fork-attachment settlement from its saved receipt without another fork or push", async () => {
		const f = await fixture();
		const workspace = (await f.call("start_workspace", { title: "Attachment", baseRevision: f.base })) as Workspace;
		const fields = {
			workspaceId: workspace.id,
			execution: { id: workspace.id, checkoutId: "new-checkout", machineId: "machine", kind: "worktree" as const, owned: true },
			idempotencyKey: "attach-settlement",
		};
		const settle = f.port.settle;
		let fail = true;
		vi.spyOn(f.port, "settle").mockImplementation((id, state) => {
			if (state === "complete" && fail) {
				fail = false;
				throw new Error("settlement lost");
			}
			settle(id, state);
		});
		await expect(f.call("attach_workspace", fields)).rejects.toThrow("settlement lost");
		expect(f.runtime.state().workspaces.find((w) => w.id === workspace.id)?.fork?.state).toBe("ready");
		vi.mocked(f.host.fork).mockClear();
		f.push.mockClear();
		f.git.resetCache();
		await new RepositoryRuntime(f.store, f.git, f.port, {}, () => 2000).command(
			{ tool: "attach_workspace", namespaceId: repo.namespaceId, repositoryId: repo.id, ...fields },
			grant,
		);
		expect(f.host.fork).not.toHaveBeenCalled();
		expect(f.push).not.toHaveBeenCalled();
	});
	it.each(["publish_revision", "publish_artifact"])(
		"saves %s before settlement and repairs a lost settlement without provider I/O",
		async (tool) => {
			const f = await fixture();
			const fields = {
				workspaceId: f.workspace.id,
				revision: tool === "publish_revision" ? f.head : f.base,
				idempotencyKey: "settlement-loss",
				...(tool === "publish_revision" ? { pack: f.pack } : { content: "report" }),
			};
			const original = f.port.settle;
			let fail = true;
			vi.spyOn(f.port, "settle").mockImplementation((id, state) => {
				if (state === "complete" && fail) {
					fail = false;
					throw new Error("settlement response lost");
				}
				original(id, state);
			});
			await expect(f.call(tool, fields)).rejects.toThrow("settlement response lost");
			expect(f.runtime.state().artifacts).toHaveLength(1);
			const saved = f.runtime.state().artifacts[0];
			f.git.resetCache();
			f.push.mockClear();
			vi.mocked(f.host.info).mockClear();
			vi.mocked(f.host.ensure).mockClear();
			const { pack: _, ...commandFields } = fields as typeof fields & { pack?: string };
			const later = new RepositoryRuntime(f.store, f.git, f.port, {}, () => 5000);
			expect(
				await later.command(
					{
						tool,
						namespaceId: repo.namespaceId,
						repositoryId: repo.id,
						...commandFields,
						...(tool === "publish_revision" ? { ref: "work" } : {}),
					},
					grant,
				),
			).toEqual(saved);
			expect(f.push).not.toHaveBeenCalled();
			expect(f.host.info).not.toHaveBeenCalled();
			expect(f.host.ensure).not.toHaveBeenCalled();
			expect(f.w.state.reservations.filter((r) => r.id.endsWith(":settlement-loss"))).toHaveLength(1);
			expect(f.w.state.reservations.find((r) => r.id.endsWith(":settlement-loss"))?.state).toBe("complete");
			await expect(
				later.command(
					{
						tool,
						namespaceId: repo.namespaceId,
						repositoryId: repo.id,
						...commandFields,
						...(tool === "publish_revision" ? { ref: "work" } : {}),
					},
					{ ...grant, scopes: ["cruce:read"] },
				),
			).rejects.toThrow("capability denied");
		},
	);
	it.each(["publish_revision", "publish_artifact"])(
		"recovers retained %s after a save failure, workspace end and cache loss",
		async (tool) => {
			const f = await fixture();
			const original = f.store.batch.bind(f.store);
			let fail = true;
			vi.spyOn(f.store, "batch").mockImplementation((entries, deletes) => {
				if (
					fail &&
					entries.some((entry) => entry.key.startsWith("receipt:") && (entry.value as { result?: { kind?: string } }).result?.kind)
				) {
					fail = false;
					throw new Error("durable save interrupted");
				}
				original(entries, deletes);
			});
			const fields = {
				workspaceId: f.workspace.id,
				revision: tool === "publish_revision" ? f.head : f.base,
				idempotencyKey: "save-loss",
				...(tool === "publish_revision" ? { pack: f.pack } : { content: "report" }),
			};
			f.push.mockClear();
			await expect(f.call(tool, fields)).rejects.toThrow("save interrupted");
			expect(f.runtime.state().artifacts).toHaveLength(0);
			expect(f.w.state.reservations.find((r) => r.id.endsWith(":save-loss"))?.state).toBe("uncertain");
			let newer: string | undefined;
			if (tool === "publish_revision") {
				newer = await f.git.commit({
					ref: "refs/heads/newer",
					parent: f.head,
					files: { "next.txt": "newer" },
					message: "Newer",
					author: { name: "Fixture", email: "f@example.com", timestamp: 12346 },
				});
				await f.call(tool, {
					workspaceId: f.workspace.id,
					revision: newer,
					pack: Buffer.from(await f.git.exportPack(newer)).toString("base64"),
				});
			}
			await f.call("end_workspace", { workspaceId: f.workspace.id });
			f.git.resetCache();
			f.push.mockClear();
			const { pack: _, ...commandFields } = fields as typeof fields & { pack?: string };
			const later = new RepositoryRuntime(f.store, f.git, f.port, {}, () => 5000);
			const artifact = (await later.command(
				{
					tool,
					namespaceId: repo.namespaceId,
					repositoryId: repo.id,
					...commandFields,
					...(tool === "publish_revision" ? { ref: "work" } : {}),
				},
				grant,
			)) as { at: number; revision: string };
			expect(artifact).toMatchObject({ at: 1000, revision: fields.revision });
			expect(f.push).not.toHaveBeenCalled();
			expect(
				later
					.state()
					.artifacts.filter((a) => a.revision === fields.revision && a.kind === (tool === "publish_revision" ? "source" : "evidence")),
			).toHaveLength(1);
			if (newer) expect(later.state().workspaces[0].publishedRevision).toBe(newer);
		},
	);
	it("reconciles an attempted exact retention write after the workspace ends, and refuses a different retained revision", async () => {
		const f = await fixture();
		const fields = { workspaceId: f.workspace.id, revision: f.base, content: "report", idempotencyKey: "retention-loss" };
		f.push.mockRejectedValueOnce(new Error("retention reply lost"));
		await expect(f.call("publish_artifact", fields)).rejects.toThrow("reply lost");
		const storage = f.push.mock.calls.at(-1)![0],
			oid = await f.git.resolve(storage.localRef);
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: storage.remoteRef, oid: "f".repeat(40) }]);
		await expect(f.call("publish_artifact", fields)).rejects.toThrow("differs from its exact revision");
		vi.mocked(f.git.remoteRefs).mockResolvedValue([{ ref: storage.remoteRef, oid: oid! }]);
		f.git.resetCache();
		f.push.mockClear();
		await f.call("publish_artifact", fields);
		expect(f.push).not.toHaveBeenCalled();
		expect(f.runtime.state().artifacts).toHaveLength(1);
	});
	it("enforces protected paths for a native mode-only commit", async () => {
		const f = await fixture();
		const native = await nativeRepository(await f.git.exportPack(f.base), f.base);
		try {
			native.run(["update-index", "--chmod=+x", "src/pay.ts"]);
			native.run(["commit", "-qm", "Mode only"]);
			const head = native.run(["rev-parse", "HEAD"]);
			f.w.member(f.w.authority(owner), "dev", "developer");
			f.w.state.repositories[0].grants = [{ subject: "user", id: "dev", role: "write" }];
			f.w.state.repositories[0].policy.protectedPaths = ["src"];
			const dev = { ...grant, actor: { ...agent, id: "dev-agent", userId: "dev" } };
			const s = (await f.call("start_workspace", { title: "Mode", baseRevision: f.base }, dev)) as Workspace;
			await f.call(
				"attach_workspace",
				{ workspaceId: s.id, execution: { id: s.id, checkoutId: "mode-checkout", machineId: "m", kind: "worktree", owned: true } },
				dev,
			);
			await expect(
				f.call("publish_revision", { workspaceId: s.id, revision: head, pack: native.pack(head).toString("base64") }, dev),
			).rejects.toThrow("Protected paths");
			expect(f.runtime.state().artifacts).toHaveLength(0);
		} finally {
			await native.close();
		}
	});
	it("correlates an uncertain evidence publication across restart without logging content or operation keys", async () => {
		const f = await fixture();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const secret = "private-oauth-token-and-source";
		const cmd: Command = {
			tool: "publish_artifact",
			namespaceId: repo.namespaceId,
			repositoryId: repo.id,
			workspaceId: f.workspace.id,
			revision: f.base,
			idempotencyKey: secret,
			content: secret,
			title: secret,
		};
		vi.mocked(f.host.ensure).mockRejectedValueOnce(Object.assign(new Error(secret), { name: secret }));
		await expect(f.runtime.command(cmd, grant)).rejects.toThrow(secret);
		const restart = new RepositoryRuntime(f.store, f.git, f.port, {}, () => 1001);
		await restart.command(cmd, grant);
		// A completed replay keeps the same correlation without repeating provider work.
		await new RepositoryRuntime(f.store, f.git, f.port, {}, () => 1002).command(cmd, grant);
		const reservation = f.w.state.reservations.find((r) => r.id === `${agent.id}:${secret}`)!;
		expect(reservation.state).toBe("complete");
		expect(f.w.state.reservations.filter((r) => r.id === reservation.id)).toHaveLength(1);
		const records = log.mock.calls.map(([value]) => JSON.parse(value));
		const settled = records.filter((r) => r.event === "resource_settled");
		expect(settled.map((r) => r.phase)).toEqual(["uncertain", "complete"]);
		const replayed = records.filter((r) => r.event === "operation_replayed");
		expect(replayed).toHaveLength(1);
		const outcomes = records.filter((r) => ["operation_completed", "operation_failed"].includes(r.event));
		expect(outcomes.map((r) => r.event)).toEqual(["operation_failed", "operation_completed", "operation_completed"]);
		for (const record of outcomes) expect(record.durationMs).toEqual(expect.any(Number));
		for (const record of [...settled, ...replayed])
			expect(record).toMatchObject({
				namespaceId: await diagnosticId("namespaceId", repo.namespaceId),
				repositoryId: await diagnosticId("repositoryId", repo.id),
				workspaceId: await diagnosticId("workspaceId", f.workspace.id),
				revision: await diagnosticId("revision", f.base),
				operationId: await diagnosticId("operationId", reservation.id),
				reservationId: await diagnosticId("reservationId", reservation.id),
			});
		expect(records.some((r) => r.event === "operation_failed" && r.status === 500)).toBe(true);
		expect(JSON.stringify(records)).not.toContain(secret);
	});
	it("reconstructs the same pending evidence commit after cache loss and a later retry", async () => {
		const f = await fixture();
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([]);
		const fields = { workspaceId: f.workspace.id, revision: f.base, content: "test report", idempotencyKey: "pending-evidence" };
		f.push.mockRejectedValueOnce(new Error("retention response lost"));
		await expect(f.call("publish_artifact", fields)).rejects.toThrow("response lost");
		const ref = f.push.mock.calls.at(-1)![0].localRef;
		const original = await f.git.resolve(ref);
		f.git.resetCache();
		const later = new RepositoryRuntime(f.store, f.git, f.port, {}, () => 50_000);
		const artifact = (await later.command(
			{ tool: "publish_artifact", namespaceId: repo.namespaceId, repositoryId: repo.id, ...fields },
			grant,
		)) as { storage: { revision: string } };
		expect(artifact.storage.revision).toBe(original);
		expect(f.w.state.reservations.filter((r) => r.action === "artifact.publish")).toHaveLength(1);
	});
	it("keeps provider inspection behind explicit identity, scope, policy and retry reservations", async () => {
		const f = await fixture();
		const source = {
			log: vi.fn(async () => [{ hash: f.base }]),
			readCommit: vi.fn(async () => ({ hash: f.base, parents: [], treeHash: f.base })),
			readFile: vi.fn(async () => new Blob(["stored source"])),
		};
		f.host.withSource = vi.fn(async (_name, _id, run) => run(source as never));
		const before = structuredClone(f.runtime.state());
		const fields = { sourceView: "files" as const, revision: f.base, path: "README.md", idempotencyKey: "inspect-stored" };
		expect(await f.call("inspect_source", fields)).toMatchObject({ file: { content: "stored source" } });
		expect(await f.call("inspect_source", fields)).toMatchObject({ file: { content: "stored source" } });
		expect(f.runtime.state()).toEqual(before);
		expect(f.w.state.reservations.filter((r) => r.action === "source.read")).toHaveLength(1);
		const calls = vi.mocked(f.host.withSource).mock.calls.length;
		f.w.state.policy.rules["source.read"] = "deny";
		await expect(f.call("inspect_source", fields)).rejects.toThrow("policy denies");
		expect(f.host.withSource).toHaveBeenCalledTimes(calls);
		await expect(f.call("inspect_source", fields, { ...grant, scopes: [] })).rejects.toThrow("authorized");
		await expect(f.call("inspect_source", { ...fields, idempotencyKey: undefined })).rejects.toThrow("idempotency key");
	});
	/** Answers each retained ref with its recorded tip, as the provider would. */
	function retainedReader(f: Awaited<ReturnType<typeof fixture>>, content = "stored source") {
		const parents: Record<string, string[]> = { [f.head]: [f.base], [f.base]: [] };
		const tip = (ref: string) => {
			const state = f.runtime.state();
			if (ref === `refs/heads/${repo.defaultBranch}`) return state.sourceHead;
			return state.artifacts.find((a) => a.storage.ref === ref)?.storage.revision;
		};
		const source = {
			log: vi.fn(async ({ ref }: { ref: string }) => [{ hash: tip(ref) }]),
			readCommit: vi.fn(async (oid: string) => ({ hash: oid, parents: parents[oid] ?? [], treeHash: oid })),
			readFile: vi.fn(async () => new Blob([content])),
		};
		f.host.withSource = vi.fn(async (_name, _id, run) => run(source as never));
		return source;
	}
	it("recovers exact retained source through the gated tool after cache loss, with one reservation per retry", async () => {
		const f = await fixture();
		await f.call("publish_revision", { workspaceId: f.workspace.id, revision: f.head, pack: f.pack });
		retainedReader(f);
		const pack = await f.git.exportPack(f.head);
		const recover = vi.spyOn(f.git, "recover").mockImplementation(async () => {
			await f.git.importPack(pack);
		});
		f.git.resetCache();
		await expect(f.call("get_source", { revision: f.head })).rejects.toThrow("explicitly recover");
		const fields = { revision: f.head, idempotencyKey: "recover-head" };
		expect(await f.call("recover_source", fields)).toEqual({ revision: f.head, recovered: true });
		expect(await f.call("recover_source", fields)).toEqual({ revision: f.head, recovered: true });
		expect(recover).toHaveBeenCalledTimes(1);
		expect(f.w.state.reservations.filter((r) => r.action === "source.read")).toHaveLength(1);
		expect(await f.call("get_source", { revision: f.head, path: "src/pay.ts" })).toMatchObject({
			files: { "src/pay.ts": "export const retry=3;" },
		});
		f.git.resetCache();
		const calls = vi.mocked(f.host.withSource!).mock.calls.length;
		f.w.state.policy.rules["source.read"] = "deny";
		await expect(f.call("recover_source", { revision: f.head, idempotencyKey: "denied" })).rejects.toThrow("policy denies");
		await expect(f.call("recover_source", { revision: f.head, idempotencyKey: "unscoped" }, { ...grant, scopes: [] })).rejects.toThrow(
			"authorized",
		);
		expect(f.host.withSource).toHaveBeenCalledTimes(calls);
		expect(recover).toHaveBeenCalledTimes(1);
	});
	it("inspects retained evidence and exact diffs, and points cache-only evidence reads to explicit inspection", async () => {
		const f = await fixture();
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([]);
		const evidence = (await f.call("publish_artifact", { workspaceId: f.workspace.id, revision: f.base, content: "test report" })) as {
			id: string;
			storage: { revision: string };
		};
		expect(await f.call("read_artifact", { artifactId: evidence.id })).toMatchObject({ content: "test report" });
		retainedReader(f, "test report");
		const view = { sourceView: "artifact" as const, artifactId: evidence.id, idempotencyKey: "inspect-evidence" };
		expect(await f.call("inspect_source", view)).toMatchObject({ artifact: { id: evidence.id }, content: "test report" });
		await f.call("publish_revision", { workspaceId: f.workspace.id, revision: f.head, pack: f.pack });
		const diff = (await f.call("inspect_source", {
			sourceView: "diff",
			revision: f.head,
			baseRevision: f.base,
			idempotencyKey: "inspect-diff",
		})) as { files: { path: string }[] };
		expect(diff.files.map((file) => file.path)).toEqual(["src/pay.ts"]);
		const before = structuredClone(f.runtime.state());
		f.git.resetCache();
		await expect(f.call("read_artifact", { artifactId: evidence.id })).rejects.toThrow(
			"Artifact cache unavailable; inspect the retained artifact source",
		);
		expect(f.runtime.state()).toEqual(before);
		expect(await f.call("inspect_source", { ...view, idempotencyKey: "inspect-evidence-again" })).toMatchObject({
			content: "test report",
		});
	});
	it("recovers a missing baseline from retained source before forking an attached workspace", async () => {
		const f = await fixture();
		retainedReader(f);
		const pack = await f.git.exportPack(f.base);
		const recover = vi.spyOn(f.git, "recover").mockImplementation(async () => {
			await f.git.importPack(pack);
		});
		const s = (await f.call("start_workspace", { title: "Continue later", baseRevision: f.base })) as Workspace;
		f.git.resetCache();
		const forks = vi.mocked(f.host.fork).mock.calls.length;
		await f.call("attach_workspace", {
			workspaceId: s.id,
			execution: { id: s.id, checkoutId: "second", machineId: "machine", kind: "worktree", owned: true },
		});
		expect(recover).toHaveBeenCalledTimes(1);
		expect(f.host.fork).toHaveBeenCalledTimes(forks + 1);
		expect(f.runtime.state().workspaces.find((w) => w.id === s.id)?.fork).toBeDefined();
	});
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
		expect(everyWorkspace(f.runtime, f.store).find((w) => w.id === f.workspace.id)?.baseRevision).toBe(f.base);
	});
	it("reserves bounded baseline recovery but rejects unavailable source before provisioning a fork", async () => {
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
		expect(f.w.state.reservations).toHaveLength(reservations + 1);
		expect(f.w.state.reservations.at(-1)?.state).toBe("uncertain");
	});
	it("pins a reconciled publication's review base across uncertain push retries even as upstream advances", async () => {
		const f = await fixture();
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([]);
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
		expect(everyWorkspace(f.runtime, f.store).find((w) => w.id === f.workspace.id)?.baseRevision).toBe(f.base);
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
	it("compares canonical files against the exact observed revision without accepting it", async () => {
		const f = await fixture();
		const observed = await f.git.commit({
			ref: "refs/heads/external",
			parent: f.base,
			files: { "external.txt": "remote change" },
			message: "External movement",
			author: { name: "Other", email: "other@local", timestamp: 12346 },
		});
		const state = f.runtime.state();
		state.observedCanonical = {
			providerId: "canonical",
			ref: "refs/heads/trunk",
			revision: observed,
			deleted: false,
			checkedAt: 1000,
			generation: 1,
		};
		f.store.put("repository", state);
		expect(await f.call("get_workspace_updates", { workspaceId: f.workspace.id })).toMatchObject({
			revision: observed,
			trust: "observed",
			comparison: "behind",
			available: true,
			basis: "baseline",
			changes: [{ path: "external.txt", status: "added" }],
		});
		expect(f.runtime.state().sourceHead).toBe(f.base);
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
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([]);
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

describe("repository setup recovery", () => {
	const human = { actor: owner, scopes: [], repositories: [repo.id] };
	async function unprovisioned() {
		const f = await fixture();
		const state = f.runtime.state();
		delete state.canonical;
		delete state.sourceHead;
		f.store.put("repository", state);
		vi.spyOn(f.git, "fetch").mockResolvedValue(f.base as never);
		const setup = (tool: string, key: string, g: typeof grant | typeof human = human) =>
			f.runtime.command({ tool, namespaceId: repo.namespaceId, repositoryId: repo.id, idempotencyKey: key }, g);
		const creations = () => f.w.state.reservations.filter((r) => r.action === "repository.create");
		return { ...f, setup, creations };
	}
	it("shows unfinished setup settlement and finishes it without provisioning again", async () => {
		const f = await unprovisioned();
		const settle = f.port.settle;
		let fail = true;
		vi.spyOn(f.port, "settle").mockImplementation((id, state) => {
			if (state === "complete" && fail) {
				fail = false;
				throw new Error("setup settlement lost");
			}
			settle(id, state);
		});
		await expect(f.setup("provision_repository", "setup-loss")).rejects.toThrow("settlement lost");
		expect(((await f.setup("get_repository", "", human)) as RepositorySnapshot).canonicalSetup).toEqual({
			required: false,
			retry: true,
			settlementPending: true,
		});
		vi.mocked(f.host.ensure).mockClear();
		f.push.mockClear();
		f.git.resetCache();
		await f.setup("retry_repository_setup", "retry");
		expect(f.host.ensure).not.toHaveBeenCalled();
		expect(f.push).not.toHaveBeenCalled();
		expect(f.creations()).toMatchObject([{ state: "complete" }]);
	});
	it("retries a failed creation with its original operation and reservation, then refuses once canonical exists", async () => {
		const f = await unprovisioned();
		vi.mocked(f.host.ensure!).mockRejectedValueOnce(new Error("Cloudflare API: Authentication error"));
		await expect(f.setup("provision_repository", "create-dialog-key")).rejects.toThrow("Authentication error");
		expect(f.creations()).toMatchObject([{ state: "uncertain" }]);
		const view = (await f.setup("get_repository", "", human)) as RepositorySnapshot;
		expect(view.canonicalSetup).toEqual({ required: true, retry: true });
		expect(((await f.setup("get_repository", "", grant)) as RepositorySnapshot).canonicalSetup).toEqual({ required: true, retry: false });
		await expect(f.setup("retry_repository_setup", "retry", grant)).rejects.toThrow("capability denied");
		await f.setup("retry_repository_setup", "console-retry");
		expect(f.runtime.state()).toMatchObject({ sourceHead: f.base, canonical: { name: repo.storageName } });
		expect(f.creations()).toMatchObject([{ state: "complete" }]);
		expect(((await f.setup("get_repository", "", human)) as RepositorySnapshot).canonicalSetup).toEqual({ required: false, retry: false });
		await expect(f.setup("retry_repository_setup", "again")).rejects.toThrow("already set up");
	});
	it("recovers repositories created before setup intent was recorded with one stable operation", async () => {
		const f = await unprovisioned();
		await f.setup("retry_repository_setup", "first-click");
		expect(f.runtime.state().sourceHead).toBe(f.base);
		expect(f.creations()).toHaveLength(1);
		expect(f.creations()[0].id).toBe(`${owner.id}:provision-${repo.id}`);
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
		vi.mocked(f.host.info).mockImplementation(async (name) => ({ name, id: name, remote: remote.url }));
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
	it.each([false, true])("recovers retained source after cache loss before promotion (interrupted: %s)", async (interrupted) => {
		const f = await prepared();
		try {
			const independent = new GitWorkspace(new MemoryFs() as never);
			await independent.ensureInit();
			await independent.importPack(await f.git.exportPack(f.candidate));
			const artifact = f.runtime.state().artifacts.find((a) => a.id === f.proposal.artifactId)!;
			f.remote.setRef(artifact.storage.ref!, f.candidate);
			const metadata = async (oid: string) => {
				const c = (await independent.log(oid, 1))[0];
				return c
					? {
							hash: oid,
							treeHash: f.base,
							message: c.message,
							parents: c.parents,
							authoredAt: c.at,
							committedAt: c.at,
							author: { name: c.author, email: "fixture@local" },
							committer: { name: c.author, email: "fixture@local" },
						}
					: null;
			};
			f.host.withSource = vi.fn(async (_name, _id, run) =>
				run({ readCommit: metadata, log: async () => [await metadata(f.candidate)!] } as never),
			);
			if (interrupted) {
				f.remote.afterUpdate = () => {
					throw new Error("lost successful response");
				};
				await expect(f.run()).rejects.toThrow();
				f.remote.afterUpdate = () => {};
			}
			f.git.resetCache();
			await expect(f.call("get_source", { revision: f.candidate })).rejects.toThrow("explicitly recover");
			expect(await f.run(f.restart())).toMatchObject({ state: "complete", from: f.base, to: f.candidate });
			expect(f.remote.head()).toBe(f.candidate);
			expect(f.remote.updates).toBe(1);
			expect(f.host.fork).toHaveBeenCalledTimes(1);
		} finally {
			await f.remote.close();
		}
	});
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
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
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
			const records = log.mock.calls.map(([value]) => JSON.parse(value));
			const phases = records.filter((r) => r.event === "promotion_phase");
			expect(phases.map((r) => r.phase)).toEqual(["prepared", "attempted", "uncertain", "attempted", "complete"]);
			for (const record of phases)
				expect(record).toMatchObject({
					namespaceId: await diagnosticId("namespaceId", repo.namespaceId),
					repositoryId: await diagnosticId("repositoryId", repo.id),
					workspaceId: await diagnosticId("workspaceId", f.workspace.id),
					proposalId: await diagnosticId("proposalId", f.proposal.id),
					promotionId: await diagnosticId("promotionId", f.runtime.state().promotions[0].id),
					revision: await diagnosticId("revision", f.candidate),
					operationId: await diagnosticId("operationId", "human:exact-promotion"),
					reservationId: await diagnosticId("reservationId", "human:exact-promotion"),
				});
			expect(records.some((r) => r.event === "operation_replayed" && r.phase === "complete")).toBe(true);
			for (const value of ["response lost after ref update", "exact-promotion", "Keep retries bounded", f.candidate])
				expect(JSON.stringify(records)).not.toContain(value);
			expect(f.w.state.reservations.at(-1)?.state).toBe("complete");
		} finally {
			await f.remote.close();
		}
	});
	it.each(["confirmed", "complete"])("recovers a persistence failure at %s", async (phase) => {
		const f = await prepared();
		try {
			const batch = f.store.batch.bind(f.store);
			let interrupted = false;
			vi.spyOn(f.store, "batch").mockImplementation((entries, deletes) => {
				const value = entries.find((entry) => entry.key === "repository")?.value;
				const promotion = (value as import("../../src/shared/platform.ts").RepositoryState | undefined)?.promotions?.[0];
				if (
					!interrupted &&
					value &&
					(phase === "complete" ? promotion?.state === "complete" : promotion?.operation?.phase === "confirmed")
				) {
					interrupted = true;
					throw new Error("interrupted persistence");
				}
				batch(entries, deletes);
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
	it.each(["canonical", "retention"])("preserves an attempted promotion through %s identity mismatch and restoration", async (kind) => {
		const f = await prepared();
		try {
			f.remote.afterUpdate = () => {
				throw new Error("lost response");
			};
			await expect(f.run()).rejects.toThrow();
			const pending = structuredClone(f.runtime.state().promotions[0]);
			const reservationIds = f.w.state.reservations.map((r) => r.id);
			const target = kind === "canonical" ? repo.storageName! : "repo-repo-artifacts";
			vi.mocked(f.host.info).mockImplementation(async (name) => ({
				name,
				id: name === target ? "replacement" : name,
				remote: f.remote.url,
			}));
			const token = vi.spyOn(f.host, "withToken");
			await expect(f.run(f.restart())).rejects.toThrow("identity changed");
			expect(token).not.toHaveBeenCalled();
			expect(f.runtime.state().promotions[0]).toEqual(pending);
			expect(f.runtime.state().proposals[0].state).toBe("promoting");
			expect(f.runtime.state().sourceHead).toBe(f.base);
			expect(f.remote.updates).toBe(1);
			vi.mocked(f.host.info).mockImplementation(async (name) => ({ name, id: name, remote: f.remote.url }));
			expect(await f.run(f.restart())).toMatchObject({ state: "complete", from: f.base, to: f.candidate });
			expect(f.remote.updates).toBe(1);
			expect(f.w.state.reservations.map((r) => r.id)).toEqual(reservationIds);
			expect(f.runtime.state().activity.filter((e) => e.kind === "source_promoted")).toHaveLength(1);
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
	it.each(["same", "unrelated"])("refuses a non-forward update from a %s base before contacting canonical", async (kind) => {
		const f = await prepared();
		try {
			const base =
				kind === "same"
					? f.candidate
					: await f.git.commit({
							ref: "refs/heads/unrelated",
							parent: null,
							files: { other: "history" },
							message: "Unrelated root",
							author: { name: "Fixture", email: "fixture@local", timestamp: 12348 },
						});
			const state = f.runtime.state();
			state.proposals.find((p) => p.id === f.proposal.id)!.base = base;
			state.artifacts.find((a) => a.id === f.proposal.artifactId)!.baseRevision = base;
			state.sourceHead = base;
			f.store.put("repository", state);
			await expect(f.run()).rejects.toThrow("Promotion requires a non-forced forward update");
			expect(f.remote.updates).toBe(0);
			expect(f.remote.head()).toBe(f.base);
			expect(f.runtime.state().promotions[0].state).toBe("failed");
		} finally {
			await f.remote.close();
		}
	});
	it.each(["evidence", "policy"])("completes a landed update although later %s would block a new promotion", async (change) => {
		const f = await prepared();
		try {
			f.remote.afterUpdate = () => {
				throw new Error("response lost after ref update");
			};
			await expect(f.run()).rejects.toThrow();
			f.remote.afterUpdate = () => {};
			expect(f.runtime.state().promotions[0]).toMatchObject({ state: "uncertain", operation: { phase: "attempted" } });
			const verification = {
				proposalId: f.proposal.id,
				revision: f.candidate,
				kind: "tests",
				outcome: "fail" as const,
				reason: "Failed after the update was sent",
			};
			// Evidence cannot be added to a change whose update may already be canonical.
			await expect(f.call("record_verification", verification)).rejects.toThrow("Verification requires an open change");
			if (change === "policy") f.w.state.repositories.find((r) => r.id === repo.id)!.policy.requiredEvidence = ["tests"];
			else {
				const state = f.runtime.state();
				state.verifications.push({
					id: "late",
					proposalId: f.proposal.id,
					revision: f.candidate,
					kind: "tests",
					outcome: "fail",
					trust: "reported",
					reason: "Recorded before the open-change check existed",
					actor: agent,
					at: 1000,
				} as never);
				state.repository.policy.requiredEvidence = ["tests"];
				f.store.put("repository", state);
				f.w.state.repositories.find((r) => r.id === repo.id)!.policy.requiredEvidence = ["tests"];
			}
			expect(await f.run(f.restart())).toMatchObject({ state: "complete", from: f.base, to: f.candidate });
			expect(f.remote.updates).toBe(1);
			expect(f.runtime.state().sourceHead).toBe(f.candidate);
			await expect(f.call("record_verification", verification)).rejects.toThrow("Verification requires an open change");
		} finally {
			await f.remote.close();
		}
	});
	it("fails an update journaled as attempted but never sent, without sending it on retry", async () => {
		const f = await prepared();
		try {
			const batch = f.store.batch.bind(f.store);
			let interrupted = false;
			vi.spyOn(f.store, "batch").mockImplementation((entries, deletes) => {
				batch(entries, deletes);
				const value = entries.find((entry) => entry.key === "repository")?.value as
					| import("../../src/shared/platform.ts").RepositoryState
					| undefined;
				if (!interrupted && value?.promotions?.[0]?.operation?.phase === "attempted") {
					interrupted = true;
					throw new Error("interrupted after journaling the attempt");
				}
			});
			await expect(f.run()).rejects.toThrow("interrupted after journaling");
			expect(f.remote.updates).toBe(0);
			expect(f.runtime.state().promotions[0]).toMatchObject({ state: "uncertain", operation: { phase: "attempted" } });
			await expect(f.run(f.restart())).rejects.toThrow("Promotion outcome differs from the exact candidate");
			expect(f.remote.updates).toBe(0);
			expect(f.runtime.state().promotions[0].state).toBe("failed");
			expect(f.runtime.state().proposals.find((p) => p.id === f.proposal.id)?.state).toBe("rejected");
			await expect(f.run(f.restart())).rejects.toThrow("Promotion failed");
			expect(f.remote.updates).toBe(0);
		} finally {
			await f.remote.close();
		}
	});
});

describe("authorized retention recovery (F6)", () => {
	it("records inspectable blockers without deleting, and never treats expiry as deletion authority", async () => {
		const f = await fixture();
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: "refs/heads/unpublished", oid: f.head }]);
		const result = (await f.call("inspect_retention", { workspaceId: f.workspace.id })) as { refs: unknown[]; blockers: string[] };
		expect(result).toMatchObject({ refs: [{ ref: "refs/heads/unpublished", revision: f.head, retained: false }] });
		expect(result.blockers).toContain("Unretained fork refs; publish their commits before cleanup");
		expect(f.host.remove).not.toHaveBeenCalled();
		const read = await f.call("get_retention", { workspaceId: f.workspace.id });
		expect(read).toMatchObject({ inspection: { refs: result.refs } });
		const state = structuredClone(f.runtime.state());
		const recovered = new RepositoryRuntime(f.store, f.git, f.port, {}, () => 10 ** 12, { schedule: vi.fn(), authorize: async (g) => g });
		await recovered.recoverCleanup();
		expect(f.runtime.state()).toEqual(state);
		expect(f.host.remove).not.toHaveBeenCalled();
	});
	it.each(["delete-response", "confirmed-save", "settlement"])("recovers %s after restart using the same reservation", async (fault) => {
		const f = await fixture();
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: "refs/heads/trunk", oid: f.base }]);
		let time = 1000,
			requests = 0,
			deleted = false;
		const schedule = vi.fn(async (_at: number) => {}),
			authorize = vi.fn(async (g: typeof grant) => g);
		vi.mocked(f.host.remove).mockImplementation(async () => {
			if (!deleted) {
				requests++;
				deleted = true;
				if (fault === "delete-response") throw new Error("Lost deletion response");
			}
			return true;
		});
		if (fault === "confirmed-save") {
			const batch = f.store.batch.bind(f.store);
			let interrupted = false;
			vi.spyOn(f.store, "batch").mockImplementation((entries, deletes) => {
				const operation = entries.find((entry) => entry.key === `cleanup:${f.workspace.id}`)?.value as { phase?: string } | undefined;
				if (!interrupted && operation?.phase === "confirmed") {
					interrupted = true;
					throw new Error("Lost confirmation persistence");
				}
				batch(entries, deletes);
			});
		}
		if (fault === "settlement") {
			const settle = f.port.settle;
			let interrupted = false;
			vi.spyOn(f.port, "settle").mockImplementation((id, state) => {
				if (!interrupted && state === "complete") {
					interrupted = true;
					throw new Error("Lost settlement");
				}
				settle(id, state);
			});
		}
		const cmd = {
			tool: "cleanup_workspace",
			namespaceId: repo.namespaceId,
			repositoryId: repo.id,
			workspaceId: f.workspace.id,
			idempotencyKey: "durable-cleanup",
		};
		let runtime = new RepositoryRuntime(f.store, f.git, f.port, {}, () => time, { schedule, authorize });
		await expect(runtime.command(cmd, grant)).rejects.toThrow();
		expect(schedule).toHaveBeenCalled();
		expect(runtime.state().workspaces[0].cleanup?.state).toBe("pending");
		time += 3_600_000;
		runtime = new RepositoryRuntime(f.store, f.git, f.port, {}, () => time, { schedule, authorize });
		await runtime.recoverCleanup();
		expect(requests).toBe(1);
		expect(everyWorkspace(runtime, f.store).find((w) => w.id === f.workspace.id)).toMatchObject({
			fork: { state: "deleted" },
			cleanup: { state: "complete", phase: "confirmed" },
		});
		expect(runtime.state().activity.filter((event) => event.kind === "fork_deleted")).toHaveLength(1);
		expect(f.w.state.reservations.filter((r) => r.action === "workspace.cleanup")).toHaveLength(1);
		expect(f.w.state.reservations.at(-1)?.state).toBe("complete");
		const calls = vi.mocked(f.host.remove).mock.calls.length;
		await runtime.recoverCleanup();
		expect(f.host.remove).toHaveBeenCalledTimes(calls);
	});
	it.each(["membership", "policy", "scope", "identity"])("blocks background recovery after %s changes", async (change) => {
		const f = await fixture();
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: "refs/heads/trunk", oid: f.base }]);
		vi.mocked(f.host.remove).mockResolvedValueOnce(false);
		let time = 1000;
		const authorize = async (g: typeof grant) => (change === "scope" && time > 1000 ? { ...g, scopes: ["cruce:read"] } : g);
		let runtime = new RepositoryRuntime(f.store, f.git, f.port, {}, () => time, { schedule: vi.fn(), authorize });
		await runtime.command(
			{
				tool: "cleanup_workspace",
				namespaceId: repo.namespaceId,
				repositoryId: repo.id,
				workspaceId: f.workspace.id,
				idempotencyKey: "bounded-cleanup",
			},
			grant,
		);
		if (change === "membership") delete f.w.state.members.owner;
		if (change === "policy") f.w.state.policy.rules["workspace.cleanup"] = "deny";
		if (change === "identity")
			vi.mocked(f.host.remove).mockRejectedValueOnce(
				new (await import("../../src/worker/provider-identity.ts")).ProviderIdentityError("Replacement provider repository"),
			);
		time += 3_600_000;
		runtime = new RepositoryRuntime(f.store, f.git, f.port, {}, () => time, { schedule: vi.fn(), authorize });
		await runtime.recoverCleanup();
		expect(runtime.state().workspaces[0].cleanup?.state).toBe("blocked");
		expect(runtime.state().workspaces[0].fork?.state).toBe("deleting");
		expect(f.w.state.reservations.at(-1)?.state).toBe("uncertain");
		expect(f.host.remove).toHaveBeenCalledTimes(change === "identity" ? 2 : 1);
	});
	it("bounds remote ref inspection and preserves the full inventory when refusing cleanup", async () => {
		const f = await fixture();
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue(Array.from({ length: 257 }, (_, n) => ({ ref: `refs/heads/${n}`, oid: f.base })));
		await expect(f.call("cleanup_workspace", { workspaceId: f.workspace.id })).rejects.toThrow("inventory exceeds");
		expect(f.runtime.state().workspaces[0].retention).toMatchObject({ complete: false, refs: [] });
		expect(f.host.remove).not.toHaveBeenCalled();
	});
	it("blocks cleanup while retention proof is unavailable from a lost cache", async () => {
		const f = await fixture();
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: "refs/heads/trunk", oid: f.base }]);
		f.git.resetCache();
		const result = (await f.call("inspect_retention", { workspaceId: f.workspace.id })) as { refs: unknown[]; blockers: string[] };
		expect(result.refs).toEqual([{ ref: "refs/heads/trunk", revision: f.base, retained: false, reason: "unavailable" }]);
		expect(result.blockers).toEqual(["Retention proof unavailable; recover or inspect source before cleanup"]);
		await expect(f.call("cleanup_workspace", { workspaceId: f.workspace.id, idempotencyKey: "unproven" })).rejects.toThrow(
			"Retention proof unavailable",
		);
		expect(f.host.remove).not.toHaveBeenCalled();
		expect(f.runtime.state().workspaces[0].cleanup?.state).toBe("blocked");
	});
	it("refuses a second cleanup operation and backs off retries of the first within an hour", async () => {
		const f = await fixture();
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: "refs/heads/trunk", oid: f.base }]);
		vi.mocked(f.host.remove).mockResolvedValue(false);
		const fields = { workspaceId: f.workspace.id, idempotencyKey: "first-cleanup" };
		const delays: number[] = [];
		for (let n = 0; n < 9; n++) {
			expect(await f.call("cleanup_workspace", fields)).toMatchObject({ state: "deleting" });
			delays.push(f.runtime.state().workspaces[0].cleanup!.nextAttempt! - 1000);
		}
		expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
		await expect(f.call("cleanup_workspace", { ...fields, idempotencyKey: "second-cleanup" })).rejects.toThrow(
			"Resume the existing authorized cleanup operation",
		);
		expect(f.w.state.reservations.filter((r) => r.action === "workspace.cleanup")).toHaveLength(1);
	});
	it("recovers at most one bounded batch per wakeup and schedules the rest", async () => {
		const f = await fixture();
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: "refs/heads/trunk", oid: f.base }]);
		const ids = [f.workspace.id];
		for (let n = 0; n < 4; n++) {
			const s = (await f.call("start_workspace", { title: `Batch ${n}`, baseRevision: f.base })) as Workspace;
			await f.call("attach_workspace", {
				workspaceId: s.id,
				execution: { id: s.id, checkoutId: `batch-${n}`, machineId: "machine", kind: "worktree", owned: true },
			});
			ids.push(s.id);
		}
		let time = 1000;
		const schedule = vi.fn(async (_at: number) => {});
		let runtime = new RepositoryRuntime(f.store, f.git, f.port, {}, () => time, { schedule, authorize: async (g) => g });
		vi.mocked(f.host.remove).mockResolvedValue(false);
		for (const id of ids) {
			await runtime.command(
				{ tool: "end_workspace", namespaceId: repo.namespaceId, repositoryId: repo.id, workspaceId: id, idempotencyKey: `end-${id}` },
				grant,
			);
			await runtime.command(
				{ tool: "cleanup_workspace", namespaceId: repo.namespaceId, repositoryId: repo.id, workspaceId: id, idempotencyKey: `clean-${id}` },
				grant,
			);
		}
		vi.mocked(f.host.remove).mockClear().mockResolvedValue(true);
		schedule.mockClear();
		time += 60_000;
		runtime = new RepositoryRuntime(f.store, f.git, f.port, {}, () => time, { schedule, authorize: async (g) => g });
		await runtime.recoverCleanup();
		expect(f.host.remove).toHaveBeenCalledTimes(4);
		expect(everyWorkspace(runtime, f.store).filter((w) => w.cleanup?.state === "complete")).toHaveLength(4);
		// The overdue fifth intent keeps a prompt wakeup after the bounded batch.
		expect(schedule.mock.calls.at(-1)?.[0]).toBe(time + 1000);
		await runtime.recoverCleanup();
		expect(f.host.remove).toHaveBeenCalledTimes(5);
		expect(
			everyWorkspace(runtime, f.store)
				.filter((w) => ids.includes(w.id))
				.every((w) => w.cleanup?.state === "complete"),
		).toBe(true);
		schedule.mockClear();
		await runtime.recoverCleanup();
		expect(schedule).not.toHaveBeenCalled();
	});
});

describe("bounded retained state (F6)", () => {
	it("archives activity and replays the original receipt after the hot history window has advanced", async () => {
		const f = await fixture();
		const controller = new (await import("../../src/core/platform.ts")).RepositoryController(f.runtime.state(), 1000, () => "unused");
		for (let n = 0; n < 205; n++) controller.event(agent, "measured_event", `Event ${n}`, [f.workspace.id]);
		f.runtime.save(controller);
		expect(f.runtime.state().activity).toHaveLength(100);
		expect(f.runtime.state().receipts).toEqual({});
		const first = (await f.call("get_activity")) as { items: unknown[]; cursor: string };
		expect(first.items).toHaveLength(100);
		const second = (await f.call("get_activity", { cursor: first.cursor })) as { items: unknown[]; cursor: string };
		expect(second.items).toHaveLength(100);
		const third = (await f.call("get_activity", { cursor: second.cursor })) as { items: unknown[]; cursor?: string };
		expect(third.items.length).toBeGreaterThan(5);
		expect(third.cursor).toBeUndefined();
		const before = f.runtime.state();
		const replay = (await f.call("start_workspace", { idempotencyKey: "key-1", title: "Retry", baseRevision: f.base })) as Workspace;
		expect(replay.id).toBe(f.workspace.id);
		expect(f.runtime.state()).toEqual(before);
		await expect(f.call("start_workspace", { idempotencyKey: "key-1", title: "Changed input", baseRevision: f.base })).rejects.toThrow(
			"identity reused",
		);
	});
	it("rejects publication at the retained record ceiling before reserving or contacting the provider", async () => {
		const f = await fixture();
		const state = f.runtime.state();
		state.artifacts = Array.from({ length: 1024 }, (_, n) => ({
			id: `evidence-${n}`,
			namespaceId: repo.namespaceId,
			repositoryId: repo.id,
			workspaceId: f.workspace.id,
			actor: agent,
			revision: f.head,
			kind: "evidence",
			title: "Evidence",
			contentHash: "digest",
			trust: "reported",
			storage: { repository: "retained", providerId: "retained-id", revision: f.head },
			at: 1000,
		}));
		f.store.put("repository", state);
		const charged = f.w.state.reservations.length,
			calls = vi.mocked(f.host.ensure).mock.calls.length;
		await expect(
			f.call("publish_artifact", { workspaceId: f.workspace.id, revision: f.head, title: "Extra", content: "Evidence" }),
		).rejects.toThrow("capacity reached");
		expect(f.w.state.reservations).toHaveLength(charged);
		expect(f.host.ensure).toHaveBeenCalledTimes(calls);
	});
	it("finishes an already explicitly requested deletion when its original caller retries", async () => {
		const f = await fixture();
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		const state = f.runtime.state();
		state.workspaces[0].fork!.state = "deleting";
		f.store.put("repository", state);
		expect(await f.call("cleanup_workspace", { workspaceId: f.workspace.id })).toMatchObject({ state: "deleted" });
		expect(f.host.remove).toHaveBeenCalledTimes(1);
	});
});

describe("replaceable observation receipts", () => {
	it("keeps one slot per workspace and tool, replays only the latest operation exactly, and refuses a missing result", async () => {
		const f = await fixture();
		let now = 2000;
		const runtime = new RepositoryRuntime(f.store, f.git, f.port, {}, () => now);
		const command = {
			tool: "heartbeat",
			namespaceId: repo.namespaceId,
			repositoryId: repo.id,
			workspaceId: f.workspace.id,
			execution: f.execution,
			idempotencyKey: "beat-0",
		};
		const records = f.store.usage().records;
		const receipts = f.store.scan("receipt:").length;
		for (let tick = 0; tick < 200; tick++) {
			now = 2000 + tick * 30000;
			await runtime.command({ ...command, idempotencyKey: `beat-${tick}` }, grant);
			await runtime.command(
				{ ...command, tool: "report_change", idempotencyKey: `report-${tick}`, revision: f.workspace.baseRevision, changes: [] },
				grant,
			);
		}
		expect(f.store.scan("receipt:")).toHaveLength(receipts);
		expect(f.store.scan("observation:")).toHaveLength(2);
		expect(f.store.scan("observation-result:")).toHaveLength(2);
		expect(f.store.scan("workspace-result:")).toHaveLength(0);
		expect(f.store.usage().records - records).toBeLessThanOrEqual(5);

		const latest = { ...command, idempotencyKey: "beat-199" };
		const before = runtime.state();
		now += 5000;
		const replay = await runtime.command(latest, grant);
		expect(replay).toMatchObject({ id: f.workspace.id, lastActivity: 2000 + 199 * 30000 });
		expect(runtime.state()).toEqual(before);
		await expect(runtime.command({ ...latest, title: "changed" }, grant)).rejects.toThrow("Operation identity reused");
		// A report key reused for presence is a different operation, never a replay.
		await expect(runtime.command({ ...command, idempotencyKey: "report-199" }, grant)).rejects.toThrow("Operation identity reused");
		// Superseded identities are new latest-wins observations under current authority.
		const again = (await runtime.command({ ...command, idempotencyKey: "beat-3" }, grant)) as { lastActivity: number };
		expect(again.lastActivity).toBe(now);
		f.store.delete(`observation-result:${f.workspace.id}:heartbeat`);
		await expect(runtime.command({ ...command, idempotencyKey: "beat-3" }, grant)).rejects.toThrow("Retained operation result unavailable");
	});
});

describe("archived finished work", () => {
	async function finish(f: Awaited<ReturnType<typeof fixture>>) {
		const artifact = (await f.call("publish_revision", { workspaceId: f.workspace.id, revision: f.head, pack: f.pack })) as {
			id: string;
		};
		const change = (await f.call("create_proposal", { artifactId: artifact.id })) as Proposal;
		await f.call("reject_proposal", { proposalId: change.id, reason: "Superseded" }, { actor: owner } as typeof grant);
		await f.call("end_workspace", { workspaceId: f.workspace.id });
		vi.spyOn(f.git, "remoteRefs").mockResolvedValue([{ ref: "refs/heads/trunk", oid: f.base }]);
		return { artifact, change };
	}
	const read = (f: Awaited<ReturnType<typeof fixture>>, tool: string, fields: Partial<Command> = {}) =>
		f.runtime.command({ tool, namespaceId: repo.namespaceId, repositoryId: repo.id, ...fields }, grant);

	it("moves an ended, cleaned-up workspace and its closed change out of hot state in the cleanup transaction", async () => {
		const f = await fixture();
		const { artifact, change } = await finish(f);
		const batch = vi.spyOn(f.store, "batch");
		await f.call("cleanup_workspace", { workspaceId: f.workspace.id, idempotencyKey: "cleanup" });
		const archived = batch.mock.calls.find(([entries]) => entries.some((e) => e.key.startsWith("archive:")));
		expect(archived?.[0].map((e) => e.key)).toEqual(
			expect.arrayContaining(["repository", `archived:${f.workspace.id}`, `archived:${change.id}`, `archived-revision:${f.head}`]),
		);
		const state = f.runtime.state();
		expect(state.workspaces.map((w) => w.id)).not.toContain(f.workspace.id);
		expect(state.proposals.map((p) => p.id)).not.toContain(change.id);
		expect(state.artifacts.map((a) => a.id)).not.toContain(artifact.id);
		expect(state.archiveCount).toBe(1);
		expect(f.store.scan(`observation:${f.workspace.id}`)).toHaveLength(0);
		// The deleted fork's provider identity stays recorded after its hot record leaves.
		expect(f.store.get(`provider-repository:repo-${repo.id}-workspace-${f.workspace.id}`)).toBeDefined();
	});

	it("serves archived records to reads without writing, and refuses new mutations on them", async () => {
		const f = await fixture();
		const { artifact, change } = await finish(f);
		const cleanup = await f.call("cleanup_workspace", { workspaceId: f.workspace.id, idempotencyKey: "cleanup" });
		const before = structuredClone(f.runtime.state());
		const usage = f.store.usage();
		expect(await read(f, "get_workspace", { workspaceId: f.workspace.id })).toMatchObject({ id: f.workspace.id, state: "completed" });
		expect(await read(f, "read_artifact", { artifactId: artifact.id })).toMatchObject({ artifact: { id: artifact.id } });
		const lineage = (await read(f, "get_lineage", { subjectId: change.id })) as { type: string }[];
		expect(lineage.map((r) => r.type)).toEqual(expect.arrayContaining(["workspace", "artifact", "change"]));
		expect(await read(f, "get_source", { revision: f.head, path: "src/pay.ts" })).toMatchObject({ revision: f.head });
		const page = (await read(f, "get_archive")) as { items: ArchiveBundle[]; total: number };
		expect(page).toMatchObject({ total: 1, items: [{ sequence: 1, workspace: { id: f.workspace.id } }] });
		expect(await read(f, "get_archive", { subjectId: artifact.id })).toMatchObject({ workspace: { id: f.workspace.id } });
		expect(await read(f, "get_archive", { subjectId: "unknown" })).toBeNull();
		expect(f.runtime.state()).toEqual(before);
		expect(f.store.usage()).toEqual(usage);

		await expect(
			f.call("review_proposal", { proposalId: change.id, revision: f.head, outcome: "concern", reason: "Late" }),
		).rejects.toThrow("Change is not open");
		await expect(f.call("create_proposal", { artifactId: artifact.id })).rejects.toThrow("Workspace has ended");
		await expect(f.call("inspect_retention", { workspaceId: f.workspace.id })).rejects.toThrow("Workspace has ended");
		// The operation that finished the work still replays its recorded result without provider calls.
		const removals = vi.mocked(f.host.remove).mock.calls.length;
		expect(await f.call("cleanup_workspace", { workspaceId: f.workspace.id, idempotencyKey: "cleanup" })).toEqual(cleanup);
		expect(f.host.remove).toHaveBeenCalledTimes(removals);
		expect(f.runtime.state()).toEqual(before);
	});

	it("keeps finished work hot while a publication may settle or storage is full, then archives on a later save", async () => {
		const f = await fixture();
		await finish(f);
		f.store.put("pending-publication-count", 1);
		await f.call("cleanup_workspace", { workspaceId: f.workspace.id, idempotencyKey: "cleanup" });
		expect(f.runtime.state().workspaces.map((w) => w.id)).toContain(f.workspace.id);
		f.store.put("pending-publication-count", 0);
		// Only the archive's own admission fails: the transition that triggered it still succeeds.
		const admit = vi.spyOn(f.store, "admit").mockImplementation((_bytes, records) => {
			if ((records ?? 0) > 4)
				throw new DomainError(409, "Coordination storage capacity reached; inspect retained records before adding work");
		});
		await f.call("start_workspace", { title: "Next", baseRevision: f.base });
		expect(admit).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
		admit.mockRestore();
		expect(f.runtime.state().workspaces.map((w) => w.id)).toContain(f.workspace.id);
		await f.call("start_workspace", { title: "Later", baseRevision: f.base });
		expect(f.runtime.state().workspaces.map((w) => w.id)).not.toContain(f.workspace.id);
	});

	it("bounds live workspaces rather than lifetime workspaces and keeps change numbers unique", async () => {
		const f = await fixture();
		const numbers = new Set<number>();
		for (let n = 0; n < STATE_LIMITS.workspaces + 44; n++) {
			const s = (await f.call("start_workspace", { title: `Short ${n}`, baseRevision: f.base })) as Workspace;
			await f.call("end_workspace", { workspaceId: s.id, cancelled: true });
		}
		expect(f.runtime.state().workspaces.length).toBeLessThan(STATE_LIMITS.workspaces);
		expect(f.runtime.state().archiveCount).toBe(STATE_LIMITS.workspaces + 44);
		const { change } = await finish(f);
		numbers.add(change.number);
		expect(change.number).toBe(1);
		expect(f.runtime.state().proposalCount).toBe(1);
		let cursor: string | undefined;
		let seen = 0;
		do {
			const page = (await read(f, "get_archive", { cursor })) as { items: ArchiveBundle[]; cursor?: string };
			seen += page.items.length;
			cursor = page.cursor;
		} while (cursor);
		expect(seen).toBe(STATE_LIMITS.workspaces + 44);
	});
});
