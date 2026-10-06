import { describe, expect, it, vi } from "vitest";
import { DirectoryController, initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import type { Actor, Command, Namespace, Repository } from "../../src/shared/platform.ts";
import type { ConnectionGrant } from "../../src/worker/namespace-runtime.ts";
import { type PlatformEnv, platformRoute } from "../../src/worker/platform-router.ts";

vi.mock("../../src/worker/auth.ts", () => ({
	consoleIdentity: async () => ({ tenantId: "issuer", developerId: "subject", email: "owner@example.com" }),
	validateIdentity: async (v: unknown) => v,
}));
vi.mock("../../src/worker/mcp.ts", () => ({ remoteMcp: () => () => new Response("MCP") }));
function fixture() {
	let id = 0;
	const directory = new DirectoryController({ users: [], namespaces: [] }, 100, () => `id-${++id}`);
	const user = directory.login("issuer", "subject", "owner@example.com");
	const actor: Actor = { id: user.id, userId: user.id, kind: "human", name: "Owner" };
	const namespace = new NamespaceController(initialNamespace(directory.state.namespaces[0]), 100);
	const repo: Repository = {
		id: "repo",
		namespaceId: namespace.state.namespace.id,
		name: "source",
		createdAt: 100,
		defaultBranch: "trunk",
		storageName: "repo-repo",
		grants: [],
		policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
	};
	namespace.repository(namespace.authority(actor), repo);
	const controller = new RepositoryController(initialRepository(repo), 100, () => `record-${++id}`);
	const port = {
		initialize: vi.fn((_w: Namespace) => {}),
		accept: vi.fn(),
		authority: (g: ConnectionGrant, r?: string) => namespace.authority(g.actor, r, g.scopes, g.repositories),
		snapshot: (g: ConnectionGrant) => {
			const a = namespace.authority(g.actor);
			return { ...namespace.state, role: a.role, permissions: { maintain: true, owner: true } };
		},
		repository: (g: ConnectionGrant, r: string) => {
			namespace.authority(g.actor, r, g.scopes, g.repositories);
			return repo;
		},
	};
	const command = vi.fn(async (_r: Repository, c: Command, g: ConnectionGrant) =>
		controller.command(c, namespace.authority(g.actor, repo.id, g.scopes, g.repositories)),
	);
	const retired = { users: [{ personalWorkspaceId: "retired" }], workspaces: [{ id: "retired" }] };
	const getDirectory = vi.fn((name: string) => {
		if (name === "directory") throw new Error(`Retired directory: ${JSON.stringify(retired)}`);
		if (name !== "namespace-directory") throw new Error("Unknown directory");
		return {
			resolve: (v: { tenantId: string; developerId: string }) => directory.resolve(v.tenantId, v.developerId),
			namespace: (id: string) => directory.state.namespaces.find((w) => w.id === id)!,
			namespaces: () => directory.state.namespaces,
			users: () => [user],
		};
	});
	const env = {
		DIRECTORY: { getByName: getDirectory },
		NAMESPACE: {
			getByName: (id: string) => {
				if (id !== namespace.state.namespace.id) throw new Error("Namespace access denied");
				return port;
			},
		},
		CONTROL_TOWER: { getByName: () => ({ command }) },
	} as unknown as PlatformEnv;
	const path = `/api/namespaces/${repo.namespaceId}/repositories/${repo.id}`;
	const call = (url = path, body?: unknown, props?: Record<string, unknown>, bridge?: Parameters<typeof platformRoute>[5]) =>
		platformRoute(
			new Request(`https://test.example${url}`, { method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) }),
			env,
			{} as ExecutionContext,
			props as never,
			["cruce:read", "workspace:write"],
			bridge,
		);
	return { call, path, repo, directory, controller, command, user, namespace, getDirectory, retired, port };
}
describe("namespace repository contracts", () => {
	it.each(["account", "account/verify"])("rejects the retired namespace storage endpoint %s", async (endpoint) => {
		const f = fixture();
		await expect(
			f.call(`/api/namespaces/${f.repo.namespaceId}/${endpoint}`, { accountId: "a".repeat(32), token: "private" }),
		).rejects.toMatchObject({ status: 404 });
		expect(f.command).not.toHaveBeenCalled();
	});
	it("namespace attention summaries are authorized coordination reads and recheck revoked membership", async () => {
		const f = fixture();
		const url = `/api/namespaces/${f.repo.namespaceId}`;
		const result = (await (await f.call(url))!.json()) as { repositorySummaries: { attention: unknown }[] };
		expect(result.repositorySummaries[0].attention).toEqual({ review: 0, ready: 0, stale: 0, behind: 0 });
		expect(f.command).toHaveBeenCalledTimes(1);
		expect(f.command.mock.calls[0][1].tool).toBe("get_repository");
		delete f.namespace.state.members[f.user.id];
		await expect(f.call(url)).rejects.toThrow();
		expect(f.command).toHaveBeenCalledTimes(1);
	});

	it.each(["environments", "environments/old", "deployments", "deployments/old"])(
		"returns 404 for removed collection %s",
		async (section) => {
			const f = fixture();
			await expect(f.call(`${f.path}/${section}`)).rejects.toMatchObject({ status: 404 });
		},
	);
	it.each(["request_preview", "configure_environment", "deploy_artifact"])(
		"rejects removed console command %s without changing repository state",
		async (tool) => {
			const f = fixture();
			const before = structuredClone(f.controller.state);
			await expect(f.call(`${f.path}/command`, { tool, idempotencyKey: "removed" })).rejects.toThrow("Unsupported repository command");
			expect(f.controller.state).toEqual(before);
		},
	);
	it("established API reads share a stable personal identity without initializing it", async () => {
		const f = fixture();
		const before = structuredClone(f.directory.state);
		const responses = await Promise.all(Array.from({ length: 10 }, () => f.call("/api/me")));
		const ids = await Promise.all(responses.map(async (r) => ((await r!.json()) as { user: { id: string } }).user.id));
		expect(new Set(ids).size).toBe(1);
		expect(f.directory.state.namespaces).toHaveLength(1);
		expect(f.directory.state).toEqual(before);
	});
	it("loads the current personal namespace without reading or rewriting retired development identities", async () => {
		const f = fixture();
		const before = structuredClone(f.retired);
		const result = (await (await f.call("/api/me"))!.json()) as { user: { personalNamespaceId: string } };
		expect(result.user.personalNamespaceId).toBe(f.namespace.state.namespace.id);
		expect(f.getDirectory).toHaveBeenCalledWith("namespace-directory");
		expect(f.getDirectory).not.toHaveBeenCalledWith("directory");
		expect(f.retired).toEqual(before);
	});
	it("binds invitation acceptance to the current verified email without refreshing Directory metadata", async () => {
		const f = fixture();
		f.user.email = "previous@example.com";
		const before = structuredClone(f.directory.state);
		expect((await f.call(`/api/namespaces/${f.repo.namespaceId}/accept`, { token: "invitation-token-1234567890" }))!.status).toBe(200);
		expect(f.port.accept).toHaveBeenCalledWith(expect.objectContaining({ id: f.user.id, email: "owner@example.com" }), expect.any(String));
		expect(f.directory.state).toEqual(before);
		expect(f.port.initialize).not.toHaveBeenCalled();
	});
	it("returns repository collections and record details; rejects obsolete routes and unknown records", async () => {
		const f = fixture();
		expect(await (await f.call(`${f.path}/changes`))!.json()).toEqual([]);
		await expect(f.call(`${f.path}/workspaces/missing`)).rejects.toThrow("unavailable");
		await expect(f.call("/api/projects")).rejects.toThrow("Not found");
		await expect(f.call(f.path.replace(f.repo.namespaceId, "different"))).rejects.toThrow("access denied");
	});
	it("rejects forged actor payloads and repositories absent from agent consent", async () => {
		const f = fixture();
		const props = { tenantId: "issuer", developerId: "subject", email: "owner@example.com", connectionId: "agent", repositoryIds: [] };
		const c = {
			tool: "start_workspace",
			namespaceId: f.repo.namespaceId,
			repositoryId: f.repo.id,
			title: "Test",
			baseRevision: "a".repeat(40),
			idempotencyKey: "start",
		};
		await expect(f.call("/mcp/command", c, props)).rejects.toThrow("not authorized");
		await expect(f.call("/mcp/command", { ...c, actor: { kind: "human" } }, { ...props, repositoryIds: [f.repo.id] })).rejects.toThrow();
		expect(f.controller.state.workspaces).toHaveLength(0);
	});
	it("human bridge credentials cannot invoke human source promotion", async () => {
		const f = fixture();
		const bridge = {
			identity: { accessJwt: "fixture", tenantId: "issuer", developerId: "subject", email: "owner@example.com" },
			namespaceId: f.repo.namespaceId,
			repositoryId: f.repo.id,
			connectionId: "terminal",
			tokenKey: "test",
		};
		await expect(
			f.call(
				"/bridge/command",
				{ tool: "promote_proposal", namespaceId: f.repo.namespaceId, repositoryId: f.repo.id, idempotencyKey: "promotion" },
				undefined,
				bridge,
			),
		).rejects.toThrow("scope denied");
		expect(f.command).not.toHaveBeenCalled();
	});
});
