import { describe, expect, it, vi } from "vitest";
import { ArtifactsRestHost, ResourceBoundary } from "../../src/worker/artifacts.ts";
import type { Store } from "../../src/worker/store.ts";

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
const memory = (): Store => {
	const data = new Map<string, unknown>();
	return {
		get: <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
		put: (k, v) => void data.set(k, structuredClone(v)),
		delete: (k) => void data.delete(k),
	};
};
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("resource boundary", () => {
	it("verifies and seals a connected account token and never returns it", async () => {
		const store = memory();
		const send = vi.fn(async (url: string | URL | Request) => {
			expect(new URL(String(url)).pathname).toBe(`/client/v4/accounts/${ACCOUNT}/artifacts/namespaces`);
			return ok({});
		}) as unknown as typeof fetch;
		const boundary = new ResourceBoundary(store, { CRUCE_SECRET: "test-secret-value" }, { namespace: "cruce" }, send);
		expect(boundary.account()).toBeUndefined();
		const token = "cf-api-token-value-for-tests-only";
		const view = await boundary.connect({ accountId: ACCOUNT, token }, "owner");
		expect(send).toHaveBeenCalledTimes(1);
		expect(view).not.toHaveProperty("capabilities");
		expect(view).toMatchObject({ mode: "connected", accountId: ACCOUNT, credential: "stored" });
		expect(JSON.stringify(view)).not.toContain(token);
		expect(JSON.stringify(store.get("resource-account"))).not.toContain(token);
		expect(await boundary.host()).toBeInstanceOf(ArtifactsRestHost);
		boundary.disconnect();
		expect(boundary.account()).toBeUndefined();
	});
	it("trims pasted credentials before verifying and sealing them", async () => {
		const headers: string[] = [];
		const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			headers.push(new Headers(init?.headers).get("authorization") ?? "");
			return ok({});
		}) as unknown as typeof fetch;
		const boundary = new ResourceBoundary(memory(), { CRUCE_SECRET: "test-secret-value" }, { namespace: "cruce" }, send);
		const view = await boundary.connect(
			{ accountId: ` ${ACCOUNT.toUpperCase()}\n`, token: "  cf-api-token-value-for-tests-only\n" },
			"owner",
		);
		expect(headers).toEqual(["Bearer cf-api-token-value-for-tests-only"]);
		expect(view.accountId).toBe(ACCOUNT);
	});
	it("rejects tokens that cannot read Artifacts", async () => {
		const send = (async () =>
			new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), {
				status: 403,
			})) as unknown as typeof fetch;
		const boundary = new ResourceBoundary(memory(), { CRUCE_SECRET: "s" }, { namespace: "cruce" }, send);
		await expect(boundary.connect({ accountId: ACCOUNT, token: "x".repeat(40) }, "owner")).rejects.toThrow("Authentication error");
	});
	it("uses 60-second repository tokens through the REST API and revokes them", async () => {
		const calls: string[] = [];
		const send = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
			if (String(url).endsWith("/tokens") && init?.method === "POST") {
				expect(JSON.parse(String(init.body))).toEqual({ repo: "app-source", scope: "write", ttl: 60 });
				return ok({ id: "t1", plaintext: "short" });
			}
			return ok({});
		}) as unknown as typeof fetch;
		const host = new ArtifactsRestHost(ACCOUNT, "cruce", "api-token", send);
		expect((await host.withToken("app-source", "write", async (t) => t)).result).toBe("short");
		expect(calls).toEqual([
			`POST /client/v4/accounts/${ACCOUNT}/artifacts/namespaces/cruce/tokens`,
			`DELETE /client/v4/accounts/${ACCOUNT}/artifacts/namespaces/cruce/tokens/t1`,
		]);
	});
});

describe("provider reconciliation", () => {
	it("creates the tenant namespace and reconciles long-lived creation tokens on retry", async () => {
		let namespace = false,
			repository = false,
			token = false,
			failRevocation = true;
		const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			const missing = () => new Response(JSON.stringify({ success: false }), { status: 404 });
			if (path.endsWith("/namespaces") && init?.method === "POST") {
				namespace = true;
				return ok({});
			}
			if (path.endsWith("/namespaces/namespace")) return namespace ? ok({}) : missing();
			if (path.endsWith("/repos") && init?.method === "POST") {
				expect(JSON.parse(String(init.body)).default_branch).toBe("trunk");
				repository = token = true;
				return ok({ id: "r", name: "repo", remote: "https://example.invalid/repo.git" });
			}
			if (path.endsWith("/repos/repo"))
				return repository ? ok({ id: "r", name: "repo", description: "owned", remote: "https://example.invalid/repo.git" }) : missing();
			if (path.endsWith("/repos/repo/tokens")) return ok(token ? [{ id: "creation" }] : []);
			if (path.endsWith("/tokens/creation")) {
				if (failRevocation) {
					failRevocation = false;
					throw new Error("lost response");
				}
				token = false;
				return ok({});
			}
			throw new Error(`Unexpected request ${path}`);
		}) as unknown as typeof fetch;
		const host = new ArtifactsRestHost(ACCOUNT, "namespace", "test", send);
		await expect(host.ensure("repo", "owned", "trunk")).rejects.toThrow("lost response");
		expect(await host.ensure("repo", "owned", "trunk")).toMatchObject({ created: false });
		expect(token).toBe(false);
	});
});

describe("Artifacts Git boundary", () => {
	it("forwards Git bytes with a scoped token, strips user headers and revokes after consumption", async () => {
		const calls: string[] = [];
		const send = async function (this: unknown, url: string | URL | Request, init?: RequestInit) {
			expect(this).toBeUndefined();
			const address = String(url);
			calls.push(address);
			if (address.endsWith("/repos/repo"))
				return ok({ id: "repo", name: "repo", remote: `https://${ACCOUNT}.artifacts.cloudflare.net/git/team/repo.git` });
			if (address.endsWith("/tokens")) {
				expect(JSON.parse(String(init?.body))).toEqual({ repo: "repo", scope: "write", ttl: 60 });
				return ok({ id: "short", plaintext: "provider-secret" });
			}
			if (address.endsWith("/tokens/short")) return ok({});
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer provider-secret");
			expect(headers.has("cookie")).toBe(false);
			expect(headers.has("cf-access-jwt-assertion")).toBe(false);
			expect(headers.get("git-protocol")).toBe("version=1");
			expect(init?.redirect).toBe("manual");
			return new Response("0000", { headers: { "content-type": "application/x-git-receive-pack-result", "set-cookie": "secret" } });
		} as typeof fetch;
		const host = new ArtifactsRestHost(ACCOUNT, "team", "account-secret", send);
		const response = await host.gitRequest(
			"repo",
			new Request("https://cruce.example/mcp/git/team/repo/work.git/git-receive-pack", {
				method: "POST",
				body: "0000",
				headers: {
					authorization: "Bearer user-secret",
					cookie: "private",
					"cf-access-jwt-assertion": "identity",
					"git-protocol": "version=1",
				},
			}),
		);
		expect(await response.text()).toBe("0000");
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(calls.at(-1)).toContain("/tokens/short");
	});
	it("refuses a provider remote on another origin before minting any token", async () => {
		const send = vi.fn(async () => ok({ remote: "https://attacker.invalid/repo.git" })) as unknown as typeof fetch;
		const host = new ArtifactsRestHost(ACCOUNT, "team", "secret", send);
		await expect(host.gitRequest("repo", new Request("https://cruce.example/info/refs?service=git-upload-pack"))).rejects.toThrow(
			"Invalid Artifacts Git remote",
		);
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("reconciles asynchronous repository deletion only after metadata returns absent", async () => {
		const send = vi
			.fn()
			.mockResolvedValueOnce(ok({ id: "repo" }))
			.mockResolvedValueOnce(ok({ id: "repo" }))
			.mockResolvedValueOnce(new Response("{}", { status: 404 }));
		const host = new ArtifactsRestHost(ACCOUNT, "team", "secret", send);
		expect(await host.remove("repo")).toBe(false);
		expect(await host.remove("repo")).toBe(true);
	});
});
