import { describe, expect, it, vi } from "vitest";
import { DirectoryController, initialWorkspace, WorkspaceController } from "../../src/core/ownership.ts";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import type { Actor, Command, Repository, Workspace } from "../../src/shared/platform.ts";
import { type PlatformEnv, platformRoute } from "../../src/worker/platform-router.ts";
import type { ConnectionGrant } from "../../src/worker/workspace-runtime.ts";

vi.mock("../../src/worker/auth.ts", () => ({
	consoleIdentity: async () => ({ tenantId: "issuer", developerId: "subject", email: "owner@example.com" }),
	validateIdentity: async (v: unknown) => v,
}));
vi.mock("../../src/worker/mcp.ts", () => ({ remoteMcp: () => () => new Response("MCP") }));
function fixture() {
	let id = 0;
	const directory = new DirectoryController({ users: [], workspaces: [] }, 100, () => `id-${++id}`);
	const user = directory.login("issuer", "subject", "owner@example.com");
	const actor: Actor = { id: user.id, userId: user.id, kind: "human", name: "Owner" };
	const workspace = new WorkspaceController(initialWorkspace(directory.state.workspaces[0]), 100);
	const repo: Repository = {
		id: "repo",
		workspaceId: workspace.state.workspace.id,
		name: "source",
		createdAt: 100,
		defaultBranch: "trunk",
		source: { kind: "local" },
		grants: [],
		policy: { protectedPaths: [], requiredEvidence: [], resourceRules: {} },
	};
	workspace.repository(workspace.authority(actor), repo);
	const controller = new RepositoryController(initialRepository(repo), 100, () => `record-${++id}`);
	const port = {
		initialize: (_w: Workspace) => {},
		authority: (g: ConnectionGrant, r?: string) => workspace.authority(g.actor, r, g.scopes, g.repositories),
		snapshot: (g: ConnectionGrant) => {
			const a = workspace.authority(g.actor);
			return { ...workspace.state, role: a.role, permissions: { maintain: true, owner: true } };
		},
		repository: (g: ConnectionGrant, r: string) => {
			workspace.authority(g.actor, r, g.scopes, g.repositories);
			return repo;
		},
	};
	const command = vi.fn(async (_r: Repository, c: Command, g: ConnectionGrant) =>
		controller.command(c, workspace.authority(g.actor, repo.id, g.scopes, g.repositories)),
	);
	const env = {
		DIRECTORY: {
			getByName: () => ({
				login: (v: { tenantId: string; developerId: string; email: string }) => directory.login(v.tenantId, v.developerId, v.email),
				workspace: (id: string) => directory.state.workspaces.find((w) => w.id === id)!,
				workspaces: () => directory.state.workspaces,
				users: () => [user],
			}),
		},
		WORKSPACE: {
			getByName: (id: string) => {
				if (id !== workspace.state.workspace.id) throw new Error("Workspace access denied");
				return port;
			},
		},
		CONTROL_TOWER: { getByName: () => ({ command }) },
	} as unknown as PlatformEnv;
	const path = `/api/workspaces/${repo.workspaceId}/repositories/${repo.id}`;
	const call = (url = path, body?: unknown, props?: Record<string, unknown>, bridge?: Parameters<typeof platformRoute>[5]) =>
		platformRoute(
			new Request(`https://test.example${url}`, { method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) }),
			env,
			{} as ExecutionContext,
			props as never,
			["cruce:read", "session:write"],
			bridge,
		);
	return { call, path, repo, directory, controller, command, user };
}
describe("workspace repository contracts", () => {
	it("first-login API reads share a stable personal identity", async () => {
		const f = fixture();
		const responses = await Promise.all(Array.from({ length: 10 }, () => f.call("/api/me")));
		const ids = await Promise.all(responses.map(async (r) => ((await r!.json()) as { user: { id: string } }).user.id));
		expect(new Set(ids).size).toBe(1);
		expect(f.directory.state.workspaces).toHaveLength(1);
	});
	it("returns repository collections and record details; rejects obsolete routes and unknown records", async () => {
		const f = fixture();
		expect(await (await f.call(`${f.path}/changes`))!.json()).toEqual([]);
		await expect(f.call(`${f.path}/sessions/missing`)).rejects.toThrow("unavailable");
		await expect(f.call("/api/projects")).rejects.toThrow("Not found");
		await expect(f.call(f.path.replace(f.repo.workspaceId, "different"))).rejects.toThrow("access denied");
	});
	it("rejects forged actor payloads and repositories absent from agent consent", async () => {
		const f = fixture();
		const props = { tenantId: "issuer", developerId: "subject", email: "owner@example.com", connectionId: "agent", repositoryIds: [] };
		const c = {
			tool: "start_session",
			workspaceId: f.repo.workspaceId,
			repositoryId: f.repo.id,
			title: "Test",
			baseRevision: "a".repeat(40),
			idempotencyKey: "start",
		};
		await expect(f.call("/mcp/command", c, props)).rejects.toThrow("not authorized");
		await expect(f.call("/mcp/command", { ...c, actor: { kind: "human" } }, { ...props, repositoryIds: [f.repo.id] })).rejects.toThrow();
		expect(f.controller.state.sessions).toHaveLength(0);
	});
	it("human bridge credentials cannot invoke production or workspace administration", async () => {
		const f = fixture();
		const bridge = {
			identity: { accessJwt: "fixture", tenantId: "issuer", developerId: "subject", email: "owner@example.com" },
			workspaceId: f.repo.workspaceId,
			repositoryId: f.repo.id,
			connectionId: "terminal",
			tokenKey: "test",
		};
		await expect(
			f.call(
				"/bridge/command",
				{ tool: "deploy_artifact", workspaceId: f.repo.workspaceId, repositoryId: f.repo.id, idempotencyKey: "production" },
				undefined,
				bridge,
			),
		).rejects.toThrow("scope denied");
		expect(f.command).not.toHaveBeenCalled();
	});
});
