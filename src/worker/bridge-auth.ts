import { DomainError } from "../core/errors.ts";
import { consoleIdentity, type Identity, identityOf } from "./auth.ts";
import { namespaceDirectory } from "./directory-access.ts";
import { input, json, type PlatformEnv, platformRoute } from "./platform-router.ts";
import { hash } from "./store.ts";

interface Pair {
	workspaceId?: string;
	namespaceId: string;
	repositoryId: string;
	proof: string;
	token?: string;
	expiresAt: number;
}
export async function bridgeRoute(request: Request, env: PlatformEnv, ctx: ExecutionContext) {
	const url = new URL(request.url);
	const git = url.pathname.startsWith("/mcp/git/");
	if (!url.pathname.startsWith("/bridge/") && !git) return;
	if (url.pathname === "/bridge/start" && request.method === "POST") {
		const body = (await input(request)) as { namespaceId: string; repositoryId: string; workspaceId?: string };
		if (!/^[a-zA-Z0-9-]{1,160}$/.test(body.namespaceId) || !/^[a-zA-Z0-9-]{1,160}$/.test(body.repositoryId))
			throw new DomainError(400, "Namespace and repository required");
		const code = crypto.randomUUID(),
			proof = crypto.randomUUID();
		await env.OAUTH_KV.put(
			`pair:${code}`,
			JSON.stringify({
				workspaceId: body.workspaceId,
				namespaceId: body.namespaceId,
				repositoryId: body.repositoryId,
				proof: await hash(proof),
				expiresAt: Date.now() + 300000,
			}),
			{ expirationTtl: 300 },
		);
		return json({ code, proof, url: `${url.origin}/bridge/approve?code=${code}` });
	}
	if (url.pathname === "/bridge/approve") {
		const identity = await consoleIdentity(request, env),
			code = url.searchParams.get("code") ?? "";
		const pair = await env.OAUTH_KV.get<Pair>(`pair:${code}`, "json");
		if (!pair || pair.expiresAt < Date.now()) throw new DomainError(403, "Pairing request expired");
		const directory = namespaceDirectory(env),
			user = await directory.resolve(identity);
		const repo = await env.NAMESPACE.getByName(pair.namespaceId).repository(
			{ actor: { id: user.id, userId: user.id, name: user.name, kind: "human" } },
			pair.repositoryId,
		);
		if (request.method === "GET")
			return new Response(
				`<html lang="en"><title>Connect terminal</title><h1>Authorize your terminal</h1><p>This terminal will act as you in one workspace on ${repo.name}. It cannot administer the namespace, approve reviews, or promote source.</p><form method="post"><button>Authorize terminal workspace</button></form></html>`,
				{
					headers: {
						"content-type": "text/html; charset=utf-8",
						"content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
					},
				},
			);
		if (request.method !== "POST") throw new DomainError(405, "POST required");
		if (pair.token) return new Response("Already authorized. Return to your terminal.");
		let connectionId: string = crypto.randomUUID();
		if (pair.workspaceId) {
			const workspace = (await env.CONTROL_TOWER.getByName(repo.id).command(
				repo,
				{ tool: "get_workspace", namespaceId: pair.namespaceId, repositoryId: repo.id, workspaceId: pair.workspaceId },
				{ actor: { id: user.id, userId: user.id, name: user.name, kind: "human" } },
			)) as import("../shared/platform.ts").Workspace;
			// Renewal reuses the terminal connection that started the workspace, keeping its single-workspace binding.
			if (
				workspace.ownerId !== user.id ||
				workspace.createdBy.kind !== "human" ||
				!workspace.createdBy.connectionId ||
				["completed", "cancelled"].includes(workspace.state)
			)
				throw new DomainError(403, "Only your own unfinished terminal workspace can be renewed");
			connectionId = workspace.createdBy.connectionId;
		}
		const token = crypto.randomUUID() + crypto.randomUUID(),
			key = `bridge:${await hash(token)}`;
		await env.OAUTH_KV.put(
			key,
			JSON.stringify({
				// The terminal keeps the identity, never the browser's Access token; its 30-minute authorization is its lifetime.
				identity: identityOf(identity),
				namespaceId: pair.namespaceId,
				repositoryId: pair.repositoryId,
				connectionId,
				workspaceId: pair.workspaceId,
				tokenKey: key,
			}),
			{ expirationTtl: 1800 },
		);
		await env.OAUTH_KV.put(`pair:${code}`, JSON.stringify({ ...pair, token }), { expirationTtl: 300 });
		return new Response("Authorized. Return to your terminal.");
	}
	if (url.pathname === "/bridge/poll" && request.method === "POST") {
		const body = (await input(request)) as { code: string; proof: string };
		if (typeof body.proof !== "string" || body.proof.length > 200) throw new DomainError(400, "Pairing proof required");
		const pair = await env.OAUTH_KV.get<Pair>(`pair:${body.code}`, "json");
		if (!pair || pair.expiresAt < Date.now() || pair.proof !== (await hash(body.proof)))
			throw new DomainError(403, "Pairing request invalid");
		return json({ token: pair.token });
	}
	if (url.pathname === "/bridge/command" || git) {
		const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
		if (!token || token.length > 200) throw new DomainError(401, "Terminal authorization required");
		const bridge = await env.OAUTH_KV.get<{
			identity: Identity;
			repositoryId: string;
			namespaceId: string;
			connectionId: string;
			tokenKey: string;
			workspaceId?: string;
		}>(`bridge:${await hash(token)}`, "json");
		if (!bridge) throw new DomainError(401, "Terminal authorization expired");
		return platformRoute(request, env, ctx, undefined, undefined, bridge);
	}
	throw new DomainError(404, "Not found");
}
