import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PARTICIPATION } from "../src/shared/coordination.ts";

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
		block = `${start}\n${PARTICIPATION}\nUse the Cruce MCP tools at task start, scope changes and publication.\n${end}`;
	const next =
		original.includes(start) && original.includes(end)
			? `${original.slice(0, original.indexOf(start))}${block}${original.slice(original.indexOf(end) + end.length)}`
			: `${original.trimEnd()}\n\n${block}\n`;
	await mkdir(dirname(instructionPath), { recursive: true });
	await writeFile(
		instructionPath,
		client === "cursor" && !original ? `---\ndescription: Cruce coordination\nalwaysApply: true\n---\n${next}` : next,
	);
	const exclude = join(cwd, ".gitignore"),
		ignore = await read(exclude);
	if (!ignore.split(/\r?\n/).includes(".cruce/")) await writeFile(exclude, `${ignore.trimEnd()}\n.cruce/\n`);
	return { client, capabilities: ["git_observation", "intent_mcp"], adaptiveVerified: false, hooksInstalled: false };
}
