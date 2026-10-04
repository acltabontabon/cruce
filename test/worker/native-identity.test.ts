import { describe, expect, it, vi } from "vitest";
import { type AuthEnv, accessIdentity, seal, unseal } from "../../src/worker/auth.ts";
import { ProjectDirectory } from "../../src/worker/project-directory.ts";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(readonly ctx: DurableObjectState) {}
	},
}));
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
function directory() {
	const data = new Map<string, unknown>(),
		storage = {
			get: async (k: string) => structuredClone(data.get(k)),
			put: async (k: string | Record<string, unknown>, v?: unknown) => {
				if (typeof k === "string") data.set(k, structuredClone(v));
				else for (const [key, value] of Object.entries(k)) data.set(key, structuredClone(value));
			},
			list: async ({ prefix }: { prefix: string }) =>
				new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
		};
	return new ProjectDirectory({ storage } as unknown as DurableObjectState, {} as never);
}
describe("native project authority", () => {
	it("serializes duplicate initialization and retains authority across a rename", async () => {
		const d = directory(),
			identity = { developerId: "owner", tenantId: "tenant" };
		const [a, b] = await Promise.all([d.create(identity, "Payments", "once"), d.create(identity, "Payments", "once")]);
		expect(a.id).toBe(b.id);
		expect(await d.projects()).toHaveLength(1);
		const renamed = await d.update(identity, a.id, 1, { name: "Settlements" });
		expect(renamed.id).toBe(a.id);
		expect(renamed.artifactRepository).toBe(a.artifactRepository);
		await expect(d.create(identity, "Different", "once")).rejects.toThrow("Idempotency");
	});
	it("enforces tenant membership, read-only roles, revocation and versioned governance", async () => {
		const d = directory(),
			identity = { developerId: "owner", tenantId: "tenant" },
			s = await d.create(identity, "Payments", "new");
		expect(() => d.principal({ ...identity, tenantId: "other" }, s)).toThrow("access denied");
		expect(() => d.principal({ ...identity, developerId: "stranger" }, s)).toThrow("access denied");
		const observer = await d.update(identity, s.id, s.version, { member: { id: "viewer", role: "observer" } });
		expect(d.principal({ ...identity, developerId: "viewer" }, observer).canWrite).toBe(false);
		await expect(d.update(identity, s.id, 1, { name: "Stale" })).rejects.toThrow("Project changed");
		const revoked = await d.update(identity, s.id, observer.version, { member: { id: "viewer", role: "remove" } });
		expect(() => d.principal({ ...identity, developerId: "viewer" }, revoked)).toThrow("access denied");
		await expect(d.update(identity, s.id, revoked.version, { member: { id: "owner", role: "remove" } })).rejects.toThrow(
			"needs a maintainer",
		);
		const disabled = await d.update(identity, s.id, revoked.version, { active: false });
		expect(() => d.principal(identity, disabled)).toThrow("access denied");
		await expect(d.update({ ...identity, developerId: "viewer" }, s.id, disabled.version, { active: true })).rejects.toThrow(
			"Maintainer required",
		);
		await expect(d.update({ ...identity, tenantId: "other" }, s.id, disabled.version, { active: true })).rejects.toThrow(
			"Maintainer required",
		);
		const enabled = await d.update(identity, s.id, disabled.version, { active: true });
		expect(d.principal(identity, enabled).maintainer).toBe(true);
	});
	it("does not let revoked creators replay creation to retrieve project details", async () => {
		const d = directory(),
			identity = { developerId: "owner", tenantId: "tenant" },
			s = await d.create(identity, "Payments", "new");
		const withSuccessor = await d.update(identity, s.id, s.version, { member: { id: "successor", role: "maintainer" } });
		await d.update({ ...identity, developerId: "successor" }, s.id, withSuccessor.version, { member: { id: "owner", role: "remove" } });
		await expect(d.create(identity, "Payments", "new")).rejects.toThrow("access denied");
		expect(await d.projects()).toHaveLength(1);
	});
});
