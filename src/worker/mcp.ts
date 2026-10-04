import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { type Command, CommandInput, PARTICIPATION, TOOLS } from "../shared/coordination.ts";
import { PLATFORM_TOOLS, type PlatformCommand, PlatformCommandInput } from "../shared/platform.ts";
export type MachineCommand = Command | PlatformCommand;
export function coordinationServer(execute: (command: MachineCommand) => Promise<unknown>) {
	const server = new McpServer(
		{ name: "Cruce", version: "0.3.0" },
		{
			instructions: `${PARTICIPATION} Cruce owns accepted source and native proposals. Publish immutable artifacts, attach exact-revision evidence and request review. Agent reviews never replace human approval; agents cannot promote canonical state. Use intent and mission lineage instead of external pull requests.`,
		},
	);
	for (const tool of [...TOOLS, ...PLATFORM_TOOLS]) {
		const native = (PLATFORM_TOOLS as readonly string[]).includes(tool),
			schema = native ? PlatformCommandInput : CommandInput;
		const inputSchema = native ? PlatformCommandInput.omit({ tool: true }).shape : CommandInput.omit({ tool: true }).shape;
		server.registerTool(tool, { description: tool.replaceAll("_", " "), inputSchema }, async (args: Record<string, unknown>) => {
			try {
				const result = await execute(schema.parse({ ...args, tool }) as MachineCommand);
				return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
			} catch (error) {
				return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] };
			}
		});
	}
	return server;
}
export function remoteMcp(execute: (command: MachineCommand) => Promise<unknown>) {
	return createMcpHandler(() => coordinationServer(execute));
}
