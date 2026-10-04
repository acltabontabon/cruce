import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configureClient } from "../../runner/client-config.ts";
import { git, observe, packRevision, workspace } from "../../runner/local-git.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";

describe("native client connection", () => {
	for (const client of ["codex", "claude", "cursor"] as const)
		it(`preserves ${client} configuration and scopes participation`, async () => {
			const root = await mkdtemp(join(tmpdir(), "cruce-config-"));
			try {
				if (client === "codex") {
					await mkdir(join(root, ".codex"));
					await writeFile(join(root, ".codex/config.toml"), 'model = "unchanged"\n[mcp_servers.other]\ncommand = "existing"\n');
				} else {
					const path = join(root, client === "claude" ? ".mcp.json" : ".cursor/mcp.json");
					if (client === "cursor") await mkdir(join(root, ".cursor"));
					await writeFile(path, JSON.stringify({ mcpServers: { other: { command: "existing" } } }));
				}
				const a = await configureClient(root, client, "/bridge/cruce.ts");
				await configureClient(root, client, "/bridge/cruce.ts");
				expect(a.adaptiveVerified).toBe(false);
				expect(a.hooksInstalled).toBe(false);
				const config = await readFile(
					join(root, client === "codex" ? ".codex/config.toml" : client === "claude" ? ".mcp.json" : ".cursor/mcp.json"),
					"utf8",
				);
				expect(config).toContain("existing");
				expect(config).toContain("/bridge/cruce.ts");
				const instructions = await readFile(
					join(root, client === "claude" ? "CLAUDE.md" : client === "cursor" ? ".cursor/rules/cruce.mdc" : "AGENTS.md"),
					"utf8",
				);
				expect(instructions.match(/<!-- Cruce participation -->/g)).toHaveLength(1);
				expect(instructions).toContain("preserving working-tree changes");
				expect(instructions).toContain("publish_revision");
				expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(".cruce/");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	it("observes real Git changes, deletions and new files without altering the checkout", async () => {
		const root = await mkdtemp(join(tmpdir(), "cruce-observation-"));
		try {
			await git(root, ["init", "-b", "main"]);
			await git(root, ["config", "user.name", "Fixture"]);
			await git(root, ["config", "user.email", "fixture@invalid.test"]);
			await writeFile(join(root, "file with spaces.ts"), "export const value = 1;\n");
			await writeFile(join(root, "old.py"), "old = True\n");
			await git(root, ["add", "."]);
			await git(root, ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Baseline"]);
			const before = await workspace(root);
			await writeFile(join(root, "file with spaces.ts"), "export const value = 2;\n");
			await rm(join(root, "old.py"));
			await writeFile(join(root, "new.py"), "new = True\n");
			await symlink("/outside/private-data", join(root, "link"));
			const changes = await observe(root, before.head);
			expect(changes.headFiles.link).toBe("/outside/private-data");
			expect(changes.kind).toBe("working_tree");
			expect(changes.files["file with spaces.ts"]).toBe("export const value = 1;\n");
			expect(changes.headFiles["file with spaces.ts"]).toBe("export const value = 2;\n");
			expect(changes.changes.map((c) => c.status).sort()).toEqual(["added", "added", "deleted", "modified"]);
			expect(await git(root, ["rev-parse", "HEAD"])).toBe(before.head);
			expect((await workspace(root)).checkoutId).toBe(before.checkoutId);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("packages committed work as a Git pack the control plane imports with the exact revision", async () => {
		const root = await mkdtemp(join(tmpdir(), "cruce-pack-"));
		const commit = (message: string) =>
			git(root, ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", message]);
		try {
			await git(root, ["init", "-b", "main"]);
			await git(root, ["config", "user.name", "Fixture"]);
			await git(root, ["config", "user.email", "fixture@invalid.test"]);
			await writeFile(join(root, "app.ts"), "export const limit = 10;\n");
			await git(root, ["add", "."]);
			await commit("Baseline");
			const base = await git(root, ["rev-parse", "HEAD"]);
			await expect(packRevision(root, base)).rejects.toThrow("commit your work first");
			await writeFile(join(root, "app.ts"), "export const limit = 100;\n");
			await git(root, ["add", "."]);
			await commit("Raise rate limit");
			await writeFile(join(root, "draft.ts"), "uncommitted\n");
			const packed = await packRevision(root, base);
			expect(packed).toMatchObject({ base, commits: 1, revision: await git(root, ["rev-parse", "HEAD"]) });
			const server = new GitWorkspace(new MemoryFs() as never, "/server.git");
			await server.ensureInit();
			await server.importPack(Uint8Array.from(Buffer.from(packed.pack, "base64")));
			expect(await server.readFiles(packed.revision)).toEqual({ "app.ts": "export const limit = 100;\n" });
			expect((await server.log(packed.revision, 1))[0].parents).toEqual([base]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
