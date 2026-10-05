import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupExecution, context, createExecution, observeChanges, releaseCheckout, reserveCheckout } from "../../runner/execution.ts";
import { git, packRevision } from "../../runner/local-git.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function repository() {
	const root = await mkdtemp(join(tmpdir(), "cruce-session-"));
	paths.push(root);
	const run = (args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			env: {
				...process.env,
				GIT_CONFIG_COUNT: "2",
				GIT_CONFIG_KEY_0: "commit.gpgsign",
				GIT_CONFIG_VALUE_0: "false",
				GIT_CONFIG_KEY_1: "core.hooksPath",
				GIT_CONFIG_VALUE_1: "/dev/null",
			},
			stdio: "pipe",
		})
			.toString()
			.trim();
	run(["init", "-b", "trunk"]);
	run(["config", "user.name", "Fixture"]);
	run(["config", "user.email", "fixture@example.com"]);
	await writeFile(join(root, "code.txt"), "original\n");
	run(["add", "."]);
	run(["commit", "-m", "Baseline"]);
	run(["remote", "add", "origin", "https://example.invalid/repo.git"]);
	return { root, run, base: run(["rev-parse", "HEAD"]) };
}
describe("local session execution", () => {
	it("creates separate worktrees while preserving local remotes and uncommitted work", async () => {
		const { root, base } = await repository();
		await writeFile(join(root, "code.txt"), "working change\n");
		const [a, b] = await Promise.all([createExecution(root, "session-a", base), createExecution(root, "session-b", base)]);
		expect(a.execution.checkoutId).not.toBe(b.execution.checkoutId);
		expect(await readFile(join(root, "code.txt"), "utf8")).toBe("working change\n");
		expect(await git(root, ["remote", "get-url", "origin"])).toBe("https://example.invalid/repo.git");
		expect(await git(a.directory, ["rev-parse", "HEAD"])).toBe(base);
		expect((await createExecution(root, "session-a", base)).directory).toBe(a.directory);
	});
	it("real paths reject duplicate writers and ownership-safe release", async () => {
		const { root } = await repository();
		await reserveCheckout(root, "a");
		await expect(reserveCheckout(root, "b")).rejects.toThrow("already has a writer");
		await expect(releaseCheckout(root, "b")).rejects.toThrow("another session");
		const alias = join(tmpdir(), `cruce-alias-${Date.now()}`);
		paths.push(alias);
		await symlink(root, alias);
		expect((await context(root, "a", false)).checkoutId).toBe((await context(alias, "a", false)).checkoutId);
		await releaseCheckout(root, "a");
		await reserveCheckout(root, "b");
	});
	it("reports renamed, binary, deleted and untracked files without reading symlink targets", async () => {
		const { root, base, run } = await repository();
		run(["mv", "code.txt", "renamed.txt"]);
		await writeFile(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
		run(["add", "binary.dat"]);
		await symlink("/not/read/secret", join(root, "link"));
		const observed = await observeChanges(root, base);
		expect(observed.changes).toContainEqual({ path: "renamed.txt", previousPath: "code.txt", status: "renamed" });
		expect(observed.changes).toContainEqual({ path: "binary.dat", status: "added", binary: true });
		expect(observed.changes).toContainEqual({ path: "link", status: "added" });
	});
	it("exports exact commits including their local baseline, without rebuilding", async () => {
		const { root, base, run } = await repository();
		await writeFile(join(root, "code.txt"), "next\n");
		run(["add", "."]);
		run(["commit", "-m", "Exact commit"]);
		const head = run(["rev-parse", "HEAD"]),
			packed = await packRevision(root, base);
		const remote = new GitWorkspace(new MemoryFs() as never);
		await remote.ensureInit();
		await remote.importPack(Buffer.from(packed.pack, "base64"));
		expect((await remote.log(head))[0].oid).toBe(head);
		expect(await remote.mergeBase(base, head)).toBe(base);
	});
	it("cleanup refuses dirty or unpublished work and only removes owned worktrees", async () => {
		const { root, base } = await repository();
		const work = await createExecution(root, "session-safe", base);
		await writeFile(join(work.directory, "new.txt"), "preserve");
		await expect(cleanupExecution(work.directory, "session-safe", base)).rejects.toThrow("Uncommitted");
		await rm(join(work.directory, "new.txt"));
		await expect(cleanupExecution(work.directory, "wrong", base)).rejects.toThrow("not owned");
		await expect(cleanupExecution(work.directory, "session-safe", "b".repeat(40))).rejects.toThrow("Unpublished");
		await cleanupExecution(work.directory, "session-safe", base);
		expect(await git(root, ["rev-parse", "HEAD"])).toBe(base);
	});
});
