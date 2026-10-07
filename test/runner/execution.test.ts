import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupExecution, context, createExecution, observeChanges, releaseCheckout, reserveCheckout } from "../../runner/execution.ts";
import { configureFork, continueFromFork } from "../../runner/git-remotes.ts";
import { git, pipeGit } from "../../runner/local-git.ts";
import { withStateLock, writeState } from "../../runner/state-file.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function repository() {
	const root = await mkdtemp(join(tmpdir(), "cruce-workspace-"));
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
describe("local workspace execution", () => {
	it("recovers interrupted worktree creation only from the recorded exact intent", async () => {
		const { root, base } = await repository();
		const work = await createExecution(root, "interrupted", base);
		const state = await git(work.directory, ["rev-parse", "--absolute-git-dir"]);
		const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		await rm(join(state, "cruce", "ownership.json"));
		await writeState(join(common, "cruce", "execution-interrupted.json"), {
			workspaceId: "interrupted",
			target: work.directory,
			branch: "cruce/workspace-interrupted",
			base,
			phase: "creating",
		});
		expect((await createExecution(root, "interrupted", base)).directory).toBe(work.directory);
		await expect(createExecution(root, "interrupted", "f".repeat(40))).rejects.toThrow("ownership mismatch");
	});
	it("recovers an exactly journalled branch created before its worktree", async () => {
		const { root, base } = await repository();
		const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const target = join(common, "cruce", "worktrees", "branch-interruption");
		await git(root, ["branch", "cruce/workspace-branch-interruption", base]);
		await writeState(join(common, "cruce", "execution-branch-interruption.json"), {
			workspaceId: "branch-interruption",
			target,
			branch: "cruce/workspace-branch-interruption",
			base,
			phase: "creating",
		});
		expect((await createExecution(root, "branch-interruption", base)).directory).toBe(target);
	});
	it("never adopts a pre-existing branch by leaving a false creation intent after a collision", async () => {
		const { root, base } = await repository();
		await git(root, ["branch", "cruce/workspace-collision", base]);
		for (let attempt = 0; attempt < 2; attempt++)
			await expect(createExecution(root, "collision", base)).rejects.toThrow("existing branches are preserved");
		expect(await git(root, ["rev-parse", "cruce/workspace-collision"])).toBe(base);
	});
	it("keeps persistent writer ownership when Git refuses checkout removal", async () => {
		const { root, base } = await repository();
		const work = await createExecution(root, "locked", base);
		await git(root, ["worktree", "lock", work.directory]);
		await expect(cleanupExecution(work.directory, "locked", base)).rejects.toThrow();
		await expect(reserveCheckout(work.directory, "other")).rejects.toThrow("already has a writer");
		await git(root, ["worktree", "unlock", work.directory]);
		await cleanupExecution(work.directory, "locked", base);
	});
	it("serializes the same worktree creation and exposes only complete writer files", async () => {
		const { root, base } = await repository();
		const work = await Promise.all([createExecution(root, "same", base), createExecution(root, "same", base)]);
		expect(work[0].directory).toBe(work[1].directory);
		await Promise.all(Array.from({ length: 10 }, () => reserveCheckout(work[0].directory, "same")));
		await expect(reserveCheckout(work[0].directory, "other")).rejects.toThrow("already has a writer");
	});
	it("serializes atomic state updates without losing concurrent values", async () => {
		const { root } = await repository();
		const path = join(root, "state.json");
		await writeState(path, { count: 0 });
		await Promise.all(
			Array.from({ length: 12 }, () =>
				withStateLock(path, async () => {
					const current = JSON.parse(await readFile(path, "utf8")) as { count: number };
					await writeState(path, { count: current.count + 1 });
				}),
			),
		);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ count: 12 });
	});
	it("configures independent fork push destinations without changing another worktree or origin", async () => {
		const { root, base } = await repository();
		const a = await createExecution(root, "agent-a", base);
		const b = await createExecution(root, "agent-b", base);
		await configureFork(a.directory, "agent-a", "https://cruce.example", "codex", "/mcp/git/team/repo/agent-a.git");
		await configureFork(b.directory, "agent-b", "https://cruce.example", "claude", "/mcp/git/team/repo/agent-b.git");
		expect(await git(a.directory, ["config", "branch.cruce/workspace-agent-a.pushRemote"])).toBe("cruce-agent-a");
		expect(await git(b.directory, ["config", "branch.cruce/workspace-agent-b.pushRemote"])).toBe("cruce-agent-b");
		expect(await git(root, ["remote", "get-url", "origin"])).toBe("https://example.invalid/repo.git");
		await expect(configureFork(root, "agent-a", "https://cruce.example", "codex", "/mcp/git/team/repo/agent-a.git")).rejects.toThrow(
			"dedicated branch",
		);
	});
	it("imports exact upstream objects into a workspace ref while preserving dirty files, index, branch and HEAD", async () => {
		const { root, base } = await repository();
		const a = await createExecution(root, "workspace-fetch", base);
		await writeFile(join(root, "new.txt"), "Upstream");
		await git(root, ["add", "new.txt"]);
		await git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "Upstream"]);
		const upstream = await git(root, ["rev-parse", "HEAD"]);
		await writeFile(join(a.directory, "code.txt"), "staged\n");
		await git(a.directory, ["add", "code.txt"]);
		await writeFile(join(a.directory, "code.txt"), "unstaged\n");
		await writeFile(join(a.directory, "untracked.txt"), "retain\n");
		const index = await git(a.directory, ["write-tree"]),
			status = await git(a.directory, ["status", "--porcelain"]),
			branch = await git(a.directory, ["symbolic-ref", "HEAD"]);
		await git(a.directory, ["fetch", root, "trunk:refs/cruce/upstream"]);
		expect(await git(a.directory, ["rev-parse", "refs/cruce/upstream"])).toBe(upstream);
		expect(await git(a.directory, ["rev-parse", "HEAD"])).toBe(base);
		expect(await git(a.directory, ["symbolic-ref", "HEAD"])).toBe(branch);
		expect(await git(a.directory, ["write-tree"])).toBe(index);
		expect(await git(a.directory, ["status", "--porcelain"])).toBe(status);
		expect(await readFile(join(a.directory, "code.txt"), "utf8")).toBe("unstaged\n");
		expect(await git(a.directory, ["remote", "get-url", "origin"])).toBe("https://example.invalid/repo.git");
	});
	it("continues a workspace on another machine from its pushed fork head, never from local claims", async () => {
		const first = await repository();
		const fork = join(first.root, "..", `${first.root.split("/").at(-1)}-fork.git`);
		paths.push(fork);
		execFileSync("git", ["init", "--bare", fork], { stdio: "pipe" });
		const a = await createExecution(first.root, "ws", first.base);
		await writeFile(join(a.directory, "code.txt"), "pushed work\n");
		first.run(["-C", a.directory, "commit", "-am", "Pushed work"]);
		const pushed = first.run(["-C", a.directory, "rev-parse", "HEAD"]);
		first.run(["-C", a.directory, "push", fork, "HEAD:refs/heads/cruce/workspace-ws"]);
		await writeFile(join(a.directory, "code.txt"), "unpushed work\n");

		const second = await mkdtemp(join(tmpdir(), "cruce-second-machine-"));
		paths.push(second);
		execFileSync("git", ["clone", "--quiet", first.root, second], { stdio: "pipe" });
		const b = await createExecution(second, "ws", first.base);
		await git(b.directory, ["remote", "add", "cruce-ws", fork]);
		expect(await continueFromFork(b.directory, "cruce-ws", "ws")).toBe(pushed);
		expect(await git(b.directory, ["rev-parse", "HEAD"])).toBe(pushed);
		expect(await readFile(join(b.directory, "code.txt"), "utf8")).toBe("pushed work\n");
		expect(await git(second, ["rev-parse", "HEAD"])).toBe(first.base);

		await git(b.directory, [
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=f@example.com",
			"commit",
			"--allow-empty",
			"-m",
			"Local",
		]);
		first.run(["-C", a.directory, "commit", "--amend", "-am", "Rewritten"]);
		first.run(["-C", a.directory, "push", "--force", fork, "HEAD:refs/heads/cruce/workspace-ws"]);
		await expect(continueFromFork(b.directory, "cruce-ws", "ws")).rejects.toThrow("does not fast-forward");
	});
	it("creates separate worktrees while preserving local remotes and uncommitted work", async () => {
		const { root, base } = await repository();
		await writeFile(join(root, "code.txt"), "working change\n");
		const [a, b] = await Promise.all([createExecution(root, "workspace-a", base), createExecution(root, "workspace-b", base)]);
		expect(a.execution.checkoutId).not.toBe(b.execution.checkoutId);
		expect(await readFile(join(root, "code.txt"), "utf8")).toBe("working change\n");
		expect(await git(root, ["remote", "get-url", "origin"])).toBe("https://example.invalid/repo.git");
		expect(await git(a.directory, ["rev-parse", "HEAD"])).toBe(base);
		expect((await createExecution(root, "workspace-a", base)).directory).toBe(a.directory);
	});
	it("real paths reject duplicate writers and ownership-safe release", async () => {
		const { root } = await repository();
		await reserveCheckout(root, "a");
		await expect(reserveCheckout(root, "b")).rejects.toThrow("already has a writer");
		await expect(releaseCheckout(root, "b")).rejects.toThrow("another workspace");
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
			packed = await pipeGit(root, ["pack-objects", "--revs", "--stdout", "-q"], Buffer.from(`${head}\n`));
		const remote = new GitWorkspace(new MemoryFs() as never);
		await remote.ensureInit();
		await remote.importPack(packed);
		expect((await remote.log(head))[0].oid).toBe(head);
		expect(await remote.mergeBase(base, head)).toBe(base);
	});
	it("cleanup refuses dirty or unpublished work and only removes owned worktrees", async () => {
		const { root, base } = await repository();
		const work = await createExecution(root, "workspace-safe", base);
		await writeFile(join(work.directory, "new.txt"), "preserve");
		await expect(cleanupExecution(work.directory, "workspace-safe", base)).rejects.toThrow("Uncommitted");
		await rm(join(work.directory, "new.txt"));
		await expect(cleanupExecution(work.directory, "wrong", base)).rejects.toThrow("not owned");
		await expect(cleanupExecution(work.directory, "workspace-safe", "b".repeat(40))).rejects.toThrow("Unpublished");
		await cleanupExecution(work.directory, "workspace-safe", base);
		expect(await git(root, ["rev-parse", "HEAD"])).toBe(base);
	});
});
