import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryController } from "../../src/core/platform.ts";
import type { Actor, Artifact, Command, Repository, RepositorySnapshot, Workspace } from "../../src/shared/platform.ts";
import { CRUCE_TOOLS } from "../../src/shared/tools.ts";
import type { StorageEnv } from "../../src/worker/artifacts.ts";
import { bridgeRoute } from "../../src/worker/bridge-auth.ts";
import { ControlTower } from "../../src/worker/control-tower.ts";
import { Directory } from "../../src/worker/directory.ts";
import { SqlFs } from "../../src/worker/git/sql-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { NamespaceRuntime } from "../../src/worker/namespace-runtime.ts";
import { type PlatformEnv, platformRoute } from "../../src/worker/platform-router.ts";
import { RepositoryRuntime } from "../../src/worker/repository-runtime.ts";
import { sqlStore } from "../../src/worker/store.ts";

const identity = vi.hoisted(() => ({ tenantId: "issuer", developerId: "owner", email: "current@example.test" }));
vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: DurableObjectState,
			readonly env: PlatformEnv,
		) {}
	},
	WorkerEntrypoint: class {},
}));
vi.mock("../../src/worker/auth.ts", () => ({
	consoleIdentity: async () => identity,
	connectionIdentity: (v: unknown) => v,
}));

// Execute the adapters' actual SQL. Every statement that could change schema or rows
// is rejected during reads, including after reconstructing all Durable Object wrappers.
function database() {
	const db = new DatabaseSync(":memory:");
	let readOnly = false;
	const exec = vi.fn((query: string, ...bindings: (string | number | ArrayBuffer | null)[]) => {
		if (readOnly && !query.trimStart().startsWith("SELECT ")) throw new Error(`Read attempted SQL mutation: ${query}`);
		const statement = db.prepare(query);
		const args = bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
		if (!query.trimStart().startsWith("SELECT ")) {
			statement.run(...args);
			return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const rows = statement
			.all(...args)
			.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([key, value]) => [key, ArrayBuffer.isView(value) ? Uint8Array.from(value as Uint8Array).buffer : value]),
				),
			);
		return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
	});
	return {
		sql: { exec } as unknown as SqlStorage,
		ctx: {
			storage: {
				sql: { exec },
				transactionSync: <T>(run: () => T) => {
					db.exec("SAVEPOINT fixture");
					try {
						const value = run();
						db.exec("RELEASE fixture");
						return value;
					} catch (error) {
						db.exec("ROLLBACK TO fixture");
						db.exec("RELEASE fixture");
						throw error;
					}
				},
			},
		} as unknown as DurableObjectState,
		freeze: () => {
			readOnly = true;
			exec.mockClear();
		},
		thaw: () => {
			readOnly = false;
		},
		assertReads: () => expect(exec.mock.calls.every(([query]) => query.trimStart().startsWith("SELECT "))).toBe(true),
		snapshot: () =>
			db
				.prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
				.all()
				.map((table) => ({
					...table,
					rows: String(table.name).startsWith("sqlite_") ? [] : db.prepare(`SELECT * FROM ${table.name} ORDER BY 1`).all(),
				})),
		close: () => db.close(),
	};
}
const databases: ReturnType<typeof database>[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
async function fixture(initialized = true) {
	const d = database(),
		n = database(),
		r = database();
	databases.push(d, n, r);
	const provider = vi.fn(() => {
		throw new Error("Read contacted Artifacts");
	});
	const send = vi.fn(() => {
		throw new Error("Read used network transport");
	});
	vi.stubGlobal("fetch", send);
	const kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
	let directory: Directory, namespace: NamespaceRuntime, tower: ControlTower;
	const env = {
		CRUCE_STORAGE_ACCOUNT_ID: "a".repeat(32),
		CRUCE_ARTIFACTS_NAMESPACE: "cruce",
		ARTIFACTS: { get: provider },
		OAUTH_KV: kv,
		DIRECTORY: { getByName: () => directory },
		NAMESPACE: { getByName: () => namespace },
		CONTROL_TOWER: { getByName: () => tower },
	} as unknown as PlatformEnv & StorageEnv & Env;
	const restart = () => {
		directory = new Directory(d.ctx, env);
		namespace = new NamespaceRuntime(n.ctx, env);
		tower = new ControlTower(r.ctx, env);
	};
	restart();
	const user = directory!.login({ ...identity, email: "recorded@example.test" });
	const personal = directory!.namespace(user.personalNamespaceId);
	namespace!.initialize(personal);
	const actor: Actor = { id: user.id, userId: user.id, name: user.name, kind: "human" };
	const grant = { actor };
	const repository: Repository = {
		id: "repo",
		namespaceId: personal.id,
		name: "source",
		defaultBranch: "trunk",
		createdAt: 1000,
		storageName: "repo-repo",
		grants: [],
		policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
	};
	namespace!.saveRepository(grant, repository);
	const store = sqlStore(r.sql),
		git = new GitWorkspace(new SqlFs(r.sql), "/repository.git");
	let base = "a".repeat(40),
		head = "b".repeat(40),
		workspaceId = "workspace";
	if (initialized) {
		await git.ensureInit();
		const author = { name: "Owner", email: "owner@local", timestamp: 1000 };
		base = await git.commit({
			ref: "refs/heads/trunk",
			parent: null,
			files: { "file.ts": "export const n = 1;\n" },
			message: "base",
			author,
		});
		head = await git.commit({
			ref: "refs/heads/work",
			parent: base,
			files: { "file.ts": "export const n = 2;\n" },
			message: "head",
			author,
		});
		const runtime = new RepositoryRuntime(store, git, namespace!, env);
		runtime.initialize(repository);
		const state = runtime.state();
		state.sourceHead = base;
		state.canonical = { id: "canonical-id", name: repository.storageName!, remote: "https://provider.invalid/canonical.git" };
		const c = new RepositoryController(state, 1000, () => workspaceId);
		const a = namespace!.authority(grant, repository.id);
		const workspace = c.command({ tool: "start_workspace", title: "Work", baseRevision: base }, a) as Workspace;
		workspaceId = workspace.id;
		workspace.fork = { id: "fork-id", name: "fork", remote: "https://provider.invalid/fork.git", state: "ready" };
		const artifact: Artifact = {
			id: "source",
			namespaceId: personal.id,
			repositoryId: repository.id,
			workspaceId,
			actor,
			revision: head,
			baseRevision: base,
			kind: "source",
			title: "Source",
			contentHash: "hash",
			trust: "reported",
			at: 1000,
			storage: { repository: "retained", providerId: "retained-id", revision: head, ref: "refs/heads/source" },
		};
		c.addArtifact(artifact);
		const evidence = await git.commit({
			ref: "refs/heads/evidence",
			parent: null,
			files: { "tests.txt": "tests passed" },
			message: "evidence",
			author,
		});
		c.addArtifact({
			...artifact,
			id: "evidence",
			kind: "evidence",
			storage: { repository: "evidence", providerId: "evidence-id", revision: evidence, path: "tests.txt", ref: "refs/heads/evidence" },
		});
		c.command({ tool: "create_proposal", artifactId: artifact.id, title: "Change" }, a);
		runtime.save(c);
	}
	const props = { ...identity, connectionId: "connection", repositoryIds: [repository.id] };
	const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
	const call = (path: string, body?: unknown, agent = false, bridge?: Parameters<typeof platformRoute>[5]) =>
		platformRoute(
			new Request(`https://test.example${path}`, {
				method: body ? "POST" : "GET",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				...(body ? { body: JSON.stringify(body) } : {}),
			}),
			env,
			ctx,
			agent ? props : undefined,
			agent ? ["cruce:read"] : undefined,
			bridge,
		);
	const snapshot = () => [d.snapshot(), n.snapshot(), r.snapshot()];
	const freeze = () => {
		d.freeze();
		n.freeze();
		r.freeze();
	};
	const path = `/api/namespaces/${personal.id}/repositories/${repository.id}`;
	return {
		d,
		n,
		r,
		env,
		restart,
		directory: () => directory!,
		namespace: () => namespace!,
		tower: () => tower!,
		repository,
		grant,
		user,
		personal,
		store,
		git,
		base,
		head,
		workspaceId,
		call,
		path,
		snapshot,
		freeze,
		provider,
		send,
		kv,
		props,
		ctx,
	};
}
const reads = CRUCE_TOOLS.filter((tool) => !tool.mutation);
describe("pure coordination reads through persisted adapters", () => {
	it.each([false, true])("keeps every catalog read pure over HTTP, MCP and terminal commands (restart: %s)", async (cold) => {
		const f = await fixture();
		const before = f.snapshot();
		f.freeze();
		if (cold) f.restart();
		for (const method of ["initialize", "tools/list"]) {
			const response = await f.call(
				"/mcp",
				{
					jsonrpc: "2.0",
					id: 1,
					method,
					...(method === "initialize"
						? { params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "read-test", version: "1" } } }
						: {}),
				},
				true,
			);
			expect(response!.status, method).toBe(200);
			expect(await response!.text(), method).toContain('"result"');
		}
		const bridge = { identity, namespaceId: f.personal.id, repositoryId: f.repository.id, connectionId: "terminal", tokenKey: "bridge" };
		for (const tool of reads) {
			const args = {
				namespaceId: f.personal.id,
				repositoryId: f.repository.id,
				workspaceId: f.workspaceId,
				revision: f.head,
				baseRevision: f.base,
				artifactId: "evidence",
				subjectId: f.workspaceId,
				path: "file.ts",
			};
			for (const [path, agent, terminal] of [
				[`${f.path}/command`, false, false],
				["/mcp/command", true, false],
				["/bridge/command", false, true],
			] as const) {
				if (terminal && tool.name === "get_workspace_updates") {
					await expect(f.call(path, { tool: tool.name, ...args }, agent, bridge)).rejects.toMatchObject({ status: 403 });
					continue;
				}
				const response = await f.call(path, { tool: tool.name, ...args }, agent, terminal ? bridge : undefined);
				expect(response!.status, `${path}: ${tool.name}`).toBe(200);
			}
			const mcp = await f.call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: args } }, true);
			expect(mcp!.status, tool.name).toBe(200);
			const body = await mcp!.text();
			expect(body, tool.name).toContain('"result"');
			expect(body, tool.name).not.toContain('"isError":true');
		}
		for (const path of [
			"/api/me",
			"/api/namespaces",
			`/api/namespaces/${f.personal.id}`,
			`${f.path.slice(0, f.path.lastIndexOf("/"))}`,
			f.path,
			`${f.path}/workspaces`,
			`${f.path}/workspaces/${f.workspaceId}`,
			`${f.path}/changes`,
			`${f.path}/changes/${f.workspaceId}`,
			`${f.path}/artifacts`,
			`${f.path}/artifacts/source`,
			`${f.path}/activity`,
			`${f.path}/export?revision=${f.head}`,
		])
			expect((await f.call(path))!.status, path).toBe(200);
		expect(f.snapshot()).toEqual(before);
		expect(f.provider).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
		expect(f.kv.put).not.toHaveBeenCalled();
		expect(f.kv.delete).not.toHaveBeenCalled();
		expect(f.directory().resolve(identity).email).toBe("recorded@example.test");
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
	});
	it("projects current repository metadata and revoked permissions without persisting the projection", async () => {
		const f = await fixture();
		f.namespace().saveRepository(f.grant, {
			...f.repository,
			name: "renamed",
			policy: { ...f.repository.policy, requiredEvidence: ["tests"] },
		});
		const before = f.snapshot();
		f.freeze();
		f.restart();
		const snapshot = (await (await f.call(f.path))!.json()) as RepositorySnapshot;
		expect(snapshot.repository.name).toBe("renamed");
		expect(snapshot.repository.policy.requiredEvidence).toEqual(["tests"]);
		expect(snapshot.readiness[f.workspaceId].ready).toBe(false);
		expect(f.snapshot()).toEqual(before);
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
		f.n.thaw();
		const state = sqlStore(f.n.sql).get<import("../../src/shared/platform.ts").NamespaceState>("namespace")!;
		delete state.members[f.user.id];
		sqlStore(f.n.sql).put("namespace", state);
		const revoked = f.snapshot();
		f.n.freeze();
		await expect(f.call(f.path)).rejects.toMatchObject({ status: 403 });
		await expect(
			f.call("/mcp/command", { tool: "get_repository", namespaceId: f.personal.id, repositoryId: f.repository.id }, true),
		).rejects.toMatchObject({ status: 403 });
		expect(f.snapshot()).toEqual(revoked);
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
	});
	it("refuses every catalog read after membership revocation over HTTP, MCP and terminal without writes", async () => {
		const f = await fixture();
		const state = sqlStore(f.n.sql).get<import("../../src/shared/platform.ts").NamespaceState>("namespace")!;
		delete state.members[f.user.id];
		sqlStore(f.n.sql).put("namespace", state);
		const before = f.snapshot();
		f.freeze();
		f.restart();
		const bridge = { identity, namespaceId: f.personal.id, repositoryId: f.repository.id, connectionId: "terminal", tokenKey: "bridge" };
		const args = {
			namespaceId: f.personal.id,
			repositoryId: f.repository.id,
			workspaceId: f.workspaceId,
			revision: f.head,
			baseRevision: f.base,
			artifactId: "evidence",
			subjectId: f.workspaceId,
			path: "file.ts",
		};
		for (const tool of reads) {
			for (const [path, agent, terminal] of [
				[`${f.path}/command`, false, false],
				["/mcp/command", true, false],
				["/bridge/command", false, true],
			] as const) {
				const request = f.call(path, { tool: tool.name, ...args }, agent, terminal ? bridge : undefined);
				// A revoked namespace is simply absent from discovery; its repository route refuses outright.
				if (tool.name === "list_namespaces" && path !== `${f.path}/command`) expect(await (await request)!.json(), path).toEqual([]);
				else await expect(request, `${path}: ${tool.name}`).rejects.toMatchObject({ status: 403 });
			}
			const mcp = await f.call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: args } }, true);
			const body = await mcp!.text();
			if (tool.name === "list_namespaces") expect(body, tool.name).not.toContain(f.personal.id);
			else {
				expect(body, tool.name).toContain('"isError":true');
				expect(body, tool.name).toContain('"status":403');
			}
		}
		expect(f.snapshot()).toEqual(before);
		expect(f.provider).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
	});
	it("limits terminal discovery to the namespace and repository it was approved for", async () => {
		const f = await fixture();
		f.freeze();
		const bound = (namespaceId: string, repositoryId: string) => ({
			identity,
			namespaceId,
			repositoryId,
			connectionId: "terminal",
			tokenKey: "bridge",
		});
		const list = async (tool: string, bridge: ReturnType<typeof bound>) =>
			(await f.call("/bridge/command", { tool, namespaceId: f.personal.id }, false, bridge))!.json();
		expect(await list("list_namespaces", bound(f.personal.id, f.repository.id))).toMatchObject([{ id: f.personal.id }]);
		expect(await list("list_repositories", bound(f.personal.id, f.repository.id))).toMatchObject([{ id: f.repository.id }]);
		expect(await list("list_namespaces", bound("other-namespace", f.repository.id))).toEqual([]);
		expect(await list("list_repositories", bound(f.personal.id, "other-repository"))).toEqual([]);
		await expect(
			f.call("/bridge/command", { tool: "list_repositories", namespaceId: f.personal.id }, false, bound("other-namespace", "other")),
		).rejects.toMatchObject({ status: 403, message: "Human bridge workspace scope denied" });
		expect((await (await f.call("/api/namespaces"))!.json()) as unknown[]).toHaveLength(1);
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
	});
	it("shows interrupted registration without creating metadata or a Git cache, then initializes only on explicit setup", async () => {
		const f = await fixture(false);
		const before = f.snapshot();
		f.freeze();
		f.restart();
		const snapshot = (await (await f.call(f.path))!.json()) as RepositorySnapshot;
		expect(snapshot.canonicalSetup).toEqual({ required: true, retry: true });
		expect((await (await f.call(`/api/namespaces/${f.personal.id}`))!.json()) as object).toHaveProperty("repositorySummaries");
		await expect(
			f.call(`${f.path}/command`, { tool: "start_workspace", title: "Work", baseRevision: f.base, idempotencyKey: "start" }),
		).rejects.toMatchObject({ status: 409 });
		await expect(f.call(`${f.path}/command`, { tool: "retry_repository_setup" })).rejects.toMatchObject({ status: 400 });
		await expect(
			f.call(
				"/mcp/command",
				{ tool: "retry_repository_setup", namespaceId: f.personal.id, repositoryId: f.repository.id, idempotencyKey: "retry" },
				true,
			),
		).rejects.toMatchObject({ status: 403 });
		expect(f.snapshot()).toEqual(before);
		expect(f.provider).not.toHaveBeenCalled();
		f.n.thaw();
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
		f.r.thaw();
		await expect(f.call(`${f.path}/command`, { tool: "retry_repository_setup", idempotencyKey: "retry" })).rejects.toMatchObject({
			status: 502,
		});
		expect(f.provider).toHaveBeenCalledTimes(1);
		expect(f.store.get("repository")).toBeDefined();
		expect(f.store.get<Command>("provision-command")?.idempotencyKey).toBe("provision-repo");
		expect(f.namespace().snapshot(f.grant).reservations).toHaveLength(1);
	});
	it("does not create an unknown authenticated identity on API or MCP reads", async () => {
		const f = await fixture();
		sqlStore(f.d.sql).delete(`identity:${JSON.stringify([identity.tenantId, identity.developerId])}`);
		const before = f.snapshot();
		f.freeze();
		f.restart();
		await expect(f.call("/api/me")).rejects.toMatchObject({ status: 401 });
		await expect(f.call("/mcp/command", { tool: "list_namespaces" }, true)).rejects.toMatchObject({ status: 401 });
		expect(f.snapshot()).toEqual(before);
		expect(f.provider).not.toHaveBeenCalled();
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
	});
	it("terminal approval inspects an established identity without updating it or initializing storage", async () => {
		const f = await fixture();
		f.kv.get.mockResolvedValue({ namespaceId: f.personal.id, repositoryId: f.repository.id, expiresAt: Date.now() + 60000 });
		const before = f.snapshot();
		f.freeze();
		f.restart();
		const response = await bridgeRoute(new Request("https://test.example/bridge/approve?code=pair"), f.env, f.ctx);
		expect(await response!.text()).toContain("Authorize your terminal");
		expect(f.snapshot()).toEqual(before);
		expect(f.kv.put).not.toHaveBeenCalled();
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
	});
	it("never creates tables while looking up absent identity, namespace or source cache", async () => {
		const db = database();
		databases.push(db);
		db.freeze();
		const env = {} as PlatformEnv & StorageEnv & Env;
		expect(() => new Directory(db.ctx, env).resolve(identity)).toThrow("Sign in to initialize");
		expect(() =>
			new NamespaceRuntime(db.ctx, env).snapshot({ actor: { id: "owner", userId: "owner", kind: "human", name: "Owner" } }),
		).toThrow("Namespace unavailable");
		const fs = new SqlFs(db.sql);
		await expect(fs.readFile("/repository.git/HEAD")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat("/")).rejects.toMatchObject({ code: "ENOENT" });
		expect(db.snapshot()).toEqual([]);
		db.assertReads();
	});
	it("does not repair a missing personal Namespace from an established API read", async () => {
		const f = await fixture();
		f.n.sql.exec("DROP TABLE records");
		const before = f.snapshot();
		f.freeze();
		f.restart();
		const me = (await (await f.call("/api/me"))!.json()) as { user: { id: string }; namespaces: unknown[] };
		expect(me.user.id).toBe(f.user.id);
		expect(me.namespaces).toEqual([]);
		await expect(f.call(`/api/namespaces/${f.personal.id}`)).rejects.toMatchObject({ status: 404 });
		expect(f.snapshot()).toEqual(before);
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
		expect(f.provider).not.toHaveBeenCalled();
	});
	it("leaves a missing Git cache missing on source inspection instead of repairing it during a read", async () => {
		const f = await fixture();
		f.r.sql.exec("DROP TABLE gitfs");
		const before = f.snapshot();
		f.freeze();
		f.restart();
		expect((await f.call(f.path))!.status).toBe(200);
		await expect(f.call(`${f.path}/command`, { tool: "get_source", revision: f.head })).rejects.toThrow();
		await expect(f.call(`${f.path}/export?revision=${f.head}`)).rejects.toThrow();
		for (const tool of ["get_source", "get_history"])
			await expect(f.call(`${f.path}/command`, { tool, revision: f.head })).rejects.toMatchObject({
				status: 404,
				message: "Source cache unavailable; explicitly recover retained source",
			});
		await expect(f.call(`${f.path}/command`, { tool: "get_diff", baseRevision: f.base, revision: f.head })).rejects.toMatchObject({
			status: 404,
			message: "Source cache unavailable; explicitly recover retained source",
		});
		await expect(f.call(`${f.path}/command`, { tool: "read_artifact", artifactId: "evidence" })).rejects.toMatchObject({
			status: 404,
			message: "Artifact cache unavailable; inspect the retained artifact source",
		});
		const updates = await f.call(`${f.path}/command`, { tool: "get_workspace_updates", workspaceId: f.workspaceId });
		expect(await updates!.json()).toMatchObject({ available: false, comparison: "unavailable" });
		expect(f.snapshot()).toEqual(before);
		expect(f.provider).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
		f.d.assertReads();
		f.n.assertReads();
		f.r.assertReads();
	});
	it("writes and reads only the bytes in a buffer view before and after reopening the SQL filesystem", async () => {
		const db = database();
		databases.push(db);
		const buffer = Buffer.from("surrounding payload bytes");
		const view = buffer.subarray(12, 19);
		await new SqlFs(db.sql).writeFile("/object", view);
		const before = db.snapshot();
		db.freeze();
		const fs = new SqlFs(db.sql);
		expect(await fs.readFile("/object")).toEqual(Uint8Array.from(view));
		expect((await fs.stat("/object")).size).toBe(view.length);
		expect(db.snapshot()).toEqual(before);
		db.assertReads();
	});
});
