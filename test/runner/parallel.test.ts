import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";
import { stateDirectory } from "../../runner/execution.ts";
import { writeState } from "../../runner/state-file.ts";
import { findWorkspaceState } from "../../runner/workspace-state.ts";
import { nativeRepository } from "../git/native-fixture.ts";

it("targets independent workspaces through one running bridge and sees CLI state updates", async () => {
	const fixture = await nativeRepository();
	const workspaces = new Map<string, Record<string, unknown>>();
	const published: Record<string, string> = {};
	const calls: Record<string, unknown>[] = [];
	let failPublication = true;
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
		let result: unknown;
		if (body.method === "initialize")
			result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
		else if (body.method === "tools/call") {
			const command = { ...body.params.arguments, tool: body.params.name };
			calls.push(command);
			let data: Record<string, unknown>;
			if (command.tool === "start_workspace") {
				data = { id: `workspace-${workspaces.size + 1}`, baseRevision: command.baseRevision };
				workspaces.set(String(data.id), data);
			} else if (command.tool === "get_workspace") data = workspaces.get(command.workspaceId)!;
			else if (command.tool === "publish_revision") {
				if (command.workspaceId === "workspace-1" && failPublication) {
					failPublication = false;
					response.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: { isError: true, content: [{ type: "text", text: "Uncertain publication" }] },
						}),
					);
					return;
				}
				published[command.workspaceId] = command.revision;
				data = { revision: command.revision, baseRevision: command.baseRevision };
			} else data = { id: command.workspaceId };
			result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
		} else result = {};
		response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
	});
	const client = new Client({ name: "parallel-test", version: "1" });
	let transport: StdioClientTransport | undefined;
	try {
		await writeFile(join(fixture.root, "base.txt"), "base");
		fixture.run(["add", "."]);
		fixture.run(["commit", "-qm", "Base"]);
		const base = fixture.run(["rev-parse", "HEAD"]);
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
		const tools = await client.listTools();
		expect(tools.tools.find((tool) => tool.name === "publish_revision")?.inputSchema.properties).toHaveProperty("workspaceId");
		const first = (await client.callTool({ name: "start_workspace", arguments: { title: "One", baseRevision: base } }))
			.structuredContent as Record<string, unknown>;
		const second = (await client.callTool({ name: "start_workspace", arguments: { title: "Two", baseRevision: base } }))
			.structuredContent as Record<string, unknown>;
		expect(first.directory).not.toBe(second.directory);
		for (const workspace of [first, second]) {
			const directory = String(workspace.directory);
			await writeFile(join(directory, "change.txt"), String(workspace.id));
			await promisify(execFile)("git", ["-C", directory, "add", "."]);
			await promisify(execFile)("git", ["-C", directory, "commit", "-qm", String(workspace.id)]);
		}
		const results = await Promise.all(
			[first, second].map((workspace) => client.callTool({ name: "publish_revision", arguments: { workspaceId: workspace.id } })),
		);
		expect(results[0].isError).toBe(true);
		expect(results[1].isError).not.toBe(true);
		const evidence = await client.callTool({
			name: "publish_artifact",
			arguments: { workspaceId: second.id, revision: published[String(second.id)], content: "Reported tests passed" },
		});
		expect(evidence.isError).not.toBe(true);
		const proposal = await client.callTool({
			name: "create_proposal",
			arguments: { workspaceId: second.id, artifactId: "artifact-second", title: "Second change" },
		});
		expect(proposal.isError).not.toBe(true);
		await promisify(execFile)(process.execPath, [resolve("runner/cruce.mjs"), "publish", "--cwd", String(first.directory)], {
			timeout: 15000,
		});
		const retry = calls.filter((call) => call.tool === "publish_revision" && call.workspaceId === first.id);
		expect(retry[0].idempotencyKey).toBe(retry[1].idempotencyKey);
		expect(published[String(first.id)]).not.toBe(published[String(second.id)]);
		await promisify(execFile)(
			process.execPath,
			[resolve("runner/cruce.mjs"), "publish", "--cwd", fixture.root, "--workspace", String(first.id)],
			{ timeout: 15000 },
		);
		await client.callTool({ name: "report_change", arguments: { workspaceId: first.id } });
		expect(calls.at(-1)?.revision).toBe(published[String(first.id)]);
		await client.callTool({ name: "detach_workspace", arguments: { workspaceId: first.id } });
		await promisify(execFile)(
			process.execPath,
			[resolve("runner/cruce.mjs"), "resume", "--cwd", fixture.root, "--workspace", String(first.id)],
			{ timeout: 15000 },
		);
		await client.callTool({ name: "report_change", arguments: { workspaceId: first.id } });
		expect(calls.at(-1)?.revision).toBe(published[String(first.id)]);
		const resumed = await client.callTool({ name: "attach_workspace", arguments: { workspaceId: first.id } });
		expect(resumed.isError).not.toBe(true);
		expect((resumed.structuredContent as Record<string, unknown> | undefined)?.directory).toBe(first.directory);
		const common = fixture.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		await rm(join(common, "cruce", "connections", `${second.id}.json`));
		await client.callTool({ name: "publish_revision", arguments: { workspaceId: second.id } });
		expect(calls.at(-1)?.workspaceId).toBe(second.id);
		const state = JSON.parse(await readFile(join(await stateDirectory(String(second.directory)), "connection.json"), "utf8"));
		expect(state.workspaceId).toBe(second.id);
		await expect(
			findWorkspaceState(fixture.root, String(second.id), { server: "https://other.invalid", namespaceId: "ns", repositoryId: "repo" }),
		).rejects.toThrow("another repository");
		await expect(
			findWorkspaceState(fixture.root, "../other", { server: state.server, namespaceId: "ns", repositoryId: "repo" }),
		).rejects.toThrow("Valid workspace ID");
	} finally {
		await client.close();
		await transport?.close();
		await new Promise<void>((done) => hosted.close(() => done()));
		await fixture.close();
	}
}, 30000);
