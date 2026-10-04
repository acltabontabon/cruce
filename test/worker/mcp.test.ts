import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/shared/coordination.ts";
import { PLATFORM_TOOLS } from "../../src/shared/platform.ts";
import { coordinationServer, remoteMcp } from "../../src/worker/mcp.ts";

describe("coordination MCP", () => {
	it("returns typed outcomes through the native SDK and exposes participation instructions", async () => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = coordinationServer(async (command) => ({
			working: "PROCEED",
			publication: "WAIT",
			integration: "WAIT",
			systemId: command.systemId,
		}));
		const client = new Client({ name: "native-fixture", version: "1" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		try {
			expect(client.getInstructions()).toContain("preserve working-tree changes");
			const listed = await client.listTools();
			expect(listed.tools.map((t) => t.name)).toEqual([...TOOLS, ...PLATFORM_TOOLS]);
			const result = await client.callTool({ name: "get_active_work", arguments: { systemId: "repo" } });
			expect(result.structuredContent).toMatchObject({ working: "PROCEED", publication: "WAIT", integration: "WAIT" });
		} finally {
			await client.close();
			await server.close();
		}
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
				expect((await client.callTool({ name: "get_active_work", arguments: { systemId: "repo" } })).structuredContent).toEqual({
					revision: i,
				});
			} finally {
				await client.close();
			}
		}
	});
	it("renders authorization failures as tool errors, never permissions parsed from prose", async () => {
		const [a, b] = InMemoryTransport.createLinkedPair(),
			server = coordinationServer(async () => {
				throw new Error("Repository access denied");
			}),
			client = new Client({ name: "denied", version: "1" });
		await server.connect(b);
		await client.connect(a);
		try {
			expect((await client.callTool({ name: "get_active_work", arguments: { systemId: "private" } })).isError).toBe(true);
		} finally {
			await client.close();
			await server.close();
		}
	});
});
