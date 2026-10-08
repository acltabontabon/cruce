import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveCheckout } from "../../runner/checkout.ts";

let directory: string;
const server = "https://cruce.example";
const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "cruce-checkout-"));
	git("init", "-q");
});
afterEach(() => rm(directory, { recursive: true, force: true }));

it("finds the repository from its canonical remote without writing local state", async () => {
	git("remote", "add", "origin", "https://github.com/team/repo.git");
	expect(await resolveCheckout(directory, server)).toBeUndefined();
	git("remote", "add", "cruce", `${server}/mcp/git/team-ns/repo-1/canonical.git`);
	expect(await resolveCheckout(directory, server)).toEqual({ server, namespaceId: "team-ns", repositoryId: "repo-1" });
	expect(await resolveCheckout(join(directory, ".git"), server)).toEqual({ server, namespaceId: "team-ns", repositoryId: "repo-1" });
	expect(await resolveCheckout(directory, "https://other.example")).toBeUndefined();
	expect(await readdir(join(directory, ".git"))).not.toContain("cruce");
});

it("ignores forks, other servers and credentialed URLs, and refuses to guess between repositories", async () => {
	git("remote", "add", "fork", `${server}/mcp/git/team/repo/workspace-1.git`);
	git("remote", "add", "elsewhere", "https://other.example/mcp/git/team/repo/canonical.git");
	git("remote", "add", "secret", "https://user:token@cruce.example/mcp/git/team/repo/canonical.git");
	expect(await resolveCheckout(directory, server)).toBeUndefined();
	git("remote", "add", "first", `${server}/mcp/git/team/one/canonical.git`);
	git("remote", "add", "again", `${server}/mcp/git/team/one/canonical.git`);
	expect(await resolveCheckout(directory, server)).toMatchObject({ repositoryId: "one" });
	git("remote", "add", "second", `${server}/mcp/git/team/two/canonical.git`);
	await expect(resolveCheckout(directory, server)).rejects.toThrow("Several Cruce repositories");
});

it("prefers the repository an attachment recorded, and treats other directories as no checkout", async () => {
	git("remote", "add", "cruce", `${server}/mcp/git/team/from-remote/canonical.git`);
	await mkdir(join(directory, ".git/cruce"));
	await writeFile(
		join(directory, ".git/cruce/connection.json"),
		JSON.stringify({ server: `${server}/`, namespaceId: "team", repositoryId: "recorded" }),
	);
	expect(await resolveCheckout(directory)).toEqual({ server, namespaceId: "team", repositoryId: "recorded" });
	expect(await resolveCheckout(directory, server)).toMatchObject({ repositoryId: "recorded" });
	await writeFile(join(directory, ".git/cruce/connection.json"), JSON.stringify({ server, namespaceId: "../x", repositoryId: "r" }));
	expect(await resolveCheckout(directory, server)).toMatchObject({ repositoryId: "from-remote" });
	const outside = await mkdtemp(join(tmpdir(), "cruce-outside-"));
	try {
		expect(await resolveCheckout(outside, server)).toBeUndefined();
		expect(await resolveCheckout(join(outside, "missing"), server)).toBeUndefined();
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

it("starts the user-level bridge outside a checkout with guidance, and keeps the prompt hint silent", async () => {
	const env = { ...process.env, CLAUDE_PROJECT_DIR: directory };
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [resolve("runner/cruce.mjs"), "mcp", "--server", server, "--client", "claude"],
		cwd: directory,
		env,
		stderr: "pipe",
	});
	const client = new Client({ name: "unbound-test", version: "1" });
	try {
		await client.connect(transport);
		expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("start_workspace");
		const result = await client.callTool({ name: "start_workspace", arguments: { title: "Work" } });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain(`git remote add cruce ${server}/mcp/git/NAMESPACE/REPOSITORY/canonical.git`);
	} finally {
		await client.close();
	}
	const hint = await promisify(execFile)(
		process.execPath,
		[resolve("runner/cruce.mjs"), "hint", "--server", server, "--client", "claude"],
		{
			cwd: directory,
			env,
		},
	);
	expect(hint).toEqual({ stdout: "", stderr: "" });
	expect(await readdir(join(directory, ".git"))).not.toContain("cruce");
}, 20000);
