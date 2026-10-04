import { type OAuthHelpers, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { CoordinationError } from "../core/workstreams.ts";
export interface AuthEnv {
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER?: OAuthHelpers;
	CRUCE_SECRET?: string;
	CRUCE_PUBLIC_ORIGIN?: string;
	CRUCE_ACCESS_ISSUER?: string;
	CRUCE_ACCESS_AUD?: string;
}
export interface AuthProps {
	developerId: string;
	tenantId: string;
	email: string;
	accessJwt: string;
}
const encode = (b: Uint8Array) =>
	btoa(String.fromCharCode(...b))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
const decode = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
async function key(secret?: string) {
	if (!secret) throw new CoordinationError(503, "Identity encryption not configured");
	return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}
export async function seal(env: AuthEnv, data: unknown) {
	const iv = crypto.getRandomValues(new Uint8Array(12)),
		cipher = new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env.CRUCE_SECRET), new TextEncoder().encode(JSON.stringify(data))),
		);
	return `${encode(iv)}.${encode(cipher)}`;
}
export async function unseal<T>(env: AuthEnv, value: string): Promise<T> {
	try {
		const [iv, cipher] = value.split(".");
		return JSON.parse(
			new TextDecoder().decode(
				await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await key(env.CRUCE_SECRET), decode(cipher)),
			),
		);
	} catch {
		throw new CoordinationError(401, "Sign in again");
	}
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
			const response = await send(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
			if (!response.ok) throw new Error();
			cached = { at: now, keys: ((await response.json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys };
			keys.set(issuer, cached);
		}
		const jwk = cached.keys.find((k) => k.kid === header.kid);
		if (!jwk) throw new Error();
		const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
		if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decode(signature), new TextEncoder().encode(`${h}.${b}`))))
			throw new Error();
		return { developerId: claims.sub, tenantId: issuer, email: claims.email, accessJwt: jwt };
	} catch {
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
	return current;
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
	if (!["/authorize", "/auth/login", "/auth/logout"].includes(url.pathname)) return;
	if (env.CRUCE_PUBLIC_ORIGIN && url.origin !== new URL(env.CRUCE_PUBLIC_ORIGIN).origin)
		throw new CoordinationError(403, "Identity origin mismatch");
	if (url.pathname === "/auth/logout")
		return new Response(null, {
			status: 302,
			headers: { location: "/", "set-cookie": "__Host-cruce=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" },
		});
	const identity = await requestIdentity(request, env);
	if (url.pathname === "/auth/login")
		return new Response(null, {
			status: 302,
			headers: {
				location: "/",
				"set-cookie": `__Host-cruce=${await seal(env, identity)}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800`,
				"cache-control": "no-store",
			},
		});
	const oauth = env.OAUTH_PROVIDER;
	if (!oauth) throw new CoordinationError(503, "OAuth unavailable");
	if (request.method === "GET") {
		const original = await oauth.parseAuthRequest(request),
			consent = await oauth.beginConsent(original),
			description = await oauth.describeConsent(original);
		return new Response(
			`<html lang="en"><meta charset="utf-8"><title>Connect to Cruce</title><h1>Connect to Cruce</h1><p>${escapeHtml(description.clientName ?? original.clientId)} requests coordination access to systems you can contribute to.</p><p>Signed in as ${escapeHtml(identity.email)}.</p><p>Agents can propose and report evidence. This connection does not grant promotion authority.</p><p>Redirect: ${escapeHtml(original.redirectUri)}</p><form method="post"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><button>Allow coordination</button></form><a href="/">Cancel</a></html>`,
			{ headers: consent.headers },
		);
	}
	const form = await request.formData(),
		approved = await oauth.approveConsent(request, String(form.get("handle"))),
		result = await oauth.completeAuthorization({
			request: approved.request,
			userId: identity.developerId,
			metadata: {},
			scope: ["coordination"],
			props: identity,
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
		scopesSupported: ["coordination", "offline_access"],
		requiredScopes: ["coordination"],
		resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
	});
}
