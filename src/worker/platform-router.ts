import { z } from "zod";
import { namespaceMaintain, SCOPES, type Scope } from "../core/capabilities.ts";
import { DomainError, requireValue } from "../core/errors.ts";
import { repositorySummary } from "../shared/coordination.ts";
import { parseGitRoute } from "../shared/git-access.ts";
import { type Actor, branch, CommandInput, id, name, path, RESOURCE_ACTIONS, type Repository } from "../shared/platform.ts";
import { type AuthEnv, type AuthProps, consoleIdentity, validateIdentity } from "./auth.ts";
import type { ControlTower } from "./control-tower.ts";
import { namespaceDirectory } from "./directory-access.ts";
import { remoteMcp } from "./mcp.ts";
import type { ConnectionGrant } from "./namespace-runtime.ts";
import { hash } from "./store.ts";
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
	idempotencyKey: id,
});
const humanBridgeTools = new Set([
	"get_repository",
	"get_context",
	"get_workspace",
	"list_active_workspaces",
	"inspect_overlap",
	"get_source",
	"get_git_access",
	"cleanup_workspace",
	"get_history",
	"get_diff",
	"read_artifact",
	"get_lineage",
	"start_workspace",
	"attach_workspace",
	"heartbeat",
	"report_change",
	"report_ref",
	"end_workspace",
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
	bridge?: { identity: AuthProps; repositoryId: string; namespaceId: string; connectionId: string; tokenKey: string; workspaceId?: string },
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
	const directory = namespaceDirectory(env),
		user = await directory.login(identity);
	const personal = await directory.namespace(user.personalNamespaceId);
	await env.NAMESPACE.getByName(personal.id).initialize(personal);
	const actor: Actor = {
		id: props ? `agent-${requireValue(props.connectionId, "Reconnect this agent")}` : user.id,
		userId: user.id,
		kind: props ? "agent" : "human",
		name: props?.clientName ?? user.name,
		connectionId: props?.connectionId ?? bridge?.connectionId,
	};
	const grant: ConnectionGrant = { actor, scopes, repositories: props?.repositoryIds };
	if (url.pathname.startsWith("/mcp/git/")) {
		if (!props && !bridge) throw new DomainError(401, "Git requires a Cruce connection");
		const route = requireValue(parseGitRoute(url), "Unsupported Git route");
		if (
			bridge &&
			(route.namespaceId !== bridge.namespaceId ||
				route.repositoryId !== bridge.repositoryId ||
				(route.workspaceId && bridge.workspaceId && route.workspaceId !== bridge.workspaceId))
		)
			throw new DomainError(403, "Terminal Git scope denied");
		const repo = await env.NAMESPACE.getByName(route.namespaceId).repository(grant, route.repositoryId);
		return env.CONTROL_TOWER.getByName(repo.id).gitRequest(repo, request, grant);
	}
	const namespaces = async () => {
		const allowed = [];
		for (const w of await directory.namespaces())
			try {
				const view = await env.NAMESPACE.getByName(w.id).snapshot(grant);
				if (!props || view.repositories.length) allowed.push(w);
			} catch {}
		return allowed;
	};
	const execute = async (raw: unknown) => {
		const cmd = CommandInput.parse(raw);
		if (cmd.tool === "list_namespaces") return namespaces();
		const namespaceId = requireValue(cmd.namespaceId, "Namespace required"),
			namespace = env.NAMESPACE.getByName(namespaceId);
		if (cmd.tool === "list_repositories") return (await namespace.snapshot(grant)).repositories;
		const repositoryId = requireValue(cmd.repositoryId, "Repository required"),
			repo = await namespace.repository(grant, repositoryId);
		if (bridge) {
			if (namespaceId !== bridge.namespaceId || repositoryId !== bridge.repositoryId || !humanBridgeTools.has(cmd.tool))
				throw new DomainError(403, "Human bridge workspace scope denied");
			// The repository DO enforces workspace binding atomically, including lost-response retries.
		}
		const result = await env.CONTROL_TOWER.getByName(repo.id).command(repo, cmd, grant);
		if (bridge && cmd.tool === "start_workspace") {
			bridge.workspaceId = (result as { id: string }).id;
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
	if (url.pathname === "/api/me" && request.method === "GET") return json({ user, namespaces: await namespaces() });
	if (url.pathname === "/api/namespaces") {
		if (request.method === "GET") return json(await namespaces());
		if (request.method === "POST") {
			const body = z.object({ name: displayName, handle: name, idempotencyKey: id }).parse(await input(request));
			const namespaceId = (await hash(`${user.id}:${body.idempotencyKey}`)).slice(0, 32);
			const w = await directory.create(user, body, namespaceId);
			await env.NAMESPACE.getByName(w.id).initialize(w);
			return json(w, 201);
		}
	}
	if (parts[1] !== "namespaces" || !parts[2]) throw new DomainError(404, "Not found");
	const namespaceId = parts[2],
		namespace = env.NAMESPACE.getByName(namespaceId);
	if (parts[3] === "accept" && request.method === "POST") {
		const body = z.object({ token: z.string().min(20).max(200) }).parse(await input(request));
		await namespace.accept(user, await hash(body.token));
		return json({ accepted: true });
	}
	const a = await namespace.authority(grant);
	if (parts.length === 3) {
		if (request.method === "GET") {
			const view = await namespace.snapshot(grant);
			const snapshots = await Promise.all(
				view.repositories.map(
					(repo) =>
						env.CONTROL_TOWER.getByName(repo.id).command(
							repo,
							{ tool: "get_repository", namespaceId, repositoryId: repo.id },
							grant,
						) as Promise<import("../shared/platform.ts").RepositorySnapshot>,
				),
			);
			const repositorySummaries = snapshots.map(repositorySummary);
			const activity = snapshots
				.flatMap((s) => s.activity.map((event) => ({ ...event, repositoryId: s.repository.id, repositoryName: s.repository.name })))
				.sort((a, b) => b.at - a.at)
				.slice(0, 20);
			return json({
				...view,
				namespace: await directory.namespace(namespaceId),
				people: await directory.users(Object.keys(view.members)),
				repositorySummaries,
				activity,
			});
		}
		if (request.method === "PATCH") {
			namespaceMaintain(a);
			const body = z.object({ name: displayName, handle: name }).parse(await input(request));
			const w = await directory.rename(namespaceId, body);
			await namespace.metadata(w);
			return json(w);
		}
	}
	if (parts[3] === "members" && request.method === "POST") {
		const body = z.object({ userId: id, role: role.optional() }).parse(await input(request));
		await directory.user(body.userId);
		await namespace.member(grant, body.userId, body.role);
		return json({ saved: true });
	}
	if (parts[3] === "teams" && request.method === "POST") {
		const body = z.object({ id, name: displayName, members: z.array(id).max(1000) }).parse(await input(request));
		await namespace.team(grant, body.id, body.name, body.members);
		return json({ saved: true });
	}
	if (parts[3] === "invitations" && request.method === "POST") {
		const body = z.object({ email: z.email(), role }).parse(await input(request));
		const token = crypto.randomUUID() + crypto.randomUUID();
		await namespace.invite(grant, { id: crypto.randomUUID(), ...body, tokenHash: await hash(token), expiresAt: Date.now() + 7 * 86400000 });
		return json({ url: `${url.origin}/invite/${namespaceId}#${token}` });
	}
	if (parts[3] === "account" && request.method === "POST") {
		const body = z
			.union([
				z.object({ disconnect: z.literal(true) }),
				z.object({ accountId: z.string().regex(/^[0-9a-f]{32}$/), token: z.string().min(20).max(400), label: displayName.optional() }),
			])
			.parse(await input(request));
		return json(await namespace.account(grant, "disconnect" in body ? null : body));
	}
	if (parts[3] === "policy" && request.method === "POST") {
		const body = z
			.object({
				rules: z.record(z.enum(RESOURCE_ACTIONS), z.enum(["allow", "approval", "deny"])),
				dailyLimit: z.number().int().min(0).max(10000),
			})
			.parse(await input(request));
		await namespace.policy(grant, body);
		return json({ saved: true });
	}
	if (parts[3] !== "repositories") throw new DomainError(404, "Not found");
	if (parts.length === 4) {
		if (request.method === "GET") return json((await namespace.snapshot(grant)).repositories);
		if (request.method === "POST") {
			namespaceMaintain(a);
			const body = repositoryInput.parse(await input(request));
			const repositoryId = (await hash(`${namespaceId}:${body.idempotencyKey}`)).slice(0, 32);
			const old = (await namespace.snapshot(grant)).repositories.find((r) => r.id === repositoryId);
			if (old && (old.name !== body.name || old.defaultBranch !== body.defaultBranch)) throw new DomainError(409, "Creation key reused");
			const repo: Repository = old ?? {
				id: repositoryId,
				namespaceId,
				name: body.name,
				defaultBranch: body.defaultBranch,
				createdAt: Date.now(),
				storageName: `repo-${repositoryId}`,
				grants: [],
				policy: { protectedPaths: [], requiredEvidence: ["tests"], resourceRules: {} },
			};
			if (!old) await namespace.saveRepository(grant, repo);
			await env.CONTROL_TOWER.getByName(repo.id).command(
				repo,
				{ tool: "provision_repository", repositoryId: repo.id, namespaceId, idempotencyKey: body.idempotencyKey },
				grant,
			);
			return json(repo, 201);
		}
	}
	const repositoryId = parts[4],
		repo = await namespace.repository(grant, repositoryId);
	if (parts.length === 5 && request.method === "PATCH") {
		const auth = await namespace.authority(grant, repositoryId);
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
		return json(await namespace.saveRepository(grant, updated));
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
		const snapshot = (await tower.command(repo, { tool: "get_repository", namespaceId, repositoryId }, grant)) as Record<string, unknown>;
		const section = parts[5];
		if (!section) return json(snapshot);
		const collections: Record<string, string> = {
			workspaces: "workspaces",
			changes: "proposals",
			artifacts: "artifacts",
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
		return json(await execute({ ...z.record(z.string(), z.unknown()).parse(await input(request)), namespaceId, repositoryId }));
	throw new DomainError(404, "Not found");
}
