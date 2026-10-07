import { type ApprovedConsent, AuthorizationError, type OAuthHelpers, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { DEFAULT_AGENT_SCOPES, SCOPE_LABELS, SCOPES, type Scope } from "../core/capabilities.ts";
import { DomainError as CoordinationError, domainStatus } from "../core/errors.ts";
import type { Directory } from "./directory.ts";
import { namespaceDirectory } from "./directory-access.ts";
import type { NamespaceRuntime } from "./namespace-runtime.ts";
import { decode, seal, unseal } from "./sealing.ts";

export { seal, unseal };
export interface AuthEnv {
	DIRECTORY: DurableObjectNamespace<Directory>;
	NAMESPACE: DurableObjectNamespace<NamespaceRuntime>;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER?: OAuthHelpers;
	CRUCE_SECRET?: string;
	CRUCE_PUBLIC_ORIGIN?: string;
	CRUCE_ACCESS_ISSUER?: string;
	CRUCE_ACCESS_AUD?: string;
}
export interface AuthProps {
	connectionId?: string;
	repositoryIds?: string[];
	clientName?: string;
	developerId: string;
	tenantId: string;
	email: string;
	accessJwt: string;
}
function cookie(request: Request, name: string) {
	return request.headers
		.get("cookie")
		?.split(";")
		.map((s) => s.trim())
		.find((s) => s.startsWith(`${name}=`))
		?.slice(name.length + 1);
}
const keys = new Map<string, { at: number; keys: (JsonWebKey & { kid?: string })[] }>();
/** Signature, issuer, audience and expiry are verified; proxy identity headers alone never grant access. */
export async function accessIdentity(env: AuthEnv, jwt: string, send: typeof fetch = fetch, now = Date.now()): Promise<AuthProps> {
	if (!env.CRUCE_ACCESS_ISSUER || !env.CRUCE_ACCESS_AUD) throw new CoordinationError(503, "Configure Cloudflare Access identity for Cruce");
	const issuer = new URL(env.CRUCE_ACCESS_ISSUER).origin;
	if (!/^https:\/\/[-\w]+\.cloudflareaccess\.com$/.test(issuer)) throw new CoordinationError(503, "Invalid Access issuer");
	try {
		const [h, b, signature, ...rest] = jwt.split(".");
		if (rest.length || !signature) throw new Error();
		const header = JSON.parse(new TextDecoder().decode(decode(h))) as { alg: string; kid: string },
			claims = JSON.parse(new TextDecoder().decode(decode(b))) as {
				iss: string;
				aud: string[];
				exp: number;
				nbf?: number;
				sub: string;
				email: string;
				type?: string;
			};
		if (
			header.alg !== "RS256" ||
			claims.iss !== issuer ||
			!Array.isArray(claims.aud) ||
			!claims.aud.includes(env.CRUCE_ACCESS_AUD) ||
			!Number.isFinite(claims.exp) ||
			claims.exp * 1000 <= now ||
			(claims.nbf ?? 0) * 1000 > now ||
			!claims.sub ||
			!claims.email ||
			claims.type === "service"
		)
			throw new Error();
		let cached = keys.get(issuer);
		if (!cached || now - cached.at > 300000 || !cached.keys.some((k) => k.kid === header.kid)) {
			try {
				const response = await send(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
				if (!response.ok) throw new Error();
				const document = (await response.json()) as { keys: (JsonWebKey & { kid?: string })[] };
				if (!Array.isArray(document.keys)) throw new Error();
				cached = { at: now, keys: document.keys };
			} catch {
				throw new CoordinationError(503, "Access identity verification unavailable; retry");
			}
			keys.set(issuer, cached);
		}
		const jwk = cached.keys.find((k) => k.kid === header.kid);
		if (!jwk) throw new Error();
		const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
		if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decode(signature), new TextEncoder().encode(`${h}.${b}`))))
			throw new Error();
		return { developerId: claims.sub, tenantId: issuer, email: claims.email, accessJwt: jwt };
	} catch (error) {
		if (domainStatus(error) === 503) throw error;
		throw new CoordinationError(401, "Access identity invalid or expired");
	}
}
export async function requestIdentity(request: Request, env: AuthEnv) {
	const jwt = request.headers.get("cf-access-jwt-assertion") ?? cookie(request, "CF_Authorization");
	if (!jwt) throw new CoordinationError(401, "Sign in through Cloudflare Access");
	return accessIdentity(env, jwt);
}
export async function validateIdentity(props: AuthProps, env: AuthEnv) {
	const current = await accessIdentity(env, props.accessJwt);
	if (current.developerId !== props.developerId || current.tenantId !== props.tenantId)
		throw new CoordinationError(403, "Identity changed");
	return { ...current, connectionId: props.connectionId, repositoryIds: props.repositoryIds, clientName: props.clientName };
}
export async function consoleIdentity(request: Request, env: AuthEnv) {
	if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== new URL(request.url).origin)
		throw new CoordinationError(403, "Same-origin request required");
	const raw = cookie(request, "__Host-cruce");
	return raw ? validateIdentity(await unseal<AuthProps>(env, raw), env) : requestIdentity(request, env);
}
const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export async function authRoute(request: Request, env: AuthEnv): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (!["/authorize", "/auth/login", "/auth/logout", "/auth/session"].includes(url.pathname)) return;
	if (env.CRUCE_PUBLIC_ORIGIN && url.origin !== new URL(env.CRUCE_PUBLIC_ORIGIN).origin)
		throw new CoordinationError(403, "Identity origin mismatch");
	if (url.pathname === "/auth/session") {
		const headers = { "cache-control": "no-store" };
		if (request.method !== "GET") return Response.json({ error: "GET required" }, { status: 405, headers: { ...headers, allow: "GET" } });
		const raw = cookie(request, "__Host-cruce");
		if (!raw) return Response.json({ authenticated: false }, { headers });
		if (!env.CRUCE_SECRET) throw new CoordinationError(503, "Identity encryption not configured");
		try {
			const identity = await unseal<AuthProps>(env, raw);
			if (
				!identity ||
				typeof identity.accessJwt !== "string" ||
				typeof identity.developerId !== "string" ||
				typeof identity.tenantId !== "string"
			)
				throw new CoordinationError(401, "Session invalid");
			await validateIdentity(identity, env);
			return Response.json({ authenticated: true }, { headers });
		} catch (error) {
			if (![401, 403].includes(domainStatus(error) ?? 500)) throw error;
			return Response.json({ authenticated: false }, { headers });
		}
	}
	if (url.pathname === "/auth/logout")
		return new Response(null, {
			status: 302,
			headers: {
				location: "/cdn-cgi/access/logout",
				"set-cookie": "__Host-cruce=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
				"cache-control": "no-store",
			},
		});
	const identity = await requestIdentity(request, env);
	// Identity and personal namespace initialization belong to explicit sign-in/authorization,
	// never to coordination routing or terminal approval.
	const directory = namespaceDirectory(env);
	const user = await directory.login(identity);
	const personal = await directory.namespace(user.personalNamespaceId);
	await env.NAMESPACE.getByName(personal.id).initialize(personal);
	if (url.pathname === "/auth/login")
		return new Response(null, {
			status: 302,
			headers: {
				location: "/",
				"set-cookie": `__Host-cruce=${await seal(env, identity)}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800`,
				"cache-control": "no-store",
			},
		});
	const choices: { id: string; label: string }[] = [];
	for (const namespace of await directory.namespaces(user.id)) {
		try {
			const view = await env.NAMESPACE.getByName(namespace.id).snapshot({
				actor: { id: user.id, userId: user.id, kind: "human", name: user.name },
			});
			for (const repo of view.repositories) choices.push({ id: repo.id, label: `${namespace.handle}/${repo.name}` });
		} catch {}
	}
	const oauth = env.OAUTH_PROVIDER;
	if (!oauth) throw new CoordinationError(503, "OAuth unavailable");
	if (request.method === "GET") {
		const original = await oauth.parseAuthRequest(request),
			consent = await oauth.beginConsent(original),
			description = await oauth.describeConsent(original);
		const requested = original.scope?.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
		const preset = requested?.length ? requested : DEFAULT_AGENT_SCOPES;
		const options = SCOPES.map(
			(scope) =>
				`<label><input type="checkbox" name="scope" value="${scope}"${preset.includes(scope) ? " checked" : ""}${scope === "cruce:read" ? " disabled checked" : ""}> <code>${scope}</code> — ${escapeHtml(SCOPE_LABELS[scope])}</label><br>`,
		).join("");
		consent.headers.set("content-type", "text/html; charset=utf-8");
		return new Response(
			`<html lang="en"><meta charset="utf-8"><title>Connect to Cruce</title><h1>Connect to Cruce</h1><p>${escapeHtml(description.clientName ?? original.clientId)} requests access to the repositories you select.</p><p>Signed in as ${escapeHtml(identity.email)}.</p><form method="post"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><fieldset><legend>Allow this agent to</legend>${options}</fieldset><fieldset><legend>Repositories</legend>${choices.map((r) => `<label><input type="checkbox" name="repository" value="${escapeHtml(r.id)}"> ${escapeHtml(r.label)}</label><br>`).join("")}</fieldset><p>Source promotion remains a human decision. CI, release and deployment remain outside Cruce. Metered Cloudflare operations stay subject to namespace resource policy.</p><p>Redirect: ${escapeHtml(original.redirectUri)}</p><button>Allow</button></form><a href="/">Cancel</a></html>`,
			{ headers: consent.headers },
		);
	}
	const form = await request.formData();
	let approved: ApprovedConsent;
	try {
		approved = await oauth.approveConsent(request, String(form.get("handle")));
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error;
		return new Response(
			`<html lang="en"><meta charset="utf-8"><title>Connection not authorized</title><h1>Connection not authorized</h1><p>${escapeHtml(error.description)}</p><a href="${escapeHtml(request.url)}">Start again</a></html>`,
			{ status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
		);
	}
	const chosen = form.getAll("scope").map(String),
		scope = SCOPES.filter((s) => s === "cruce:read" || chosen.includes(s)),
		result = await oauth.completeAuthorization({
			request: approved.request,
			userId: identity.developerId,
			metadata: {},
			scope,
			props: {
				...identity,
				connectionId: crypto.randomUUID(),
				repositoryIds: form
					.getAll("repository")
					.map(String)
					.filter((id) => choices.some((r) => r.id === id)),
				clientName: (await oauth.describeConsent(approved.request)).clientName ?? "Agent",
			},
		});
	approved.headers.set("location", result.redirectTo);
	return new Response(null, { status: 302, headers: approved.headers });
}
export function oauthProvider<E extends AuthEnv>(api: ExportedHandler<E>, fallback: ExportedHandler<E>, origin: string) {
	return new OAuthProvider<E>({
		apiRoute: "/mcp",
		apiHandler: api as never,
		defaultHandler: fallback,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
		clientIdMetadataDocumentEnabled: false,
		scopesSupported: [...SCOPES, "offline_access"],
		requiredScopes: ["cruce:read"],
		resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
	});
}
