import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { COST_LABELS, type Scope } from "../core/capabilities.ts";
import type { Command } from "../shared/coordination.ts";
import type { PlatformCommand } from "../shared/platform.ts";
import { CRUCE_INSTRUCTIONS, CRUCE_TOOLS, toInternalCommand, toolInputShape } from "../shared/tools.ts";
export type MachineCommand = Command | PlatformCommand;

/**
 * Cruce MCP. Tools express Cruce's development lifecycle; resource-consuming tools say so in their
 * description and are governed by scopes, policy and budgets. A connection only sees tools its
 * scopes allow. Generic Cloudflare administration belongs to Cloudflare's own MCP servers.
 */
export function cruceServer(execute: (command: MachineCommand) => Promise<unknown>, scopes?: readonly Scope[]) {
	const server = new McpServer({ name: "Cruce", version: "0.4.0" }, { instructions: CRUCE_INSTRUCTIONS });
	for (const tool of CRUCE_TOOLS) {
		if (scopes && !scopes.includes(tool.scope)) continue;
		const cost = tool.class === "resource" ? ` Resource action: ${COST_LABELS[tool.cost]}; subject to project policy.` : "";
		server.registerTool(
			tool.name,
			{
				description: `${tool.description}${cost}`,
				inputSchema: toolInputShape(tool),
				annotations: {
					readOnlyHint: !tool.mutation,
					destructiveHint: false,
					idempotentHint: !tool.mutation,
					openWorldHint: tool.class === "resource",
				},
			},
			async (args: Record<string, unknown>) => {
				try {
					const result = await execute(toInternalCommand(tool, args));
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						structuredContent: result as Record<string, unknown>,
					};
				} catch (error) {
					return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] };
				}
			},
		);
	}
	return server;
}
export function remoteMcp(execute: (command: MachineCommand) => Promise<unknown>, scopes?: readonly Scope[]) {
	return createMcpHandler(() => cruceServer(execute, scopes));
}
