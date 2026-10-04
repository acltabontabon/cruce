import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { authorizeMachine, CRUCE_TOOL_NAMES, CRUCE_TOOLS } from "../../src/shared/tools.ts";
import { cruceServer, type MachineCommand, remoteMcp } from "../../src/worker/mcp.ts";

async function connect(server: ReturnType<typeof cruceServer>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "native-fixture", version: "1" });
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe("Cruce MCP", () => {
	it("exposes Cruce lifecycle concepts with their own schemas, and instructions", async () => {
		const seen: MachineCommand[] = [];
		const { client, close } = await connect(
			cruceServer(async (command) => {
				seen.push(command);
				return { working: "PROCEED", publication: "WAIT", integration: "WAIT", projectId: command.projectId };
			}),
		);
		try {
			expect(client.getInstructions()).toContain("Cruce coordinates your work; it does not run you");
			const listed = await client.listTools();
			expect(listed.tools.map((t) => t.name)).toEqual(CRUCE_TOOL_NAMES);
			const preview = listed.tools.find((t) => t.name === "request_preview")!;
			expect(preview.description).toContain("Metered Cloudflare operation");
			expect(Object.keys(preview.inputSchema.properties ?? {})).toContain("proposalId");
			expect(Object.keys(preview.inputSchema.properties ?? {})).not.toContain("files");
			expect(listed.tools.find((t) => t.name === "get_context")?.annotations?.readOnlyHint).toBe(true);
			const result = await client.callTool({ name: "get_active_work", arguments: { projectId: "repo" } });
			expect(result.structuredContent).toMatchObject({ working: "PROCEED" });
			await client.callTool({ name: "update_plan", arguments: { projectId: "repo", plan: { summary: "x", intent: "y", writeSet: [] } } });
			expect(seen.map((c) => c.tool)).toEqual(["get_active_work", "update_intent"]);
		} finally {
			await close();
		}
	});
	it("never exposes generic Cloudflare administration or human decisions", () => {
		for (const name of CRUCE_TOOL_NAMES)
			expect(name).not.toMatch(/worker|dns|zone|d1|r2|kv|deploy_|create_repo|promote_proposal|set_policy/);
		const resources = CRUCE_TOOLS.filter((t) => t.class === "resource").map((t) => t.name);
		expect(resources).toEqual(["start_mission", "publish_revision", "publish_artifact", "request_preview"]);
		expect(CRUCE_TOOLS.every((t) => t.class === "control" || t.action)).toBe(true);
	});
	it("lists only the tools a connection's scopes allow", async () => {
		const { client, close } = await connect(cruceServer(async () => ({}), ["cruce:read"]));
		try {
			const names = (await client.listTools()).tools.map((t) => t.name);
			expect(names).toContain("get_context");
			expect(names).not.toContain("publish_revision");
			expect(names).not.toContain("request_preview");
		} finally {
			await close();
		}
	});
	it("enforces scopes and human-only decisions on internal commands too", () => {
		const agent = { developerId: "d", tenantId: "t", projectIds: ["p"], kind: "agent" as const, scopes: ["cruce:read" as const] };
		expect(() => authorizeMachine(agent, { tool: "get_project", projectId: "p" } as MachineCommand)).not.toThrow();
		expect(() => authorizeMachine(agent, { tool: "request_preview", projectId: "p" } as MachineCommand)).toThrow("preview:request");
		expect(() => authorizeMachine(agent, { tool: "register_intent", projectId: "p" } as MachineCommand)).toThrow("workspace:write");
		expect(() =>
			authorizeMachine({ ...agent, scopes: ["cruce:read", "promotion:request"] }, {
				tool: "promote_proposal",
				projectId: "p",
			} as MachineCommand),
		).toThrow("human decision");
		expect(() =>
			authorizeMachine({ ...agent, kind: "human" }, { tool: "promote_proposal", projectId: "p" } as MachineCommand),
		).not.toThrow();
	});
	it("reconnects stateless HTTP transports while retaining application state", async () => {
		let count = 0;
		const handler = remoteMcp(async () => ({ revision: ++count }));
		const send: typeof fetch = async (input, init) => handler(new Request(input, init), {} as never, { waitUntil: () => {} } as never);
		for (let i = 1; i <= 2; i++) {
			const client = new Client({ name: "http-fixture", version: "1" });
			const transport = new StreamableHTTPClientTransport(new URL("https://cruce.test/mcp"), { fetch: send });
			await client.connect(transport);
			try {
				expect((await client.callTool({ name: "get_active_work", arguments: { projectId: "repo" } })).structuredContent).toEqual({
					revision: i,
				});
			} finally {
				await client.close();
			}
		}
	});
	it("renders authorization failures as tool errors, never permissions parsed from prose", async () => {
		const { client, close } = await connect(
			cruceServer(async () => {
				throw new Error("Repository access denied");
			}),
		);
		try {
			expect((await client.callTool({ name: "get_active_work", arguments: { projectId: "private" } })).isError).toBe(true);
		} finally {
			await close();
		}
	});
});
