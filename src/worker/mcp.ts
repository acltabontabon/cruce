import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { COST_LABELS, type Scope } from "../core/capabilities.ts";
import { DomainError, publicError } from "../core/errors.ts";
import type { Command } from "../shared/platform.ts";
import { CRUCE_INSTRUCTIONS, CRUCE_TOOLS, toInternalCommand, toolInputShape } from "../shared/tools.ts";
import { CRUCE_VERSION } from "../shared/version.ts";
import { correlate, diagnoseError, withDiagnostics } from "./diagnostics.ts";
export type MachineCommand = Command;

/**
 * Cruce MCP. Tools express Cruce's development lifecycle; resource-consuming tools say so in their
 * description and are governed by scopes and resource policy. A connection only sees tools its
 * scopes allow. Generic Cloudflare administration belongs to Cloudflare's own MCP servers.
 */
export function cruceServer(execute: (command: MachineCommand) => Promise<unknown>, scopes?: readonly Scope[]) {
	const server = new McpServer({ name: "Cruce", version: CRUCE_VERSION }, { instructions: CRUCE_INSTRUCTIONS });
	const dispatch = async (name: string, arguments_: unknown) =>
		withDiagnostics({ tool: name }, async () => {
			try {
				const tool = CRUCE_TOOLS.find((t) => t.name === name && (!scopes || scopes.includes(t.scope)));
				if (!tool) throw new DomainError(403, "Agent capability denied");
				const args = z.object(toolInputShape(tool)).parse(arguments_ ?? {});
				await correlate(args);
				const result = await execute(toInternalCommand(tool, args));
				return server.server.projectCallToolResult(
					{
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						structuredContent: result as Record<string, unknown>,
					},
					undefined,
				);
			} catch (error) {
				const { status, message } = publicError(error);
				diagnoseError("boundary_error", error, { transport: "mcp" });
				return { isError: true, structuredContent: { status }, content: [{ type: "text" as const, text: message }] };
			}
		});
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
			(args) => dispatch(tool.name, args),
		);
	}
	// Keep catalog schemas for discovery, but validate inside our boundary. The SDK's
	// default tools/call handler copies raw validation messages (including unknown keys).
	server.server.setRequestHandler("tools/call", (request) => dispatch(request.params.name, request.params.arguments));
	return server;
}
export function remoteMcp(execute: (command: MachineCommand) => Promise<unknown>, scopes?: readonly Scope[]) {
	return createMcpHandler(() => cruceServer(execute, scopes));
}
