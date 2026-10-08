import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";
import { stateDirectory } from "../../runner/execution.ts";
import { writeState } from "../../runner/state-file.ts";
import { nativeRepository } from "../git/native-fixture.ts";

it("resumes a recorded fork deletion under its own operation identity", async () => {
	const fixture = await nativeRepository();
	const cleanups: Record<string, unknown>[] = [];
	const recorded = (state: string) => ({
		operationId: "op",
		actorId: "agent-1",
		state,
		phase: "authorized",
		attempts: 1,
		command: { tool: "cleanup_workspace", workspaceId: "blocked", idempotencyKey: "recorded-key" },
	});
	const workspaces: Record<string, Record<string, unknown>> = {
		blocked: { id: "blocked", state: "cancelled", cleanup: recorded("blocked") },
		done: { id: "done", state: "cancelled", cleanup: recorded("complete") },
		fresh: { id: "fresh", state: "cancelled" },
	};
	const hosted = createServer(async (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		response.setHeader("content-type", "application/json");
		if (!("id" in body)) {
			response.writeHead(202).end();
			return;
		}
		let result: unknown = {};
		if (body.method === "initialize")
			result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
		else if (body.method === "tools/call") {
			const command = { ...body.params.arguments, tool: body.params.name };
			let data: Record<string, unknown> = { workspaces: [] };
			if (command.tool === "get_workspace") data = workspaces[command.workspaceId];
			else if (command.tool === "cleanup_workspace") {
				cleanups.push(command);
				data = { workspaceId: command.workspaceId, state: "deleted" };
			}
			result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
		}
		response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
	});
	const client = new Client({ name: "cleanup-test", version: "1" });
	let transport: StdioClientTransport | undefined;
	try {
		await new Promise<void>((done) => hosted.listen(0, "127.0.0.1", done));
		const address = hosted.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture address");
		await writeState(join(await stateDirectory(fixture.root), "connection.json"), {
			server: `http://127.0.0.1:${address.port}`,
			namespaceId: "ns",
			repositoryId: "repo",
		});
		transport = new StdioClientTransport({
			command: process.execPath,
			args: [resolve("runner/cruce.mjs"), "mcp", "--cwd", fixture.root],
			stderr: "pipe",
		});
		await client.connect(transport);
		for (const workspaceId of ["blocked", "done", "fresh"])
			expect((await client.callTool({ name: "cleanup_workspace", arguments: { workspaceId } })).isError).toBeFalsy();
		const [blocked, done, fresh] = cleanups.map((c) => c.idempotencyKey);
		expect(blocked).toBe("recorded-key");
		expect(done).not.toBe("recorded-key");
		expect(fresh).not.toBe("recorded-key");
		expect(done).not.toBe(fresh);
	} finally {
		await client.close();
		await transport?.close();
		await new Promise<void>((done) => hosted.close(() => done()));
		await fixture.close();
	}
}, 30000);
