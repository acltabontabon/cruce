import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { COST_LABELS, type Scope } from "../core/capabilities.ts";
import { domainStatus } from "../core/errors.ts";
import type { Command } from "../shared/platform.ts";
import { CRUCE_INSTRUCTIONS, CRUCE_TOOLS, toInternalCommand, toolInputShape } from "../shared/tools.ts";
import { CRUCE_VERSION } from "../shared/version.ts";
export type MachineCommand = Command;

/**
 * Cruce MCP. Tools express Cruce's development lifecycle; resource-consuming tools say so in their
 * description and are governed by scopes, policy and budgets. A connection only sees tools its
 * scopes allow. Generic Cloudflare administration belongs to Cloudflare's own MCP servers.
 */
export function cruceServer(execute: (command: MachineCommand) => Promise<unknown>, scopes?: readonly Scope[]) {
	const server = new McpServer({ name: "Cruce", version: CRUCE_VERSION }, { instructions: CRUCE_INSTRUCTIONS });
	for (const tool of CRUCE_TOOLS) {
		if (scopes && !scopes.includes(tool.scope)) continue;
		const cost =
			tool.class === "resource" ? ` Resource action: ${COST_LABELS[tool.cost]}; subject to namespace and repository policy.` : "";
		server.registerTool(
			tool.name,
			{
				description: `${tool.description}${cost}`,
				inputSchema: toolInputShape(tool),
				annotations: {
					readOnlyHint: !tool.mutation,
					destructiveHint: tool.name === "cleanup_workspace",
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
					return {
						isError: true,
						structuredContent: { status: domainStatus(error) ?? 500 },
						content: [{ type: "text" as const, text: (error as Error).message }],
					};
				}
			},
		);
	}
	return server;
}
export function remoteMcp(execute: (command: MachineCommand) => Promise<unknown>, scopes?: readonly Scope[]) {
	return createMcpHandler(() => cruceServer(execute, scopes));
}
