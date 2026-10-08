import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DomainError, publicError } from "../../src/core/errors.ts";
import { PUBLIC_ERRORS } from "../../src/core/public-errors.ts";
import { ArtifactsBindingHost, ArtifactsRestHost } from "../../src/worker/artifacts.ts";
import { correlate, diagnose, diagnoseError, diagnosticId, httpFailure, withDiagnostics } from "../../src/worker/diagnostics.ts";
import { remoteMcp } from "../../src/worker/mcp.ts";
import { ProviderIdentity } from "../../src/worker/provider-identity.ts";
import { ACCOUNT, memory, provider } from "./artifacts-fixture.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
afterEach(() => vi.restoreAllMocks());
const secret = "Bearer private-token /accounts/private-account oauth-payload source-content";
const generic = { status: 500, message: "Operation unavailable; retry with the same operation identity" };

async function mcp(
	execute: (command: never) => Promise<unknown>,
	args: Record<string, unknown> = {},
	scopes?: Parameters<typeof remoteMcp>[1],
	body: Record<string, unknown> = { method: "tools/call", params: { name: "get_source", arguments: args } },
) {
	const response = await remoteMcp(execute as never, scopes)(
		new Request("https://cruce.test/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
		}),
		{} as never,
		{ waitUntil: vi.fn() } as never,
	);
	const raw = await response.text();
	const data =
		raw
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6) ?? raw;
	return JSON.parse(data).result;
}

describe("safe public errors", () => {
	it.each([
		new Error(secret),
		new DomainError(409, secret),
		Object.assign(new Error(secret), { name: "CruceError409" }),
		Object.assign(new Error(secret), { name: "ZodError", issues: [{ path: [secret], message: secret }] }),
	])("hides internal and forged messages through HTTP and actual MCP dispatch", async (error) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(publicError(error)).toEqual(generic);
		const http = httpFailure(error);
		expect(http.status).toBe(500);
		expect(await http.json()).toEqual({ error: generic.message });
		const result = await mcp(async () => {
			throw error;
		});
		expect(result).toEqual({ isError: true, structuredContent: { status: 500 }, content: [{ type: "text", text: generic.message }] });
		expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
	});
	it("preserves only registered status/message pairs after Durable Object serialization", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const error = Object.assign(new Error("Workspace has ended"), { name: "CruceError409" });
		expect(publicError(error)).toEqual({ status: 409, message: "Workspace has ended" });
		expect(
			(
				await mcp(async () => {
					throw error;
				})
			).structuredContent.status,
		).toBe(409);
		expect(publicError(new DomainError(403, "Workspace has ended"))).toEqual(generic);
		expect(publicError(Object.assign(new Error("Binary file; inline source unavailable"), { name: "CruceError415" })).status).toBe(415);
	});
	it("never publishes validation messages, unknown keys, or values, including SDK prevalidation", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const invalid = z.object({ revision: z.string().refine(() => false, secret) }).safeParse({ revision: secret });
		expect(publicError(invalid.error)).toEqual({ status: 400, message: "Invalid revision: check the supplied value" });
		const unknown = z
			.object({})
			.strict()
			.safeParse({ [secret]: secret });
		expect(publicError(unknown.error)).toEqual({ status: 400, message: "Invalid request: check the supplied value" });
		const execute = vi.fn();
		const result = await mcp(execute, { revision: secret, namespaceId: "namespace", repositoryId: "repository" });
		expect(result).toEqual({
			isError: true,
			structuredContent: { status: 400 },
			content: [{ type: "text", text: "Invalid revision: check the supplied value" }],
		});
		expect(execute).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain(secret);
	});
});

describe("single public error allowlist", () => {
	it("registers every literal error the worker can return, including direct HTTP responses", () => {
		const literal = '"((?:[^"\\\\]|\\\\.)*)"';
		const patterns: [RegExp, (m: RegExpMatchArray) => [number, string]][] = [
			[new RegExp(`new DomainError\\(\\s*(\\d{3}),\\s*${literal}\\s*\\)`, "g"), (m) => [Number(m[1]), m[2]]],
			[new RegExp(`new CoordinationError\\(\\s*(\\d{3}),\\s*${literal}\\s*\\)`, "g"), (m) => [Number(m[1]), m[2]]],
			[new RegExp(`new ProviderIdentityError\\(\\s*${literal}\\s*\\)`, "g"), (m) => [409, m[1]]],
			[new RegExp(`requireValue\\([^;]*?,\\s*${literal}\\s*\\)`, "g"), (m) => [400, m[1]]],
			[new RegExp(`json\\(\\{\\s*error:\\s*${literal}\\s*\\},\\s*(\\d{3})\\)`, "g"), (m) => [Number(m[2]), m[1]]],
			[new RegExp(`Response\\.json\\(\\{\\s*error:\\s*${literal}\\s*\\},\\s*\\{\\s*status:\\s*(\\d{3})`, "g"), (m) => [Number(m[2]), m[1]]],
			[new RegExp(`new Response\\(${literal},\\s*\\{\\s*status:\\s*(\\d{3})`, "g"), (m) => [Number(m[2]), m[1]]],
		];
		const files = ["src/core", "src/worker", "src/shared"].flatMap((dir) =>
			(readdirSync(dir, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts")).map((file) => join(dir, file)),
		);
		const found: string[] = [],
			missing: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const [pattern, read] of patterns)
				for (const match of source.matchAll(pattern)) {
					const [status, message] = read(match);
					found.push(message);
					if (!PUBLIC_ERRORS[status]?.includes(message)) missing.push(`${file}: ${status} ${message}`);
				}
		}
		expect(found.length).toBeGreaterThan(200);
		expect(found).toEqual(expect.arrayContaining(["GET required", "Invalid Git credentials", "Git authentication required", "Not found"]));
		expect(missing).toEqual([]);
	});
});

describe("MCP scope filtering", () => {
	it("hides and refuses tools outside the connection's scopes before validation or execution", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const execute = vi.fn(async () => ({ ok: true }));
		const listed = (await mcp(execute, {}, ["cruce:read"], { method: "tools/list" })) as { tools: { name: string }[] };
		const names = listed.tools.map((tool) => tool.name);
		expect(names).toContain("get_source");
		expect(names).not.toContain("publish_revision");
		expect(names).not.toContain("start_workspace");
		expect(listed.tools.some((tool) => tool.name === "preview_reconciliation")).toBe(false);
		const call = { method: "tools/call", params: { name: "publish_revision", arguments: { unexpected: secret } } };
		expect(await mcp(execute, {}, ["cruce:read"], call)).toEqual({
			isError: true,
			structuredContent: { status: 403 },
			content: [{ type: "text", text: "Agent capability denied" }],
		});
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("redacted operation diagnostics", () => {
	it("isolates concurrent asynchronous contexts and drops arbitrary fields and errors", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const run = (repositoryId: string) =>
			withDiagnostics({ namespaceId: secret, repositoryId, tool: "publish_revision", content: secret } as never, async () => {
				await Promise.resolve();
				await correlate({ workspaceId: secret });
				diagnose("resource_settled", { phase: "uncertain", message: secret, code: secret, action: secret } as never);
				diagnoseError("operation_failed", Object.assign(new Error(secret), { name: secret }));
			});
		await Promise.all([run("repository-a"), run("repository-b")]);
		const records = log.mock.calls.map(([value]) => JSON.parse(value));
		expect(new Set(records.map((r) => r.repositoryId))).toEqual(
			new Set([await diagnosticId("repositoryId", "repository-a"), await diagnosticId("repositoryId", "repository-b")]),
		);
		for (const record of records) {
			expect(record.namespaceId).toBe(await diagnosticId("namespaceId", secret));
			expect(record.workspaceId).toBe(await diagnosticId("workspaceId", secret));
			expect(Object.keys(record).sort()).toEqual(
				["event", "namespaceId", "repositoryId", "tool", "workspaceId", record.event === "operation_failed" ? "status" : "phase"].sort(),
			);
		}
		expect(JSON.stringify(records)).not.toContain(secret);
		diagnose("boundary_error", { transport: "http" });
		expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ event: "boundary_error", transport: "http" });
	});
	it.each(["binding", "rest"])("redacts %s provider details and retains enclosing correlation", async (kind) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const p = provider();
		p.get.mockRejectedValueOnce(Object.assign(new Error(secret), { code: secret }));
		const host =
			kind === "binding"
				? new ArtifactsBindingHost(p.artifacts, ACCOUNT, "cruce", "namespace", new ProviderIdentity(memory().store))
				: new ArtifactsRestHost(
						ACCOUNT,
						"namespace",
						secret,
						vi.fn(
							async () => new Response(JSON.stringify({ success: false, errors: [{ code: secret, message: secret }] }), { status: 403 }),
						),
					);
		await withDiagnostics(
			{ namespaceId: "namespace", repositoryId: "repository", operationId: secret, reservationId: secret },
			async () => {
				await expect(host.info("repository")).rejects.toThrow();
			},
		);
		const record = JSON.parse(log.mock.calls.at(-1)![0]);
		expect(record).toMatchObject({
			event: "provider_error",
			provider: kind,
			operationId: await diagnosticId("operationId", secret),
			reservationId: await diagnosticId("reservationId", secret),
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
		expect(JSON.stringify(log.mock.calls)).not.toContain(ACCOUNT);
	});
});
