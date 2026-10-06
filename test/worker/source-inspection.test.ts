import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import git from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialRepository } from "../../src/core/platform.ts";
import type { Actor, Artifact, Command, Repository } from "../../src/shared/platform.ts";
import type { RepositoryHost, SourceReader } from "../../src/worker/artifacts.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { SqlFs } from "../../src/worker/git/sql-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { SOURCE_LIMITS, SourceInspection } from "../../src/worker/source-inspection.ts";
import { sqlStore } from "../../src/worker/store.ts";
import { gitServer } from "../git/http-fixture.ts";

const actor: Actor = { id: "owner", userId: "owner", kind: "human", name: "Owner" };
const repository: Repository = {
	id: "repo",
	namespaceId: "namespace",
	name: "Source",
	storageName: "canonical",
	defaultBranch: "trunk",
	createdAt: 1000,
	grants: [],
	policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
};
const author = { name: "Owner", email: "owner@local", timestamp: 1000 };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
	vi.restoreAllMocks();
});

function database() {
	const db = new DatabaseSync(":memory:");
	cleanup.push(() => db.close());
	const exec = (query: string, ...bindings: (string | number | ArrayBuffer | null)[]) => {
		const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
		const statement = db.prepare(query);
		if (!query.startsWith("SELECT ")) {
			statement.run(...args);
			return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const rows = query.startsWith("SELECT ")
			? statement
					.all(...args)
					.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Uint8Array.from(v).buffer : v])))
			: [];
		return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
	};
	return { db, sql: { exec } as unknown as SqlStorage };
}

async function fixture(native = false) {
	const fs = new MemoryFs(),
		source = new GitWorkspace(fs as never);
	await source.ensureInit();
	const base = await source.commit({
		ref: "refs/heads/trunk",
		parent: null,
		files: { "README.md": "base", "src/exec.sh": "hello" },
		message: "base",
		author,
	});
	const left = await source.commit({ ref: "refs/heads/left", parent: base, files: { "left.txt": "left" }, message: "left", author });
	const right = await source.commit({ ref: "refs/heads/right", parent: base, files: { "right.txt": "right" }, message: "right", author });
	const head = await source.commit({
		ref: "refs/heads/merged",
		parent: left,
		extraParents: [right],
		files: { "right.txt": "right" },
		message: "merge",
		author,
	});
	const remote = native ? await gitServer(source, base, [head]) : undefined;
	if (remote) {
		remote.setRef("refs/heads/artifact-source", head);
		cleanup.push(remote.close);
	}
	const state = initialRepository(repository);
	state.sourceHead = base;
	state.canonical = { name: "canonical", id: "canonical-id", remote: remote?.url ?? "https://fixture.invalid" };
	const artifact: Artifact = {
		id: "source",
		namespaceId: repository.namespaceId,
		repositoryId: repository.id,
		workspaceId: "workspace",
		actor,
		revision: head,
		baseRevision: base,
		kind: "source",
		title: "Merge",
		contentHash: "hash",
		trust: "reported",
		storage: { repository: "retained", providerId: "retained-id", revision: head, ref: "refs/heads/artifact-source" },
		at: 1000,
	};
	state.artifacts.push(artifact);
	const refs = new Map([
		[artifact.storage.ref!, head],
		["refs/heads/trunk", base],
	]);
	const commit = async (oid: string) => {
		try {
			const c = (await git.readCommit({ fs: fs as never, gitdir: "/workspace.git", oid })).commit;
			return {
				hash: oid,
				treeHash: c.tree,
				message: c.message.trim(),
				parents: c.parent,
				authoredAt: c.author.timestamp,
				committedAt: c.committer.timestamp,
				author: c.author,
				committer: c.committer,
			};
		} catch {
			return null;
		}
	};
	const reader: SourceReader = {
		readCommit: vi.fn(commit),
		readTree: vi.fn(async (oid) =>
			(await git.readTree({ fs: fs as never, gitdir: "/workspace.git", oid })).tree.map((e) => ({
				name: e.path,
				hash: e.oid,
				mode: e.mode,
				type: e.type as ArtifactsTreeEntryType,
			})),
		),
		readFile: vi.fn(async ({ ref, path }) => new Blob([(await source.readFiles(ref, (p) => p === path))[path]])),
		log: vi.fn(async (opts) => {
			const out: ArtifactsCommitMetadata[] = [];
			let oid: string | undefined = refs.get(opts?.ref ?? "") ?? opts?.ref;
			while (oid && out.length < (opts?.limit ?? 30)) {
				const c = await commit(oid);
				if (!c) break;
				out.push(c);
				oid = c.parents[0];
			}
			return out;
		}),
	};
	const host: RepositoryHost = {
		ensure: vi.fn(),
		fork: vi.fn(),
		remove: vi.fn(),
		gitRequest: vi.fn(),
		info: vi.fn(async (name) => ({ name, id: `${name}-id`, remote: remote?.url ?? "https://fixture.invalid" })),
		withToken: vi.fn(async (_name, _scope, run) => ({ result: await run("temporary"), tokenId: "token" })),
		withSource: vi.fn(async (name, id, run) => {
			if (id !== `${name}-id`) throw new Error("identity mismatch");
			return run(reader);
		}),
	};
	const sql = database(),
		sqlFs = new SqlFs(sql.sql),
		cache = new GitWorkspace(sqlFs, "/repository.git");
	const inspect = () => new SourceInspection(host, state);
	const call = (fields: Partial<Command>) => inspect().inspect({ tool: "inspect_source", ...fields }, cache);
	return { ...sql, source, sqlFs, cache, base, left, right, head, state, artifact, host, reader, refs, remote, inspect, call };
}

describe("bounded provider source inspection", () => {
	it("uses direct trees/files and explicitly first-parent history without creating a Git cache", async () => {
		const f = await fixture();
		expect(await f.call({ revision: f.head })).toMatchObject({ paths: ["README.md", "left.txt", "right.txt", "src/exec.sh"] });
		expect(f.reader.readFile).not.toHaveBeenCalled();
		expect(await f.call({ revision: f.head, path: "right.txt" })).toMatchObject({ file: { content: "right" } });
		const history = (await f.call({ revision: f.head, sourceView: "history" })) as { traversal: string; commits: { oid: string }[] };
		expect(history.traversal).toBe("first-parent");
		expect(history.commits.map((c) => c.oid)).toEqual([f.head, f.left, f.base]);
		expect(f.sqlFs.cacheUsage().entries).toBe(0);
		expect(f.host.withToken).not.toHaveBeenCalled();
	});
	it("authorizes a retained second parent through all-parent traversal, never first-parent log", async () => {
		const f = await fixture();
		expect(await f.call({ revision: f.right, path: "right.txt" })).toMatchObject({ revision: f.right, file: { content: "right" } });
		expect(f.reader.readCommit).toHaveBeenCalledWith(f.right);
		await expect(f.call({ revision: "0".repeat(40) })).rejects.toThrow("publish committed source");
	});
	it("bounds binary/large files, tree entries, provider calls and response bytes", async () => {
		const f = await fixture();
		vi.mocked(f.reader.readFile).mockResolvedValueOnce(new Blob([new Uint8Array([0, 1])]));
		expect(await f.call({ revision: f.head, path: "binary" })).toMatchObject({
			file: { content: null, reason: expect.stringContaining("Binary") },
		});
		vi.mocked(f.reader.readFile).mockResolvedValueOnce(new Blob(["a".repeat(SOURCE_LIMITS.fileBytes + 1)]));
		expect(await f.call({ revision: f.head, path: "large" })).toMatchObject({
			file: { content: null, reason: expect.stringContaining("large") },
		});
		vi.mocked(f.reader.readTree).mockResolvedValueOnce(
			Array.from({ length: SOURCE_LIMITS.entries + 1 }, () => ({ name: "file", hash: f.base, mode: "100644", type: "blob" })),
		);
		await expect(f.call({ revision: f.head })).rejects.toThrow("tree exceeds");
		vi.mocked(f.reader.readCommit).mockImplementation(async (oid) => ({
			hash: oid,
			treeHash: f.base,
			message: "",
			author,
			committer: author,
			authoredAt: 1,
			committedAt: 1,
			parents: [(BigInt(`0x${oid}`) + 1n).toString(16).padStart(40, "0")],
		}));
		await expect(f.call({ revision: "1".repeat(40) })).rejects.toThrow("provider-call limit");
		vi.mocked(f.reader.log).mockResolvedValueOnce([
			{ hash: f.head, message: "x".repeat(SOURCE_LIMITS.responseBytes) } as ArtifactsCommitMetadata,
		]);
		await expect(f.call({ revision: f.head })).rejects.toThrow("response limit");
	});
	it("refuses missing commits, missing IDs, replacement identities and moved retention refs", async () => {
		const f = await fixture();
		f.refs.set(f.artifact.storage.ref!, f.left);
		await expect(f.call({ revision: f.head })).rejects.toThrow("ref differs");
		f.refs.set(f.artifact.storage.ref!, f.head);
		f.artifact.storage.providerId = "replacement";
		await expect(f.call({ revision: f.head })).rejects.toThrow("identity mismatch");
		Reflect.deleteProperty(f.artifact.storage, "providerId");
		await expect(f.call({ revision: f.head })).rejects.toThrow("identity unavailable");
	});
});

describe("recoverable SQL Git cache", () => {
	it("replaces a corrupt loose blob that shadows a valid retained pack", async () => {
		const f = await fixture(true);
		await f.cache.importPack(await f.source.exportPack(f.head));
		const { oid } = await git.hashBlob({ object: new TextEncoder().encode("base") });
		await f.sqlFs.writeFile(`/repository.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, deflateSync("blob 8\0tampered"));
		f.cache.clearCache();
		expect(await f.cache.hasCompleteSource(f.head)).toBe(false);
		await f.inspect().recover(f.cache, f.head);
		expect((await f.cache.readFiles(f.head))["README.md"]).toBe("base");
		expect(await f.cache.hasCompleteSource(f.head)).toBe(true);
	});
	it("refuses a remotely shallow graph rather than proving complete retained ancestry", async () => {
		const f = await fixture(true);
		await f.remote!.setShallow(f.head);
		await expect(f.inspect().recover(f.cache, f.head)).rejects.toThrow();
		expect(await f.cache.hasCompleteSource(f.head)).toBe(false);
	});
	it("recovers complete merge ancestry, diffs and native packs after deletion/restart with no fork", async () => {
		const f = await fixture(true);
		const store = sqlStore(f.sql),
			metadata = { revision: f.head, provenance: "preserved" };
		store.put("retained", metadata);
		await f.inspect().recover(f.cache, f.head);
		expect(await f.cache.mergeBase(f.right, f.head)).toBe(f.right);
		expect((await f.cache.reviewChanges(f.base, f.head)).files.map((p) => p.path)).toEqual(["left.txt", "right.txt"]);
		const pack = await f.cache.exportPack(f.head);
		f.db.exec("DROP TABLE gitfs");
		const reopened = new GitWorkspace(new SqlFs(f.sql), "/repository.git");
		expect(await reopened.hasCompleteSource(f.head)).toBe(false);
		await f.inspect().recover(reopened, f.head);
		expect(await reopened.exportPack(f.head)).toEqual(pack);
		expect(store.get("retained")).toEqual(metadata);
		expect(f.host.fork).not.toHaveBeenCalled();
		expect(f.remote!.head()).toBe(f.base);
	});
	it("repairs partial object loss even when negotiation refs claim the commit is already cached", async () => {
		const f = await fixture(true);
		await f.cache.importPack(await f.source.exportPack(f.head));
		await f.cache.setRef("refs/remotes/artifacts/heads/artifact-source", f.head);
		const pack = f.db.prepare("SELECT path FROM gitfs WHERE path LIKE '%.pack'").get()!.path as string;
		await f.sqlFs.unlink(pack);
		f.cache.clearCache();
		expect(await f.cache.hasCompleteSource(f.head)).toBe(false);
		await f.inspect().recover(f.cache, f.head);
		expect(await f.cache.hasCompleteSource(f.right)).toBe(true);
	});
	it("rejects an exact-ref race during recovery without importing the wrong source", async () => {
		const f = await fixture(true);
		f.remote!.setRef(f.artifact.storage.ref!, f.left);
		await expect(f.inspect().recover(f.cache, f.head)).rejects.toThrow("ref differs");
		expect(await f.cache.hasCompleteSource(f.head)).toBe(false);
	});
	it("caps SQL bytes and entries, evicts a whole generation and preserves authoritative metadata", async () => {
		const { sql } = database(),
			fs = new SqlFs(sql, { retainedBytes: 100, maxBytes: 500, maxEntries: 20 });
		const store = sqlStore(sql);
		store.put("authority", { id: "stable" });
		await fs.writeFile("/repository.git/objects/a", "a".repeat(120));
		await expect(fs.writeFile("/repository.git/objects/b", "b".repeat(500))).rejects.toThrow("bounded cache");
		expect(fs.cacheUsage().bytes).toBeLessThanOrEqual(500);
		expect(fs.trimCache("/repository.git")).toBe(true);
		await expect(fs.stat("/repository.git")).rejects.toThrow("ENOENT");
		expect(store.get("authority")).toEqual({ id: "stable" });
		const limited = new SqlFs(sql, { retainedBytes: 1000, maxBytes: 1000, maxEntries: 3 });
		await limited.writeFile("/one", "1");
		await limited.writeFile("/two", "2");
		await expect(limited.writeFile("/three", "3")).rejects.toThrow("bounded cache");
	});
});
