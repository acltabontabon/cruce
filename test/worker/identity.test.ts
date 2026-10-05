import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthEnv, accessIdentity, authRoute, oauthProvider, seal, unseal } from "../../src/worker/auth.ts";

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
		const logout = (await authRoute(new Request("https://cruce.example.test/auth/logout"), f.env))!;
		expect(logout.headers.get("location")).toBe("/");
		expect(logout.headers.get("set-cookie")).toContain("__Host-cruce=;");
		expect(logout.headers.get("set-cookie")).not.toContain("CF_Authorization");
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
