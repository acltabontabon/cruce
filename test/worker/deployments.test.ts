import { describe, expect, it, vi } from "vitest";
import { ArtifactsRestHost, ResourceBoundary, runSmokeChecks, WorkersBuildsClient } from "../../src/worker/deployments.ts";
import type { Store } from "../../src/worker/store.ts";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

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
			expect(String(url)).toContain(`/accounts/${ACCOUNT}/builds/account/limits`);
			return ok({});
		}) as unknown as typeof fetch;
		const boundary = new ResourceBoundary(store, { CRUCE_SECRET: "test-secret-value" }, { namespace: "cruce" }, send);
		expect(boundary.account()).toBeUndefined();
		const token = "cf-api-token-value-for-tests-only";
		const view = await boundary.connect({ accountId: ACCOUNT, token }, "owner");
		expect(view).toMatchObject({ mode: "connected", accountId: ACCOUNT, credential: "stored", capabilities: ["artifacts", "builds"] });
		expect(JSON.stringify(view)).not.toContain(token);
		expect(JSON.stringify(store.get("resource-account"))).not.toContain(token);
		expect(await boundary.host()).toBeInstanceOf(ArtifactsRestHost);
		boundary.disconnect();
		expect(boundary.account()).toBeUndefined();
	});
	it("rejects tokens that cannot read Workers Builds", async () => {
		const send = (async () =>
			new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), {
				status: 403,
			})) as unknown as typeof fetch;
		const boundary = new ResourceBoundary(memory(), { CRUCE_SECRET: "s" }, { namespace: "cruce" }, send);
		await expect(boundary.connect({ accountId: ACCOUNT, token: "x".repeat(40) }, "owner")).rejects.toThrow("cannot read Workers Builds");
	});
	it("uses 60-second repository tokens through the REST API and revokes them", async () => {
		const calls: string[] = [];
		const send = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
			if (String(url).endsWith("/tokens") && init?.method === "POST") {
				expect(JSON.parse(String(init.body))).toEqual({ repo: "app--deploy", scope: "write", ttl: 60 });
				return ok({ id: "t1", plaintext: "short" });
			}
			return ok({});
		}) as unknown as typeof fetch;
		const host = new ArtifactsRestHost(ACCOUNT, "cruce", "api-token", send);
		expect((await host.withToken("app--deploy", "write", async (t) => t)).result).toBe("short");
		expect(calls).toEqual([
			`POST /client/v4/accounts/${ACCOUNT}/artifacts/namespaces/cruce/tokens`,
			`DELETE /client/v4/accounts/${ACCOUNT}/artifacts/namespaces/cruce/tokens/t1`,
		]);
	});
	it("ties Workers Builds results to an exact revision and branch", async () => {
		const send = (async () =>
			ok([
				{ build_uuid: "b1", status: "stopped", build_outcome: "success", build_trigger_metadata: { commit_hash: "aaa", branch: "main" } },
				{ build_uuid: "b2", status: "running", build_trigger_metadata: { commit_hash: "bbb", branch: "cruce/proposal-1" } },
			])) as unknown as typeof fetch;
		const client = new WorkersBuildsClient(ACCOUNT, "t", send);
		expect((await client.buildFor("tag", "bbb", "cruce/proposal-1"))?.build_uuid).toBe("b2");
		expect(await client.buildFor("tag", "bbb", "main")).toBeUndefined();
	});
});

describe("smoke checks", () => {
	it("records each status against its expectation and refuses non-HTTPS targets", async () => {
		const send = (async (url: string | URL | Request) =>
			new Response("", { status: String(url).endsWith("/missing") ? 404 : 200 })) as unknown as typeof fetch;
		const results = await runSmokeChecks(
			"https://preview.example",
			[
				{ path: "/", expectStatus: 200 },
				{ path: "/missing", expectStatus: 200 },
			],
			send,
			() => 0,
		);
		expect(results.map((r) => [r.path, r.status, r.ok])).toEqual([
			["/", 200, true],
			["/missing", 404, false],
		]);
		await expect(runSmokeChecks("http://preview.example", [], send)).rejects.toThrow("HTTPS");
	});
});

describe("deployment workflow", () => {
	it("polls the repository's Durable Object with durable sleeps until the deployment settles", async () => {
		const { DeploymentWorkflow } = await import("../../src/worker/deployment-workflow.ts");
		const states = ["building", "building", "deployed"];
		const tick = vi.fn(async () => states.shift());
		const workflow = Object.assign(Object.create(DeploymentWorkflow.prototype), {
			env: { CONTROL_TOWER: { getByName: () => ({ deploymentTick: tick }) } },
		}) as InstanceType<typeof DeploymentWorkflow>;
		const sleeps: string[] = [];
		const step = {
			do: async (_name: string, a: unknown, b?: unknown) => ((typeof a === "function" ? a : b) as () => Promise<unknown>)(),
			sleep: async (name: string) => void sleeps.push(name),
		};
		expect(await workflow.run({ payload: { repositoryId: "p", deploymentId: "D-1" } } as never, step as never)).toBe("deployed");
		expect(tick).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual(["wait 0", "wait 1"]);
	});
});

describe("provider reconciliation", () => {
	it("creates the workspace namespace and reconciles long-lived creation tokens on retry", async () => {
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
			if (path.endsWith("/namespaces/workspace")) return namespace ? ok({}) : missing();
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
		const host = new ArtifactsRestHost(ACCOUNT, "workspace", "test", send);
		await expect(host.ensure("repo", "owned", "trunk")).rejects.toThrow("lost response");
		expect(await host.ensure("repo", "owned", "trunk")).toMatchObject({ created: false });
		expect(token).toBe(false);
	});
	it("reads the build detail for preview URLs and correlates runtime versions by build ID", async () => {
		const build = {
			build_uuid: "build",
			status: "stopped",
			build_outcome: "success",
			build_trigger_metadata: { commit_hash: "sha", branch: "trunk" },
		};
		const send = (async (url: string | URL | Request) => {
			const u = new URL(String(url));
			if (u.pathname.endsWith("/versions")) return ok({ items: [{ id: "unrelated" }, { id: "version" }] });
			if (u.searchParams.has("version_ids")) return ok({ builds: { unrelated: { ...build, build_uuid: "else" }, version: build } });
			if (u.pathname.endsWith("/builds/build")) return ok({ ...build, preview_url: "https://preview.example" });
			return ok([build]);
		}) as typeof fetch;
		const client = new WorkersBuildsClient(ACCOUNT, "test", send);
		expect((await client.buildFor("tag", "sha", "trunk"))?.preview_url).toBe("https://preview.example");
		expect(await client.runtimeVersion("worker", "build")).toBe("version");
	});
});
