import { z } from "zod";
import { SCOPES, type Scope, workspaceMaintain } from "../core/capabilities.ts";
import { DomainError, requireValue } from "../core/errors.ts";
import { type Actor, branch, CommandInput, id, name, path, RESOURCE_ACTIONS, type Repository } from "../shared/platform.ts";
import { type AuthEnv, type AuthProps, consoleIdentity, validateIdentity } from "./auth.ts";
import type { ControlTower } from "./control-tower.ts";
import { remoteMcp } from "./mcp.ts";
import { hash } from "./store.ts";
import type { ConnectionGrant } from "./workspace-runtime.ts";
export interface PlatformEnv extends AuthEnv {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
}
export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
export async function input(request: Request) {
	const raw = await request.text();
	if (new TextEncoder().encode(raw).length > 45 * 1024 * 1024) throw new DomainError(413, "Request too large");
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		throw new DomainError(400, "Invalid JSON");
	}
}
const displayName = z.string().trim().min(1).max(120);
const role = z.enum(["maintainer", "developer", "viewer"]);
const repositoryInput = z.object({
	name,
	defaultBranch: branch.default("main"),
	source: z.enum(["local", "artifacts"]),
	idempotencyKey: id,
});
const humanBridgeTools = new Set([
	"get_repository",
	"get_context",
	"get_session",
	"list_active_sessions",
	"inspect_overlap",
	"get_source",
	"export_revision",
	"get_history",
	"get_diff",
	"read_artifact",
	"get_lineage",
	"start_session",
	"attach_session",
	"heartbeat",
	"report_change",
	"report_ref",
	"end_session",
	"publish_revision",
	"publish_artifact",
	"create_proposal",
]);
export async function platformRoute(
	request: Request,
	env: PlatformEnv,
	ctx: ExecutionContext,
	props?: AuthProps,
	scopes?: string[],
	bridge?: { identity: AuthProps; repositoryId: string; workspaceId: string; connectionId: string; tokenKey: string; sessionId?: string },
): Promise<Response | undefined> {
	const url = new URL(request.url),
		parts = url.pathname.split("/").filter(Boolean);
	if (
		!url.pathname.startsWith("/api/") &&
		url.pathname !== "/mcp" &&
		!url.pathname.startsWith("/mcp/") &&
		url.pathname !== "/bridge/command"
	)
		return;
	const identity = await (props
		? validateIdentity(props, env)
		: bridge
			? validateIdentity(bridge.identity, env)
			: consoleIdentity(request, env));
	const directory = env.DIRECTORY.getByName("directory"),
		user = await directory.login(identity);
	const personal = await directory.workspace(user.personalWorkspaceId);
	await env.WORKSPACE.getByName(personal.id).initialize(personal);
	const actor: Actor = {
		id: props ? `agent-${requireValue(props.connectionId, "Reconnect this agent")}` : user.id,
		userId: user.id,
		kind: props ? "agent" : "human",
		name: props?.clientName ?? user.name,
		connectionId: props?.connectionId ?? bridge?.connectionId,
	};
	const grant: ConnectionGrant = { actor, scopes, repositories: props?.repositoryIds };
	const workspaces = async () => {
		const allowed = [];
		for (const w of await directory.workspaces())
			try {
				const view = await env.WORKSPACE.getByName(w.id).snapshot(grant);
				if (!props || view.repositories.length) allowed.push(w);
			} catch {}
		return allowed;
	};
	const execute = async (raw: unknown) => {
		const cmd = CommandInput.parse(raw);
		if (cmd.tool === "list_workspaces") return workspaces();
		const workspaceId = requireValue(cmd.workspaceId, "Workspace required"),
			workspace = env.WORKSPACE.getByName(workspaceId);
		if (cmd.tool === "list_repositories") return (await workspace.snapshot(grant)).repositories;
		const repositoryId = requireValue(cmd.repositoryId, "Repository required"),
			repo = await workspace.repository(grant, repositoryId);
		if (bridge) {
			if (workspaceId !== bridge.workspaceId || repositoryId !== bridge.repositoryId || !humanBridgeTools.has(cmd.tool))
				throw new DomainError(403, "Human bridge session scope denied");
			// The repository DO enforces session binding atomically, including lost-response retries.
		}
		const result = await env.CONTROL_TOWER.getByName(repo.id).command(repo, cmd, grant);
		if (bridge && cmd.tool === "start_session") {
			bridge.sessionId = (result as { id: string }).id;
			await env.OAUTH_KV.put(bridge.tokenKey, JSON.stringify(bridge), { expirationTtl: 1800 });
		}
		return result;
	};
	if (url.pathname === "/mcp")
		return remoteMcp(
			execute,
			scopes?.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)),
		)(request, env, ctx);
	if (url.pathname === "/mcp/command" || url.pathname === "/bridge/command") {
		if (request.method !== "POST") throw new DomainError(405, "POST required");
		return json(await execute(await input(request)));
	}
	if (props || bridge) throw new DomainError(403, "Console access required");
	if (url.pathname === "/api/me" && request.method === "GET") return json({ user, workspaces: await workspaces() });
	if (url.pathname === "/api/workspaces") {
		if (request.method === "GET") return json(await workspaces());
		if (request.method === "POST") {
			const body = z.object({ name: displayName, handle: name, idempotencyKey: id }).parse(await input(request));
			const workspaceId = (await hash(`${user.id}:${body.idempotencyKey}`)).slice(0, 32);
			const w = await directory.create(user, body, workspaceId);
			await env.WORKSPACE.getByName(w.id).initialize(w);
			return json(w, 201);
		}
	}
	if (parts[1] !== "workspaces" || !parts[2]) throw new DomainError(404, "Not found");
	const workspaceId = parts[2],
		workspace = env.WORKSPACE.getByName(workspaceId);
	if (parts[3] === "accept" && request.method === "POST") {
		const body = z.object({ token: z.string().min(20).max(200) }).parse(await input(request));
		await workspace.accept(user, await hash(body.token));
		return json({ accepted: true });
	}
	const a = await workspace.authority(grant);
	if (parts.length === 3) {
		if (request.method === "GET") {
			const view = await workspace.snapshot(grant);
			const snapshots = await Promise.all(
				view.repositories.map(
					(repo) =>
						env.CONTROL_TOWER.getByName(repo.id).command(
							repo,
							{ tool: "get_repository", workspaceId, repositoryId: repo.id },
							grant,
						) as Promise<import("../shared/platform.ts").RepositorySnapshot>,
				),
			);
			const repositorySummaries = snapshots.map((s) => ({
				id: s.repository.id,
				active: s.sessions.filter((x) => x.state === "active").length,
				overlaps: s.overlaps.length,
				latestArtifact: s.artifacts.at(-1),
				deployments: s.deployments.filter((d) => d.state === "deployed"),
			}));
			const activity = snapshots
				.flatMap((s) => s.activity.map((event) => ({ ...event, repositoryId: s.repository.id, repositoryName: s.repository.name })))
				.sort((a, b) => b.at - a.at)
				.slice(0, 20);
			return json({
				...view,
				workspace: await directory.workspace(workspaceId),
				people: await directory.users(Object.keys(view.members)),
				repositorySummaries,
				activity,
			});
		}
		if (request.method === "PATCH") {
			workspaceMaintain(a);
			const body = z.object({ name: displayName, handle: name }).parse(await input(request));
			const w = await directory.rename(workspaceId, body);
			await workspace.metadata(w);
			return json(w);
		}
	}
	if (parts[3] === "members" && request.method === "POST") {
		const body = z.object({ userId: id, role: role.optional() }).parse(await input(request));
		await directory.user(body.userId);
		await workspace.member(grant, body.userId, body.role);
		return json({ saved: true });
	}
	if (parts[3] === "teams" && request.method === "POST") {
		const body = z.object({ id, name: displayName, members: z.array(id).max(1000) }).parse(await input(request));
		await workspace.team(grant, body.id, body.name, body.members);
		return json({ saved: true });
	}
	if (parts[3] === "invitations" && request.method === "POST") {
		const body = z.object({ email: z.email(), role }).parse(await input(request));
		const token = crypto.randomUUID() + crypto.randomUUID();
		await workspace.invite(grant, { id: crypto.randomUUID(), ...body, tokenHash: await hash(token), expiresAt: Date.now() + 7 * 86400000 });
		return json({ url: `${url.origin}/invite/${workspaceId}#${token}` });
	}
	if (parts[3] === "account" && request.method === "POST") {
		const body = z
			.union([
				z.object({ disconnect: z.literal(true) }),
				z.object({ accountId: z.string().regex(/^[0-9a-f]{32}$/), token: z.string().min(20).max(400), label: displayName.optional() }),
			])
			.parse(await input(request));
		return json(await workspace.account(grant, "disconnect" in body ? null : body));
	}
	if (parts[3] === "policy" && request.method === "POST") {
		const body = z
			.object({
				rules: z.record(z.enum(RESOURCE_ACTIONS), z.enum(["allow", "approval", "deny"])),
				dailyLimit: z.number().int().min(0).max(10000),
				previewsPerSession: z.number().int().min(0).max(1000),
			})
			.parse(await input(request));
		await workspace.policy(grant, body);
		return json({ saved: true });
	}
	if (parts[3] !== "repositories") throw new DomainError(404, "Not found");
	if (parts.length === 4) {
		if (request.method === "GET") return json((await workspace.snapshot(grant)).repositories);
		if (request.method === "POST") {
			workspaceMaintain(a);
			const body = repositoryInput.parse(await input(request));
			const repositoryId = (await hash(`${workspaceId}:${body.idempotencyKey}`)).slice(0, 32);
			const old = (await workspace.snapshot(grant)).repositories.find((r) => r.id === repositoryId);
			if (old && (old.name !== body.name || old.source.kind !== body.source || old.defaultBranch !== body.defaultBranch))
				throw new DomainError(409, "Creation key reused");
			const repo: Repository = old ?? {
				id: repositoryId,
				workspaceId,
				name: body.name,
				defaultBranch: body.defaultBranch,
				createdAt: Date.now(),
				source: { kind: body.source, ...(body.source === "artifacts" ? { storageName: `repo-${repositoryId}` } : {}) },
				grants: [],
				policy: { protectedPaths: [], requiredEvidence: ["tests"], resourceRules: {} },
			};
			if (!old) await workspace.saveRepository(grant, repo);
			if (body.source === "artifacts")
				await env.CONTROL_TOWER.getByName(repo.id).command(
					repo,
					{ tool: "provision_repository", repositoryId: repo.id, workspaceId, idempotencyKey: body.idempotencyKey },
					grant,
				);
			return json(repo, 201);
		}
	}
	const repositoryId = parts[4],
		repo = await workspace.repository(grant, repositoryId);
	if (parts.length === 5 && request.method === "PATCH") {
		const auth = await workspace.authority(grant, repositoryId);
		if (auth.repositoryRole !== "maintain") throw new DomainError(403, "Repository maintainer required");
		const body = z
			.object({
				name: name.optional(),
				grants: z.array(z.object({ subject: z.enum(["user", "team"]), id, role: z.enum(["read", "write", "maintain"]) })).optional(),
				policy: z
					.object({
						protectedPaths: z.array(path),
						requiredEvidence: z.array(z.string().min(1).max(80)),
						resourceRules: z.record(z.enum(RESOURCE_ACTIONS), z.enum(["allow", "approval", "deny"])).optional(),
					})
					.partial()
					.optional(),
			})
			.parse(await input(request));
		const updated = { ...repo, ...body, policy: { ...repo.policy, ...body.policy } };
		return json(await workspace.saveRepository(grant, updated));
	}
	if (request.method === "GET") {
		const tower = env.CONTROL_TOWER.getByName(repo.id);
		if (parts[5] === "export") {
			const revision = z
				.string()
				.regex(/^[a-f0-9]{40}$/)
				.parse(url.searchParams.get("revision"));
			const pack = await tower.exportSource(repo, revision, grant);
			return new Response(pack.slice().buffer, {
				headers: { "content-type": "application/x-git-packed-objects", "x-cruce-revision": revision },
			});
		}
		const snapshot = (await tower.command(repo, { tool: "get_repository", workspaceId, repositoryId }, grant)) as Record<string, unknown>;
		const section = parts[5];
		if (!section) return json(snapshot);
		const collections: Record<string, string> = {
			sessions: "sessions",
			changes: "proposals",
			artifacts: "artifacts",
			environments: "environments",
			deployments: "deployments",
			activity: "activity",
		};
		if (!collections[section] || parts.length > 7) throw new DomainError(404, "Not found");
		const records = snapshot[collections[section]] as { id: string }[];
		if (!parts[6]) return json(records);
		const record = records.find((r) => r.id === parts[6]);
		if (!record) throw new DomainError(404, "Record unavailable");
		return json(record);
	}
	if (parts[5] === "command" && request.method === "POST")
		return json(await execute({ ...z.record(z.string(), z.unknown()).parse(await input(request)), workspaceId, repositoryId }));
	throw new DomainError(404, "Not found");
}
