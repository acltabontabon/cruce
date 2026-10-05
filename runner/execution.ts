import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExecutionContext, WorkspaceChange } from "../src/shared/platform.ts";
import { git, pipeGit } from "./local-git.ts";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function context(cwd: string, workspaceId: string, owned: boolean): Promise<ExecutionContext> {
	const root = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
	const branch = await git(root, ["symbolic-ref", "--short", "HEAD"]).catch(() => undefined);
	return {
		id: workspaceId,
		checkoutId: digest(root),
		machineId: digest(`${hostname()}:${process.getuid?.() ?? "user"}`),
		kind: owned ? "worktree" : "checkout",
		owned,
		branch,
	};
}
export async function stateDirectory(cwd: string) {
	const dir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
	const location = join(dir, "cruce");
	await mkdir(location, { recursive: true });
	return location;
}
export async function reserveCheckout(cwd: string, workspaceId: string) {
	const directory = await stateDirectory(cwd),
		path = join(directory, "writer.json");
	try {
		const file = await open(path, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify({ workspaceId, root: await realpath(cwd) }));
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const lock = JSON.parse(await readFile(path, "utf8")) as { workspaceId: string };
		if (lock.workspaceId !== workspaceId)
			throw new Error("This checkout already has a writer. End that workspace; elapsed time does not release its local lock.");
	}
}
export async function releaseCheckout(cwd: string, workspaceId: string) {
	const path = join(await stateDirectory(cwd), "writer.json");
	const lock = (await readFile(path, "utf8")
		.then(JSON.parse)
		.catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
			return undefined;
		})) as { workspaceId: string } | undefined;
	if (lock && lock.workspaceId !== workspaceId) throw new Error("Cannot release another workspace's writer lock");
	if (lock) await rm(path);
}
async function worktreeMutation<T>(common: string, operation: () => Promise<T>): Promise<T> {
	const directory = join(common, "cruce");
	await mkdir(directory, { recursive: true });
	const lockPath = join(directory, "worktree-mutation.lock");
	// Git enumerates this registry while creating entries. Serialize across bridge processes.
	// This short-lived management lock is separate from persistent workspace writer ownership.
	for (let attempt = 0; attempt < 200; attempt++) {
		let lock: Awaited<ReturnType<typeof open>>;
		try {
			lock = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await setTimeout(50);
			continue;
		}
		try {
			await lock.writeFile(JSON.stringify({ pid: process.pid }));
			return await operation();
		} finally {
			await lock.close();
			await rm(lockPath);
		}
	}
	throw new Error(
		"Another process is changing the Git worktree registry. Retry after it finishes; inspect a leftover worktree-mutation.lock only after that process exits.",
	);
}
export async function createExecution(cwd: string, workspaceId: string, base: string) {
	if (!/^[a-zA-Z0-9-]{1,160}$/.test(workspaceId) || !/^[a-f0-9]{40}$/.test(base))
		throw new Error("Valid workspace and exact base required");
	const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		target = join(common, "cruce", "worktrees", workspaceId),
		branch = `cruce/workspace-${workspaceId}`;
	await mkdir(join(common, "cruce", "worktrees"), { recursive: true });
	const existing = (await readFile(join(common, "worktrees", workspaceId, "cruce", "ownership.json"), "utf8")
		.then(JSON.parse)
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		})) as { workspaceId: string; root: string } | undefined;
	if (existing) {
		if (
			existing.workspaceId !== workspaceId ||
			existing.root !== (await realpath(target)) ||
			(await realpath(await git(target, ["rev-parse", "--show-toplevel"]))) !== existing.root
		)
			throw new Error("Execution ownership mismatch");
		await reserveCheckout(target, workspaceId);
		return { directory: target, execution: await context(target, workspaceId, true) };
	}
	await worktreeMutation(common, () => git(cwd, ["worktree", "add", "-b", branch, target, base]));
	await reserveCheckout(target, workspaceId);
	const execution = await context(target, workspaceId, true);
	await writeFile(join(await stateDirectory(target), "ownership.json"), JSON.stringify({ workspaceId, root: await realpath(target) }), {
		mode: 0o600,
	});
	return { directory: target, execution };
}
export async function cleanupExecution(cwd: string, workspaceId: string, publishedRevision: string) {
	const owner = JSON.parse(await readFile(join(await stateDirectory(cwd), "ownership.json"), "utf8")) as {
		workspaceId: string;
		root: string;
	};
	if (owner.workspaceId !== workspaceId || owner.root !== (await realpath(cwd)))
		throw new Error("Execution context is not owned by this workspace");
	if (await git(cwd, ["status", "--porcelain"])) throw new Error("Uncommitted work retained; cleanup refused");
	if ((await git(cwd, ["rev-parse", "HEAD"])) !== publishedRevision) throw new Error("Unpublished commits retained; cleanup refused");
	await releaseCheckout(cwd, workspaceId);
	const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	await worktreeMutation(common, () => git(common, ["worktree", "remove", cwd]));
}
export async function observeChanges(cwd: string, base: string) {
	if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Exact base required");
	const raw = (await pipeGit(cwd, ["diff", "--name-status", "-z", "--find-renames", base], Buffer.alloc(0))).toString().split("\0");
	const changes: WorkspaceChange[] = [];
	for (let i = 0; i < raw.length - 1; ) {
		const status = raw[i++],
			first = raw[i++];
		if (status.startsWith("R")) changes.push({ path: raw[i++], previousPath: first, status: "renamed" });
		else changes.push({ path: first, status: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
	}
	const untracked = (await pipeGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], Buffer.alloc(0)))
		.toString()
		.split("\0")
		.filter(Boolean);
	for (const path of untracked) changes.push({ path, status: "added" });
	const stats = (await pipeGit(cwd, ["diff", "--numstat", "--no-renames", "-z", base], Buffer.alloc(0))).toString().split("\0");
	const binary = new Set(stats.filter((s) => s.startsWith("-\t-\t")).map((s) => s.slice(4)));
	for (const change of changes) if (binary.has(change.path)) change.binary = true;
	return {
		changes,
		revision: await git(cwd, ["rev-parse", "HEAD"]),
		branch: await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => undefined),
		commits: (await git(cwd, ["rev-list", `${base}..HEAD`])).split("\n").filter(Boolean),
	};
}
