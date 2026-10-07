import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryController } from "../../src/core/ownership.ts";
import { repositoryConsentState } from "../../src/shared/repository-consent.ts";
import { type AuthEnv, accessIdentity, authRoute, connectionIdentity, oauthProvider, seal, unseal } from "../../src/worker/auth.ts";
import { bridgeRoute } from "../../src/worker/bridge-auth.ts";
import type { PlatformEnv } from "../../src/worker/platform-router.ts";

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
	DurableObject: class {
		constructor(readonly ctx: DurableObjectState) {}
	},
}));

describe("agent transport authorization boundary", () => {
	const origin = "https://cruce.example.test";
	function boundary() {
		const api = vi.fn(() => new Response("authorized"));
		const provider = oauthProvider({ fetch: api }, { fetch: () => new Response("browser route") }, origin);
		const write = vi.fn();
		const env = { OAUTH_KV: { get: async () => null, put: write, delete: write }, CRUCE_PUBLIC_ORIGIN: origin } as unknown as AuthEnv;
		const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
		return { provider, api, write, env, ctx };
	}
	it.each([undefined, "Bearer invalid"])("rejects an agent without a valid token (%s)", async (authorization) => {
		const b = boundary();
		const headers = authorization ? { Authorization: authorization } : undefined;
		const response = await b.provider.fetch(new Request(`${origin}/mcp`, { headers }), b.env, b.ctx);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("Bearer");
		expect(b.api).not.toHaveBeenCalled();
		expect(b.write).not.toHaveBeenCalled();
	});
	it("publishes discovery without issuing access, and rejects fabricated authorization codes", async () => {
		const b = boundary();
		const metadata = await b.provider.fetch(new Request(`${origin}/.well-known/oauth-authorization-server`), b.env, b.ctx);
		expect(metadata.status).toBe(200);
		expect(await metadata.json()).toMatchObject({ authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/oauth/token` });
		const token = await b.provider.fetch(
			new Request(`${origin}/oauth/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "grant_type=authorization_code&client_id=invalid&code=invalid&code_verifier=invalid",
			}),
			b.env,
			b.ctx,
		);
		expect(token.status).toBeGreaterThanOrEqual(400);
		expect(await token.json()).not.toHaveProperty("access_token");
		expect(b.api).not.toHaveBeenCalled();
		expect(b.write).not.toHaveBeenCalled();
	});
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function identityFixture() {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	const kid = crypto.randomUUID(),
		issuer = `https://identity-${crypto.randomUUID()}.cloudflareaccess.com`,
		env = { CRUCE_ACCESS_ISSUER: issuer, CRUCE_ACCESS_AUD: "app", CRUCE_SECRET: "fixture-encryption-only" } as AuthEnv;
	const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
	const send = vi.fn(async () => Response.json({ keys: [jwk] })) as unknown as typeof fetch;
	const token = async (claims: Record<string, unknown> = {}) => {
		const input = `${encode({ alg: "RS256", kid })}.${encode({ iss: issuer, aud: ["app"], exp: 2000, sub: "person", email: "person@example.test", ...claims })}`;
		const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
		return `${input}.${Buffer.from(signature).toString("base64url")}`;
	};
	return { env, send, token };
}
describe("native identity", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("explicit sign-in initializes one stable identity and personal namespace before issuing a session", async () => {
		const f = await identityFixture();
		vi.stubGlobal("fetch", f.send);
		let id = 0;
		const c = new DirectoryController({ users: [], namespaces: [] }, 1000, () => `id-${++id}`);
		const initialize = vi.fn(async () => {});
		const directory = {
			login: vi.fn(async (v: { tenantId: string; developerId: string; email: string }) => c.login(v.tenantId, v.developerId, v.email)),
			namespace: async (id: string) => c.state.namespaces.find((n) => n.id === id),
		};
		const env = {
			...f.env,
			DIRECTORY: { getByName: () => directory },
			NAMESPACE: { getByName: () => ({ initialize }) },
		} as unknown as AuthEnv;
		const request = new Request("https://cruce.example.test/auth/login", {
			headers: { "cf-access-jwt-assertion": await f.token({ exp: Math.floor(Date.now() / 1000) + 600 }) },
		});
		const responses = await Promise.all(Array.from({ length: 5 }, () => authRoute(request, env)));
		expect(c.state.users).toHaveLength(1);
		expect(c.state.namespaces).toHaveLength(1);
		for (const response of responses) {
			expect(response!.status).toBe(302);
			expect(response!.headers.get("set-cookie")).toContain("__Host-cruce=");
		}
		expect(initialize).toHaveBeenCalledWith(c.state.namespaces[0]);
		initialize.mockRejectedValueOnce(new Error("Interrupted personal setup"));
		await expect(authRoute(request, env)).rejects.toThrow("Interrupted personal setup");
		expect((await authRoute(request, env))!.status).toBe(302);
		expect(c.state.users).toHaveLength(1);
		expect(c.state.namespaces).toHaveLength(1);
	});
	it.each(["generic", "bound", "unavailable", "rejected"])(
		"renders consent and rejected-consent retry pages as HTML (%s)",
		async (mode) => {
			const rejected = mode === "rejected";
			const f = await identityFixture();
			vi.stubGlobal("fetch", f.send);
			const consentHeaders = new Headers({ "set-cookie": "consent=fixture; Secure; HttpOnly", "cache-control": "no-store" });
			const namespace = { id: "namespace", handle: "test", ownerId: "owner" };
			const repo = { id: "repo", name: "gateway-check" };
			const env = {
				...f.env,
				DIRECTORY: {
					getByName: () => ({
						login: async () => ({ id: "owner", name: "Owner", personalNamespaceId: namespace.id }),
						namespace: async () => namespace,
						namespaces: async () => [namespace],
					}),
				},
				NAMESPACE: { getByName: () => ({ initialize: async () => {}, snapshot: async () => ({ repositories: [repo] }) }) },
				OAUTH_PROVIDER: {
					approveConsent: vi.fn(async () => {
						throw new AuthorizationError("invalid_request", { description: "This authorization expired <fixture>; start again" });
					}),
					completeAuthorization: vi.fn(),
					parseAuthRequest: async () => ({
						clientId: "client",
						scope: ["cruce:read"],
						redirectUri: "http://127.0.0.1:12345/callback",
						state:
							mode === "bound" || mode === "unavailable"
								? repositoryConsentState({ namespaceId: "namespace", repositoryId: mode === "unavailable" ? "missing" : "repo" }, "nonce")
								: "nonce",
					}),
					beginConsent: async () => ({ handle: "consent-handle", headers: consentHeaders }),
					describeConsent: async () => ({ clientName: "Gateway <client>" }),
				},
			} as unknown as AuthEnv;
			const response = (await authRoute(
				new Request("https://cruce.example.test/authorize", {
					method: rejected ? "POST" : "GET",
					...(rejected ? { body: new URLSearchParams({ handle: "expired" }) } : {}),
					headers: { "cf-access-jwt-assertion": await f.token({ exp: Math.floor(Date.now() / 1000) + 600 }) },
				}),
				env,
			))!;
			expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
			if (rejected) {
				expect(response.status).toBe(400);
				expect(response.headers.get("cache-control")).toBe("no-store");
				const html = await response.text();
				expect(html).toContain("This authorization expired &lt;fixture>; start again");
				expect(html).toContain('href="https://cruce.example.test/authorize"');
				expect(env.OAUTH_PROVIDER!.completeAuthorization).not.toHaveBeenCalled();
				return;
			}
			if (mode === "unavailable") {
				expect(response.status).toBe(400);
				expect(await response.text()).toContain("This repository is unavailable");
				return;
			}
			expect(response.headers.get("set-cookie")).toBe(consentHeaders.get("set-cookie"));
			expect(response.headers.get("cache-control")).toBe("no-store");
			const html = await response.text();
			expect(html).toContain('<form method="post">');
			expect(html).toContain('name="repository" value="repo"');
			if (mode === "bound") {
				expect(html).toContain('type="hidden" name="repository"');
				expect(html).toContain("Access is limited to this repository.");
				expect(html).not.toContain("Find a repository");
				expect(html).not.toContain("Choose repositories");
			}
			expect(html).toContain('name="handle" value="consent-handle"');
			expect(html).toContain("Gateway &lt;client>");
			expect(html).toContain('name="viewport"');
			expect(html).toContain('name="scope" value="cruce:read" checked disabled');
			expect(html).toContain('name="scope" value="workspace:write">');
			const nonce = html.match(/<script nonce="([^"]+)"/)![1];
			expect(response.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'`);
		},
	);
	it("verifies real signatures, issuer, application audience and expiry", async () => {
		const f = await identityFixture(),
			jwt = await f.token();
		expect(await accessIdentity(f.env, jwt, f.send, 1000000)).toMatchObject({ developerId: "person", tenantId: f.env.CRUCE_ACCESS_ISSUER });
		for (const claims of [
			{ aud: ["other"] },
			{ iss: "https://other.cloudflareaccess.com" },
			{ exp: 999 },
			{ nbf: 1001 },
			{ type: "service" },
		])
			await expect(accessIdentity(f.env, await f.token(claims), f.send, 1000000)).rejects.toThrow("invalid or expired");
		const parts = jwt.split(".");
		parts[1] = encode({ iss: f.env.CRUCE_ACCESS_ISSUER, aud: ["app"], exp: 2000, sub: "attacker", email: "a@test" });
		await expect(accessIdentity(f.env, parts.join("."), f.send, 1000000)).rejects.toThrow("invalid or expired");
	});
	it("encrypts identity cookies and rejects altered payloads", async () => {
		const f = await identityFixture(),
			encrypted = await seal(f.env, { developerId: "person" });
		expect(encrypted).not.toContain("person");
		expect(await unseal(f.env, encrypted)).toEqual({ developerId: "person" });
		await expect(unseal(f.env, `${encrypted.slice(0, -4)}aaaa`)).rejects.toThrow("Sign in again");
	});
});

describe("public Cruce session boundary", () => {
	afterEach(() => vi.unstubAllGlobals());
	const request = (value?: string, method = "GET") =>
		new Request("https://cruce.example.test/auth/session", { method, headers: value ? { cookie: `__Host-cruce=${value}` } : {} });
	it("returns only a no-store boolean without provisioning or trusting Access identity alone", async () => {
		const env = { DIRECTORY: { getByName: vi.fn() }, NAMESPACE: { getByName: vi.fn() } } as unknown as AuthEnv;
		const response = (await authRoute(
			new Request("https://cruce.example.test/auth/session", {
				headers: { cookie: "CF_Authorization=access-token", "cf-access-jwt-assertion": "access-token" },
			}),
			env,
		))!;
		expect(await response.json()).toEqual({ authenticated: false });
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(env.DIRECTORY.getByName).not.toHaveBeenCalled();
		expect(env.NAMESPACE.getByName).not.toHaveBeenCalled();
		const post = (await authRoute(request(undefined, "POST"), env))!;
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET");
	});
	it("checks a sealed session against the real signature, expiry and bound subject", async () => {
		const f = await identityFixture();
		vi.stubGlobal("fetch", f.send);
		const jwt = await f.token({ exp: Math.floor(Date.now() / 1000) + 600 });
		const identity = { developerId: "person", tenantId: f.env.CRUCE_ACCESS_ISSUER, email: "person@example.test", accessJwt: jwt };
		const valid = await seal(f.env, identity);
		expect(await (await authRoute(request(valid), f.env))!.json()).toEqual({ authenticated: true });
		for (const raw of [
			"tampered",
			await seal(f.env, null),
			await seal(f.env, { ...identity, developerId: "different" }),
			await seal(f.env, { ...identity, accessJwt: await f.token({ exp: 1 }) }),
		]) {
			expect(await (await authRoute(request(raw), f.env))!.json()).toEqual({ authenticated: false });
		}
	});
	it("clears the Cruce session before handing logout to Access, without accepting a supplied redirect", async () => {
		const env = { DIRECTORY: { getByName: vi.fn() }, NAMESPACE: { getByName: vi.fn() } } as unknown as AuthEnv;
		const send = vi.fn();
		vi.stubGlobal("fetch", send);
		const logout = (await authRoute(
			new Request("https://cruce.example.test/auth/logout?returnTo=https://untrusted.example", {
				headers: { cookie: "__Host-cruce=expired-session; CF_Authorization=access-session" },
			}),
			env,
		))!;
		expect(logout.status).toBe(302);
		expect(logout.headers.get("location")).toBe("/cdn-cgi/access/logout");
		expect(logout.headers.get("set-cookie")).toBe("__Host-cruce=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
		expect(logout.headers.get("cache-control")).toBe("no-store");
		expect(send).not.toHaveBeenCalled();
		expect(env.DIRECTORY.getByName).not.toHaveBeenCalled();
		expect(env.NAMESPACE.getByName).not.toHaveBeenCalled();
		expect(await (await authRoute(request(), env))!.json()).toEqual({ authenticated: false });
	});
	it("keeps certificate outages and configuration errors distinct from signed-out visitors", async () => {
		const f = await identityFixture();
		const identity = {
			developerId: "person",
			tenantId: f.env.CRUCE_ACCESS_ISSUER,
			email: "person@example.test",
			accessJwt: await f.token({ exp: Math.floor(Date.now() / 1000) + 600 }),
		};
		const valid = await seal(f.env, identity);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		await expect(authRoute(request(valid), f.env)).rejects.toMatchObject({ status: 503 });
		await expect(authRoute(request(valid), { ...f.env, CRUCE_SECRET: undefined })).rejects.toMatchObject({ status: 503 });
		await expect(authRoute(request(valid), { ...f.env, CRUCE_ACCESS_AUD: undefined })).rejects.toMatchObject({ status: 503 });
		await expect(authRoute(request(valid), { ...f.env, CRUCE_PUBLIC_ORIGIN: "https://another.example.test" })).rejects.toMatchObject({
			status: 403,
		});
	});
});
describe("agent and terminal connections", () => {
	afterEach(() => vi.unstubAllGlobals());
	const live = () => Math.floor(Date.now() / 1000) + 600;
	it.each(["generic", "repository", "tampered", "revoked"])(
		"approving an agent preserves identity and repository consent (%s)",
		async (mode) => {
			const f = await identityFixture();
			vi.stubGlobal("fetch", f.send);
			const namespace = { id: "namespace", handle: "test", ownerId: "owner" };
			const completeAuthorization = vi.fn(async () => ({ redirectTo: "http://127.0.0.1:12345/callback?code=fixture" }));
			const original = {
				clientId: "client",
				scope: ["cruce:read"],
				redirectUri: "http://127.0.0.1:12345/callback",
				state: mode === "generic" ? "nonce" : repositoryConsentState({ namespaceId: "namespace", repositoryId: "repo" }, "nonce"),
			};
			const env = {
				...f.env,
				DIRECTORY: {
					getByName: () => ({
						login: async () => ({ id: "owner", name: "Owner", personalNamespaceId: namespace.id }),
						namespace: async () => namespace,
						namespaces: async () => [namespace],
					}),
				},
				NAMESPACE: {
					getByName: () => ({
						initialize: async () => {},
						snapshot: async () => ({
							repositories:
								mode === "revoked"
									? [{ id: "other", name: "other" }]
									: [
											{ id: "repo", name: "gateway" },
											{ id: "other", name: "other" },
										],
						}),
					}),
				},
				OAUTH_PROVIDER: {
					approveConsent: async () => ({ request: original, headers: new Headers() }),
					completeAuthorization,
					describeConsent: async () => ({ clientName: "Codex" }),
				},
			} as unknown as AuthEnv;
			const response = (await authRoute(
				new Request("https://cruce.example.test/authorize", {
					method: "POST",
					body: new URLSearchParams([
						["handle", "consent-handle"],
						["scope", "cruce:write"],
						["repository", "repo"],
						...(mode === "generic" ? [["repository", "not-offered"]] : mode === "tampered" ? [["repository", "other"]] : []),
					]),
					headers: { "cf-access-jwt-assertion": await f.token({ exp: live() }) },
				}),
				env,
			))!;
			if (mode === "tampered" || mode === "revoked") {
				expect(response.status).toBe(400);
				expect(completeAuthorization).not.toHaveBeenCalled();
				return;
			}
			expect(response.status).toBe(302);
			const [{ props, metadata }] = completeAuthorization.mock.calls[0] as unknown as [
				{ props: Record<string, unknown>; metadata: Record<string, unknown> },
			];
			// Plain metadata lets the person list and revoke the connection; it holds no credential.
			expect(metadata).toEqual({
				connectionId: props.connectionId,
				clientName: "Codex",
				repositories: [{ id: "repo", label: "test/gateway" }],
			});
			expect(props).toEqual({
				developerId: "person",
				tenantId: f.env.CRUCE_ACCESS_ISSUER,
				email: "person@example.test",
				connectionId: expect.any(String),
				repositoryIds: ["repo"],
				clientName: "Codex",
			});
		},
	);
	it("connections outlive the Access session that approved them but stay bound to the installation issuer", async () => {
		const f = await identityFixture();
		const send = vi.fn();
		vi.stubGlobal("fetch", send);
		const props = {
			developerId: "person",
			tenantId: f.env.CRUCE_ACCESS_ISSUER!,
			email: "person@example.test",
			connectionId: "connection",
			repositoryIds: ["repo"],
			clientName: "Claude Code",
		};
		// Grants approved before this change still carry an Access token; it is ignored rather than re-verified.
		const legacy = { ...props, accessJwt: await f.token({ exp: 1 }) };
		expect(connectionIdentity(legacy, f.env)).toEqual(props);
		expect(send).not.toHaveBeenCalled();
		expect(() => connectionIdentity({ ...props, tenantId: "https://other.cloudflareaccess.com" }, f.env)).toThrow("Reconnect this agent");
		expect(() => connectionIdentity({ ...props, developerId: "" }, f.env)).toThrow("Reconnect this agent");
		expect(() => connectionIdentity(props, { ...f.env, CRUCE_ACCESS_ISSUER: undefined })).toThrow(expect.objectContaining({ status: 503 }));
	});
	it("terminal authorization keeps the identity without the browser's Access token", async () => {
		const f = await identityFixture();
		vi.stubGlobal("fetch", f.send);
		const kv = new Map<string, string>();
		const env = {
			...f.env,
			OAUTH_KV: {
				get: async (key: string, type?: string) => {
					const value = kv.get(key);
					return value && type === "json" ? JSON.parse(value) : (value ?? null);
				},
				put: async (key: string, value: string) => void kv.set(key, value),
			},
			DIRECTORY: { getByName: () => ({ resolve: async () => ({ id: "owner", name: "Owner" }) }) },
			NAMESPACE: { getByName: () => ({ repository: async () => ({ id: "repo", name: "gateway" }) }) },
		} as unknown as PlatformEnv;
		const ctx = {} as ExecutionContext;
		const origin = "https://cruce.example.test";
		const started = (await (await bridgeRoute(
			new Request(`${origin}/bridge/start`, { method: "POST", body: JSON.stringify({ namespaceId: "namespace", repositoryId: "repo" }) }),
			env,
			ctx,
		))!.json()) as { code: string };
		const approved = (await bridgeRoute(
			new Request(`${origin}/bridge/approve?code=${started.code}`, {
				method: "POST",
				headers: { origin, "cf-access-jwt-assertion": await f.token({ exp: live() }) },
			}),
			env,
			ctx,
		))!;
		expect(approved.status).toBe(200);
		const stored = [...kv.entries()].find(([key]) => key.startsWith("bridge:"))!;
		expect(JSON.parse(stored[1]).identity).toEqual({
			developerId: "person",
			tenantId: f.env.CRUCE_ACCESS_ISSUER,
			email: "person@example.test",
		});
	});
});
