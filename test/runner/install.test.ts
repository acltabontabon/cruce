import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { configureServerCredentials } from "../../runner/git-auth.ts";
import { configureFork } from "../../runner/git-remotes.ts";
import { clientArchive } from "../../tools/client-package.ts";

it("ships an executable client outside the source checkout, with both entrypoints and runtime dependencies", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cruce-install-"));
	try {
		const archive = join(directory, "client.tgz");
		await writeFile(archive, await clientArchive());
		const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
		expect(files.every((file) => /^package\/(runner\/|src\/(core|shared)\/|package.json$|LICENSE$)/.test(file))).toBe(true);
		execFileSync("tar", ["-xzf", archive, "-C", directory]);
		const metadata = JSON.parse(await readFile(join(directory, "package/package.json"), "utf8"));
		expect(Object.keys(metadata.dependencies).sort()).toEqual([
			"@modelcontextprotocol/client",
			"@modelcontextprotocol/server",
			"tsx",
			"zod",
		]);
		// Use the frozen installation's dependency graph; the packed program itself must resolve
		// every relative runtime import from its archive, not from the Cruce source checkout.
		await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(directory, "package/node_modules"), "dir");
		const output = execFileSync(process.execPath, [join(directory, "package", metadata.bin.cruce), "--help"], {
			cwd: directory,
			encoding: "utf8",
		});
		expect(output).toContain("cruce login --server URL");
		expect(output).not.toContain("cruce auth");
		expect(metadata.bin["cruce-git-credential"]).toBe("runner/git-credential.mjs");
		expect(
			execFileSync(
				process.execPath,
				[join(directory, "package", metadata.bin["cruce-git-credential"]), "--server", "https://cruce.example", "store"],
				{ cwd: directory, encoding: "utf8" },
			),
		).toBe("");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20000);

it("configures Git once for the Cruce server and preserves other helpers across retries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cruce-auth-"));
	try {
		const config = join(directory, "gitconfig");
		await writeFile(config, "[credential]\n\thelper = existing-helper\n");
		const origin = await configureServerCredentials("https://cruce.example/", config);
		await configureServerCredentials("https://cruce.example", config);
		expect(origin).toBe("https://cruce.example");
		const read = (key: string) => execFileSync("git", ["config", "--file", config, "--get-all", key], { encoding: "utf8" });
		expect(read("credential.helper")).toBe("existing-helper\n");
		expect(read(`credential.${origin}.useHttpPath`)).toBe("true\n");
		const helpers = read(`credential.${origin}.helper`).split("\n");
		expect(helpers).toHaveLength(3);
		expect(helpers[0]).toBe("");
		expect(helpers[1]).toContain("git-credential.mjs");
		expect(helpers[1]).toContain("--client 'git'");
		expect(helpers[1]).not.toMatch(/token|password|namespace|repository/);
		const before = await readFile(config, "utf8");
		await expect(configureServerCredentials("https://user:secret@cruce.example", config)).rejects.toThrow();
		await expect(configureServerCredentials("http://cruce.example", config)).rejects.toThrow();
		expect(await readFile(config, "utf8")).toBe(before);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("answers canonical Git with the account login and a workspace fork with its tool's own connection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cruce-precedence-"));
	try {
		const home = join(directory, "home"),
			repo = join(directory, "repo"),
			global = join(directory, "gitconfig");
		await mkdir(home);
		await configureServerCredentials("https://cruce.example", global);
		const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
		const run = (args: string[], input?: string) =>
			execFileSync("git", args, { cwd: repo, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
		await mkdir(repo);
		run(["init", "-q", "-b", "cruce/workspace-agent-a"]);
		run(["-c", "user.email=a@example.com", "-c", "user.name=A", "commit", "-q", "--allow-empty", "-m", "Base"]);
		await configureFork(repo, "agent-a", "https://cruce.example", "codex", "/mcp/git/team/repo/agent-a.git");
		// Helpers run without stored sign-in, so each one names the connection it reads in its recovery hint.
		const helperFor = (url: string) => {
			try {
				run(["credential", "fill"], `url=${url}\n\n`);
			} catch (error) {
				return String((error as { stderr?: string }).stderr);
			}
			throw new Error("Credential unexpectedly available");
		};
		expect(helperFor("https://cruce.example/mcp/git/team/repo/canonical.git")).toContain("cruce login --server https://cruce.example");
		const fork = helperFor("https://cruce.example/mcp/git/team/repo/agent-a.git");
		expect(fork).toContain("cruce connect --server https://cruce.example --client codex");
		expect(fork).not.toContain("cruce login");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20000);

it("registers the bridge in each tool's user settings once, never in a project", async () => {
	const { configureClient } = await import("../../runner/client-config.ts");
	const home = await mkdtemp(join(tmpdir(), "cruce-client-"));
	const previous = process.env.CODEX_HOME;
	delete process.env.CODEX_HOME;
	try {
		const calls: string[][] = [];
		const run = async (command: string, args: string[]) => {
			calls.push([command, ...args]);
		};
		const options = { home, node: "/usr/bin/node", run };
		const bridge = "/opt/cruce/runner/cruce.mjs";
		await configureClient("codex", bridge, "https://cruce.example", options);
		await configureClient("codex", bridge, "https://cruce.example", options);
		const codex = await readFile(join(home, ".codex/config.toml"), "utf8");
		expect(codex.match(/\[mcp_servers\.cruce\]/g)).toHaveLength(1);
		expect(codex).toContain(`args = ["${bridge}","mcp","--server","https://cruce.example","--client","codex"]`);
		await mkdir(join(home, ".cursor"));
		await writeFile(join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" } } }));
		await configureClient("cursor", bridge, "https://cruce.example", options);
		const cursor = JSON.parse(await readFile(join(home, ".cursor/mcp.json"), "utf8"));
		expect(cursor.mcpServers.other).toEqual({ command: "other" });
		expect(cursor.mcpServers.cruce.args).toEqual([
			bridge,
			"mcp",
			"--server",
			"https://cruce.example",
			"--client",
			"cursor",
			"--cwd",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor substitutes this variable, not JavaScript.
			"${workspaceFolder}",
		]);
		const path = join(home, ".claude/settings.json");
		await mkdir(join(home, ".claude"));
		const own = { hooks: [{ type: "command", command: "echo mine" }] };
		await writeFile(path, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { UserPromptSubmit: [own] } }));
		for (let i = 0; i < 2; i++)
			expect(await configureClient("claude", bridge, "https://cruce.example", options)).toMatchObject({ hooksInstalled: true });
		expect(calls.at(-1)).toEqual([
			"claude",
			"mcp",
			"add-json",
			"--scope",
			"user",
			"cruce",
			JSON.stringify({
				type: "stdio",
				command: "/usr/bin/node",
				args: [bridge, "mcp", "--server", "https://cruce.example", "--client", "claude"],
			}),
		]);
		expect(calls.at(-2)).toEqual(["claude", "mcp", "remove", "--scope", "user", "cruce"]);
		const settings = JSON.parse(await readFile(path, "utf8"));
		expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
		expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
		expect(settings.hooks.UserPromptSubmit[0]).toEqual(own);
		expect(settings.hooks.UserPromptSubmit[1].hooks[0].command).toBe(
			`'/usr/bin/node' '${bridge}' hint --server 'https://cruce.example' --client claude`,
		);
		await expect(
			configureClient("claude", bridge, "https://cruce.example", {
				...options,
				run: async (_command, args) => {
					if (args[1] === "add-json") throw new Error("ENOENT");
				},
			}),
		).rejects.toThrow("claude mcp add --scope user cruce");
	} finally {
		if (previous !== undefined) process.env.CODEX_HOME = previous;
		await rm(home, { recursive: true, force: true });
	}
});
