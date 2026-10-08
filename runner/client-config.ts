import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { shellQuote } from "./git-remotes.ts";

export type KnownClient = "codex" | "claude" | "cursor";
export const KNOWN_CLIENTS: readonly KnownClient[] = ["claude", "codex", "cursor"];
type Run = (command: string, args: string[]) => Promise<unknown>;
const execute = promisify(execFile);

async function read(path: string) {
	return readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
		if (e.code !== "ENOENT") throw e;
		return "";
	});
}
/** The stdio command a tool runs; the bridge finds the repository from the checkout the tool works in. */
export function bridgeCommand(bridge: string, server: string, client: string) {
	return [bridge, "mcp", "--server", server, "--client", client];
}
/**
 * Register the bridge once in the tool's user-level settings, so every Cruce checkout on this machine can use it.
 * Project files stay untouched; the bridge's MCP instructions carry participation guidance.
 */
export async function configureClient(
	client: KnownClient,
	bridge: string,
	server: string,
	{
		home = homedir(),
		node = process.execPath,
		run = (command, args) => execute(command, args),
	}: { home?: string; node?: string; run?: Run } = {},
) {
	const args = bridgeCommand(bridge, server, client);
	if (client === "claude") {
		// Claude Code rewrites its own settings while running, so register through its CLI rather than editing them.
		await run("claude", ["mcp", "remove", "--scope", "user", "cruce"]).catch(() => {});
		try {
			await run("claude", ["mcp", "add-json", "--scope", "user", "cruce", JSON.stringify({ type: "stdio", command: node, args })]);
		} catch {
			throw new Error(
				`Claude Code was not found. Install it, then run: claude mcp add --scope user cruce -- ${[node, ...args].map(shellQuote).join(" ")}`,
			);
		}
		await installPromptHook(home, bridge, server, node);
	} else if (client === "codex") {
		const path = join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml"),
			original = await read(path);
		const block = `[mcp_servers.cruce]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}\n`;
		const section = /^\[mcp_servers\.cruce\][\s\S]*?(?=^\[|$(?![\s\S]))/m;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, section.test(original) ? original.replace(section, block) : `${original.trimEnd()}\n\n${block}`.trimStart());
	} else {
		const path = join(home, ".cursor/mcp.json"),
			original = await read(path),
			config = original ? JSON.parse(original) : {};
		// Cursor starts global servers outside the project; it names the open workspace folder instead.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor substitutes this variable, not JavaScript.
		config.mcpServers = { ...config.mcpServers, cruce: { command: node, args: [...args, "--cwd", "${workspaceFolder}"] } };
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
	}
	return { client, capabilities: ["git_observation", "coordination_mcp"], adaptiveVerified: false, hooksInstalled: client === "claude" };
}
/**
 * Claude Code runs this before each prompt and adds its output to the session, so workspaces left behind by a
 * promotion in the console reach the coordinating agent at its next turn. Outside a Cruce checkout it prints nothing.
 * Cruce still wakes and messages no one. The user's other hooks and settings stay untouched.
 */
async function installPromptHook(home: string, bridge: string, server: string, node: string) {
	const path = join(home, ".claude/settings.json"),
		original = await read(path),
		settings = original ? JSON.parse(original) : {},
		command = `${shellQuote(node)} ${shellQuote(bridge)} hint --server ${shellQuote(server)} --client claude`;
	type Entry = { hooks?: { command?: string }[] };
	const others = ((settings.hooks?.UserPromptSubmit ?? []) as Entry[]).filter(
		(entry) => !entry.hooks?.some((hook) => hook.command?.includes(" hint ") && hook.command.includes(shellQuote(bridge))),
	);
	settings.hooks = { ...settings.hooks, UserPromptSubmit: [...others, { hooks: [{ type: "command", command, timeout: 15 }] }] };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
}
