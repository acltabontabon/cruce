import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { changedRanges } from "../src/core/line-diff.ts";
import type { ChangedFile } from "../src/core/publish-gate.ts";
import type { WorkspaceAttachment } from "../src/shared/coordination.ts";

const run = promisify(execFile);
export async function git(cwd: string, args: string[]) {
	return (await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
}
async function nulGit(cwd: string, args: string[]) {
	return (await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
}
async function content(cwd: string, ref: string, path: string) {
	return (await run("git", ["show", `${ref}:${path}`], { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
}
export async function pipeGit(cwd: string, args: string[], input: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
			chunks: Buffer[] = [];
		let bytes = 0;
		child.stdout.on("data", (b: Buffer) => {
			bytes += b.length;
			if (bytes > 32 * 1024 * 1024) {
				child.kill();
				reject(new Error("Git transfer exceeds 32 MiB"));
			} else chunks.push(b);
		});
		child.on("error", reject);
		child.stdin.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("Native Git object transfer failed"))));
		child.stderr.resume();
		child.stdin.end(input);
	});
}
export async function workspace(cwd: string): Promise<WorkspaceAttachment> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]),
		head = await git(cwd, ["rev-parse", "HEAD"]),
		branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => "detached");
	const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "origin/HEAD");
	const native = await git(cwd, ["rev-parse", "--verify", "refs/cruce/accepted"]).catch(() => undefined);
	const base = native
		? await git(cwd, ["merge-base", head, native]).catch(() => {
				throw new Error("Checkout does not share native source history; import or check out accepted source first");
			})
		: await git(cwd, ["merge-base", head, upstream]).catch(() => head);
	const checkoutId = createHash("sha256").update(root).digest("hex");
	return {
		id: checkoutId,
		checkoutId,
		branch,
		base,
		head,
		isolation: "isolated",
		precision: "symbols",
		capabilities: ["git_observation", "intent_mcp"],
	};
}
/** Actual base and changed content. Git reads never use the developer's credential configuration. */
export async function observe(cwd: string, base: string, head?: string) {
	if (!/^[a-f0-9]{40}$/.test(base) || (head && !/^[a-f0-9]{40}$/.test(head))) throw new Error("Exact Git object IDs required");
	const at = await workspace(cwd),
		names = await nulGit(cwd, ["diff", "--name-status", "-z", "--no-renames", base, ...(head ? [head] : [])]);
	const parts = names.split("\0"),
		changes: ChangedFile[] = [],
		files: Record<string, string> = {},
		headFiles: Record<string, string> = {};
	const untracked = head ? [] : (await nulGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
	const entries: { path: string; status: string }[] = [];
	for (let i = 0; i < parts.length - 1; i += 2) entries.push({ status: parts[i], path: parts[i + 1] });
	entries.push(...untracked.map((path) => ({ path, status: "A" })));
	for (const { path, status } of entries) {
		if (path.startsWith("/") || path.split("/").some((p) => p === "..")) throw new Error("Unsafe Git path");
		const before = status === "A" ? "" : await content(cwd, base, path);
		const localPath = resolve(cwd, path);
		const after =
			status === "D"
				? ""
				: head
					? await content(cwd, head, path)
					: (await lstat(localPath)).isSymbolicLink()
						? await readlink(localPath)
						: await readFile(localPath, "utf8");
		if (Buffer.byteLength(before) > 100000 || Buffer.byteLength(after) > 100000)
			throw new Error(`File too large for focused observation: ${path}`);
		if (before.includes("\0") || after.includes("\0")) throw new Error(`Binary file needs provider verification: ${path}`);
		if (status !== "A") files[path] = before;
		if (status !== "D") headFiles[path] = after;
		changes.push({
			path,
			status: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
			ranges: changedRanges(before, after),
		});
	}
	// Working content must not associate an uncommitted plan with an existing provider commit.
	const dirty = !head && !!(await nulGit(cwd, ["status", "--porcelain", "-z"]));
	return {
		kind: dirty ? ("working_tree" as const) : ("commit" as const),
		base,
		head: head ?? at.head,
		branch: at.branch,
		files,
		headFiles,
		changes,
	};
}

/**
 * Package committed work (base..HEAD) as a non-thin Git pack. Only commits travel: uncommitted
 * changes stay in the working tree, and the revision Cruce records is exactly the local commit.
 */
export async function packRevision(cwd: string, base: string, head?: string) {
	if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Exact workspace base revision required");
	const revision = head ?? (await git(cwd, ["rev-parse", "HEAD"]));
	if (revision === base) throw new Error("No new commits since the workspace head; commit your work first");
	await git(cwd, ["merge-base", "--is-ancestor", base, revision]).catch(() => {
		throw new Error(`HEAD does not descend from workspace head ${base}; merge or rebase locally first, preserving your work`);
	});
	const commits = Number(await git(cwd, ["rev-list", "--count", `${base}..${revision}`]));
	const pack = await pipeGit(cwd, ["pack-objects", "--revs", "--stdout", "-q"], Buffer.from(`${revision}\n^${base}\n`));
	if (pack.length > 4 * 1024 * 1024) throw new Error("Revision pack exceeds 4 MiB; publish smaller changes or large artifacts separately");
	return { base, revision, commits, pack: pack.toString("base64") };
}
