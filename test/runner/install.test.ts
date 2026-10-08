import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { configureCanonicalCredentials } from "../../runner/git-auth.ts";
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
		expect(output).toContain("cruce auth --server URL");
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

it("keeps Git credentials scoped to the selected canonical repository and preserves other helpers across retries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cruce-auth-"));
	try {
		const config = join(directory, "gitconfig");
		await writeFile(config, "[credential]\n\thelper = existing-helper\n");
		const url = await configureCanonicalCredentials("https://cruce.example", "namespace", "repository", config);
		await configureCanonicalCredentials("https://cruce.example", "namespace", "repository", config);
		const read = (key: string) => execFileSync("git", ["config", "--file", config, "--get-all", key], { encoding: "utf8" });
		expect(read("credential.helper")).toBe("existing-helper\n");
		expect(read(`credential.${url}.useHttpPath`)).toBe("true\n");
		const helpers = read(`credential.${url}.helper`).split("\n");
		expect(helpers).toHaveLength(3);
		expect(helpers[0]).toBe("");
		expect(helpers[1]).toContain("git-credential.mjs");
		expect(helpers[1]).not.toMatch(/token|password/);
		const before = await readFile(config, "utf8");
		await expect(configureCanonicalCredentials("https://user:secret@cruce.example", "namespace", "repository", config)).rejects.toThrow();
		await expect(configureCanonicalCredentials("https://cruce.example", "../other", "repository", config)).rejects.toThrow();
		expect(await readFile(config, "utf8")).toBe(before);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("installs one Claude Code prompt hint beside the user's own hooks and replaces it on reconnect", async () => {
	const { configureClient } = await import("../../runner/client-config.ts");
	const directory = await mkdtemp(join(tmpdir(), "cruce-client-"));
	try {
		const path = join(directory, ".claude/settings.local.json");
		await configureClient(directory, "codex", "/opt/cruce/runner/cruce.mjs", "/usr/bin/node");
		await expect(readFile(path, "utf8")).rejects.toThrow();
		execFileSync("mkdir", ["-p", join(directory, ".claude")]);
		const own = { hooks: [{ type: "command", command: "echo mine" }] };
		await writeFile(path, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { UserPromptSubmit: [own] } }));
		for (let i = 0; i < 2; i++)
			expect(await configureClient(directory, "claude", "/opt/cruce/runner/cruce.mjs", "/usr/bin/node")).toMatchObject({
				hooksInstalled: true,
			});
		const settings = JSON.parse(await readFile(path, "utf8"));
		expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
		expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
		expect(settings.hooks.UserPromptSubmit[0]).toEqual(own);
		expect(settings.hooks.UserPromptSubmit[1].hooks[0].command).toBe(
			`'/usr/bin/node' '/opt/cruce/runner/cruce.mjs' hint --cwd '${directory}'`,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
