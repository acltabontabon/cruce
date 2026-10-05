import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CRUCE_INSTRUCTIONS } from "../src/shared/tools.ts";

async function read(path: string) {
	return readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
		if (e.code !== "ENOENT") throw e;
		return "";
	});
}
export async function configureClient(cwd: string, client: "codex" | "claude" | "cursor", bridge: string, node = process.execPath) {
	const args = [bridge, "mcp", "--cwd", cwd, "--client", client];
	if (client === "codex") {
		const path = join(cwd, ".codex/config.toml"),
			original = await read(path);
		const block = `[mcp_servers.cruce]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}\n`;
		const section = /^\[mcp_servers\.cruce\][\s\S]*?(?=^\[|$(?![\s\S]))/m;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, section.test(original) ? original.replace(section, block) : `${original.trimEnd()}\n\n${block}`);
	} else {
		const path = join(cwd, client === "claude" ? ".mcp.json" : ".cursor/mcp.json"),
			original = await read(path),
			config = original ? JSON.parse(original) : {};
		config.mcpServers = { ...config.mcpServers, cruce: { command: node, args } };
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
	}
	const instructionPath = join(cwd, client === "claude" ? "CLAUDE.md" : client === "cursor" ? ".cursor/rules/cruce.mdc" : "AGENTS.md");
	const original = await read(instructionPath),
		start = "<!-- Cruce participation -->",
		end = "<!-- End Cruce participation -->",
		block = `${start}\n${CRUCE_INSTRUCTIONS}\nUse the Cruce MCP tools at task start (start_workspace, or continue the workspace already attached to this directory), when scope changes (list_active_workspaces, inspect_overlap, get_workspace_updates), and to publish pushed revisions (publish_revision), evidence and proposals.\n${end}`;
	const next =
		original.includes(start) && original.includes(end)
			? `${original.slice(0, original.indexOf(start))}${block}${original.slice(original.indexOf(end) + end.length)}`
			: `${original.trimEnd()}\n\n${block}\n`;
	await mkdir(dirname(instructionPath), { recursive: true });
	await writeFile(
		instructionPath,
		client === "cursor" && !original ? `---\ndescription: Cruce coordination\nalwaysApply: true\n---\n${next}` : next,
	);
	return { client, capabilities: ["git_observation", "coordination_mcp"], adaptiveVerified: false, hooksInstalled: false };
}
