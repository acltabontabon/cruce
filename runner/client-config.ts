import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CRUCE_INSTRUCTIONS } from "../src/shared/tools.ts";
import { shellQuote } from "./git-remotes.ts";

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
	const hooksInstalled = client === "claude" && (await installPromptHook(cwd, bridge, node));
	return { client, capabilities: ["git_observation", "coordination_mcp"], adaptiveVerified: false, hooksInstalled };
}
/**
 * Claude Code runs this before each prompt and adds its output to the session, so workspaces left behind by a
 * promotion in the console reach the coordinating agent at its next turn. Cruce still wakes and messages no one.
 * Machine-local paths belong in the local settings file, beside the user's other hooks, which stay untouched.
 */
async function installPromptHook(cwd: string, bridge: string, node: string) {
	const path = join(cwd, ".claude/settings.local.json"),
		original = await read(path),
		settings = original ? JSON.parse(original) : {},
		command = `${shellQuote(node)} ${shellQuote(bridge)} hint --cwd ${shellQuote(cwd)}`;
	type Entry = { hooks?: { command?: string }[] };
	const others = ((settings.hooks?.UserPromptSubmit ?? []) as Entry[]).filter(
		(entry) => !entry.hooks?.some((hook) => hook.command?.includes(" hint --cwd ") && hook.command.includes(shellQuote(bridge))),
	);
	settings.hooks = { ...settings.hooks, UserPromptSubmit: [...others, { hooks: [{ type: "command", command, timeout: 15 }] }] };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
	return true;
}
