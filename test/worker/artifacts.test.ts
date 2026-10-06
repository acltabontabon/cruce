import { describe, expect, it, vi } from "vitest";
import { ArtifactsRestHost } from "../../src/worker/artifacts.ts";

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("resource boundary", () => {
	it("uses native REST commit/tree/file/history routes with bounded content and identity checks", async () => {
		const send = vi.fn(async (url: string | URL | Request) => {
			const u = new URL(String(url));
			if (u.pathname.endsWith("/repos/repo")) return ok({ id: "stable", name: "repo" });
			if (u.pathname.endsWith("/file")) return new Response("source");
			return ok([]);
		}) as unknown as typeof fetch;
		const host = new ArtifactsRestHost(ACCOUNT, "cruce", "private", send);
		expect(
			await host.withSource("repo", "stable", async (source) => {
				await source.readCommit("a".repeat(40));
				await source.readTree("b".repeat(40));
				await source.log({ ref: "a".repeat(40), limit: 30 });
				return (await source.readFile({ ref: "a".repeat(40), path: "src/a b.txt" }))!.text();
			}),
		).toBe("source");
		expect(vi.mocked(send).mock.calls.map(([u]) => String(u))).toContainEqual(expect.stringContaining("path=src%2Fa+b.txt"));
		await expect(host.withSource("repo", "replacement", (source) => source.log())).rejects.toThrow("identity changed");
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
