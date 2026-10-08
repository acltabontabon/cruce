import { type ApprovedConsent, AuthorizationError, type OAuthHelpers, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { DEFAULT_AGENT_SCOPES, SCOPES, type Scope } from "../core/capabilities.ts";
import { DomainError as CoordinationError, domainStatus } from "../core/errors.ts";
import { repositoryConsentTarget } from "../shared/repository-consent.ts";
import type { ConnectionMetadata } from "./connections.ts";
import { consentErrorPage, consentPage } from "./consent-page.ts";
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
export interface Identity {
	developerId: string;
	tenantId: string;
	email: string;
}
/** A console session: the Access identity bound to the Access token it was signed in with. */
export interface SessionIdentity extends Identity {
	accessJwt: string;
}
/**
 * An agent OAuth connection or paired terminal. It carries no Access token, so its lifetime is the connection's own
 * (OAuth grant or terminal authorization), not the browser session that approved it. Authority is rechecked per request.
 */
export interface AuthProps extends Identity {
	connectionId?: string;
	repositoryIds?: string[];
	clientName?: string;
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
function configuredIssuer(env: AuthEnv) {
	if (!env.CRUCE_ACCESS_ISSUER || !env.CRUCE_ACCESS_AUD) throw new CoordinationError(503, "Configure Cloudflare Access identity for Cruce");
	const issuer = new URL(env.CRUCE_ACCESS_ISSUER).origin;
	if (!/^https:\/\/[-\w]+\.cloudflareaccess\.com$/.test(issuer)) throw new CoordinationError(503, "Invalid Access issuer");
	return { issuer, audience: env.CRUCE_ACCESS_AUD };
}
/** Signature, issuer, audience and expiry are verified; proxy identity headers alone never grant access. */
export async function accessIdentity(env: AuthEnv, jwt: string, send: typeof fetch = fetch, now = Date.now()): Promise<SessionIdentity> {
	const { issuer, audience } = configuredIssuer(env);
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
			!claims.aud.includes(audience) ||
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
/** A console session stays valid only while its Access token does, and only for the subject it was issued to. */
async function validateSession(session: SessionIdentity, env: AuthEnv): Promise<SessionIdentity> {
	const current = await accessIdentity(env, session.accessJwt);
	if (current.developerId !== session.developerId || current.tenantId !== session.tenantId)
		throw new CoordinationError(403, "Identity changed");
	return current;
}
/**
 * Connection props are sealed server-side when the human approves the connection, so they are trusted as issued. The
 * connection must still belong to this installation's identity issuer; the caller resolves the user, and membership,
 * grants, approved repositories and scopes are rechecked downstream on every request.
 */
export function connectionIdentity(props: AuthProps, env: AuthEnv): AuthProps {
	const { issuer } = configuredIssuer(env);
	if (props.tenantId !== issuer || !props.developerId) throw new CoordinationError(401, "Reconnect this agent");
	return {
		developerId: props.developerId,
		tenantId: props.tenantId,
		email: props.email,
		connectionId: props.connectionId,
		repositoryIds: props.repositoryIds,
		clientName: props.clientName,
	};
}
/** Only the identity is handed to connections; the Access token stays with the browser session. */
export const identityOf = ({ developerId, tenantId, email }: Identity): Identity => ({ developerId, tenantId, email });
export async function consoleIdentity(request: Request, env: AuthEnv): Promise<SessionIdentity> {
	if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== new URL(request.url).origin)
		throw new CoordinationError(403, "Same-origin request required");
	const raw = cookie(request, "__Host-cruce");
	return raw ? validateSession(await unseal<SessionIdentity>(env, raw), env) : requestIdentity(request, env);
}
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
			const identity = await unseal<SessionIdentity>(env, raw);
			if (
				!identity ||
				typeof identity.accessJwt !== "string" ||
				typeof identity.developerId !== "string" ||
				typeof identity.tenantId !== "string"
			)
				throw new CoordinationError(401, "Session invalid");
			await validateSession(identity, env);
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
	const choices: { id: string; label: string; namespaceId: string }[] = [];
	for (const namespace of await directory.namespaces(user.id)) {
		try {
			const view = await env.NAMESPACE.getByName(namespace.id).snapshot({
				actor: { id: user.id, userId: user.id, kind: "human", name: user.name },
			});
			for (const repo of view.repositories)
				choices.push({ id: repo.id, label: `${namespace.handle}/${repo.name}`, namespaceId: namespace.id });
		} catch {}
	}
	const oauth = env.OAUTH_PROVIDER;
	if (!oauth) throw new CoordinationError(503, "OAuth unavailable");
	if (request.method === "GET") {
		const original = await oauth.parseAuthRequest(request),
			consent = await oauth.beginConsent(original),
			description = await oauth.describeConsent(original);
		let target: ReturnType<typeof repositoryConsentTarget>;
		try {
			target = repositoryConsentTarget(original.state);
		} catch {
			return consentErrorPage("This repository connection request is invalid. Start again from your tool.", request.url);
		}
		const offered = target ? choices.filter((r) => r.id === target.repositoryId && r.namespaceId === target.namespaceId) : choices;
		if (target && !offered.length)
			return consentErrorPage(
				"This repository is unavailable to your account. Check your access and start again from your tool.",
				request.url,
			);
		const requested = original.scope?.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
		const preset = requested?.length ? requested : DEFAULT_AGENT_SCOPES;
		return consentPage(
			{
				clientName: description.clientName ?? original.clientId,
				email: identity.email,
				handle: consent.handle,
				redirectUri: original.redirectUri,
				repositories: offered,
				boundRepository: !!target,
				preset,
			},
			consent.headers,
		);
	}
	const form = await request.formData();
	let approved: ApprovedConsent;
	try {
		approved = await oauth.approveConsent(request, String(form.get("handle")));
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error;
		return consentErrorPage(error.description, request.url);
	}
	let target: ReturnType<typeof repositoryConsentTarget>;
	try {
		target = repositoryConsentTarget(approved.request.state);
	} catch {
		return consentErrorPage("This repository connection request is invalid. Start again from your tool.", request.url);
	}
	const offered = target ? choices.filter((r) => r.id === target.repositoryId && r.namespaceId === target.namespaceId) : choices;
	const selected = form.getAll("repository").map(String);
	if (target && (offered.length !== 1 || selected.length !== 1 || selected[0] !== target.repositoryId))
		return consentErrorPage(
			"Repository access does not match this connection request. Check your access and start again from your tool.",
			request.url,
		);
	const chosen = form.getAll("scope").map(String),
		scope = SCOPES.filter((s) => s === "cruce:read" || chosen.includes(s)),
		requested = new Set(form.getAll("repository").map(String)),
		repositories = offered.filter((r) => requested.has(r.id)).map(({ id, label }) => ({ id, label })),
		connectionId = crypto.randomUUID(),
		clientName = (await oauth.describeConsent(approved.request)).clientName ?? "Agent",
		metadata: ConnectionMetadata = { connectionId, clientName, repositories },
		result = await oauth.completeAuthorization({
			request: approved.request,
			userId: identity.developerId,
			metadata,
			scope,
			props: { ...identityOf(identity), connectionId, repositoryIds: repositories.map((r) => r.id), clientName },
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
