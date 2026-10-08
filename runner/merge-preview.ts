import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const exact = /^[0-9a-f]{40}$/;
const env = {
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_OPTIONAL_LOCKS: "0",
};
async function native(cwd: string, args: string[]) {
	try {
		const result = await run("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
			cwd,
			env,
			timeout: 30000,
			maxBuffer: 8 * 1024 * 1024,
		});
		return { code: 0, output: result.stdout };
	} catch (error) {
		const result = error as { code?: number | string; stdout?: string; killed?: boolean };
		return { code: result.killed ? -1 : result.code, output: result.stdout ?? "" };
	}
}

/** Explicit local computation against durable canonical identity; never fetches, changes refs or applies a merge. */
export async function previewReconciliation(directory: string, canonicalRevision?: string) {
	const head = await native(directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
	const workspaceRevision = head.output.trim();
	const revisions = { workspaceRevision, canonicalRevision, canonicalTrust: "accepted" as const };
	const unavailable = (reason: string) => ({ ...revisions, status: "unavailable" as const, reason });
	if (head.code !== 0 || !exact.test(workspaceRevision)) return unavailable("Committed workspace HEAD is unavailable.");
	if (!canonicalRevision || !exact.test(canonicalRevision)) return unavailable("Accepted canonical revision is unavailable.");
	if ((await native(directory, ["cat-file", "-e", `${canonicalRevision}^{commit}`])).code !== 0)
		return unavailable("Canonical source is unavailable locally. Fetch canonical with normal Git, then retry this preview.");
	const objects = await native(directory, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
	const objectPath = objects.output.trim();
	if (objects.code !== 0 || !objectPath || /[\r\n]/.test(objectPath))
		return unavailable("Local Git object storage is unavailable for preview.");
	const working = await native(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
	if (working.code !== 0) return unavailable("Working change state is unavailable.");
	const scratch = await mkdtemp(join(tmpdir(), "cruce-merge-preview-"));
	try {
		if ((await native(scratch, ["init", "--bare", "--quiet", "--template="])).code !== 0)
			return unavailable("Isolated Git preview could not be initialized.");
		// Borrow immutable source objects; every generated tree/blob lives only in the disposable repository.
		await writeFile(join(scratch, "objects", "info", "alternates"), `${JSON.stringify(objectPath)}\n`);
		const common = await native(scratch, ["merge-base", workspaceRevision, canonicalRevision]);
		const basis = { ...revisions, workingChangesExcluded: working.output.length > 0, mergeConfiguration: "isolated_git_defaults" as const };
		if (common.code === 1)
			return { ...basis, status: "unrelated" as const, instruction: "Inspect the unrelated histories before reconciling." };
		if (common.code !== 0) return unavailable("Merge ancestry is unavailable locally.");
		const merge = await native(scratch, [
			"merge-tree",
			"--write-tree",
			"--name-only",
			"-z",
			"--messages",
			workspaceRevision,
			canonicalRevision,
		]);
		if (merge.code !== 0 && merge.code !== 1) return unavailable("Git merge preview could not complete within its local limits.");
		const fields = merge.output.split("\0");
		if (!exact.test(fields[0])) return unavailable("Git merge preview output is unavailable or unsupported.");
		let cursor = 1;
		const conflictingPaths: string[] = [];
		while (cursor < fields.length && fields[cursor]) conflictingPaths.push(fields[cursor++]);
		cursor++;
		const conflicts: { paths: string[]; type: string }[] = [];
		while (cursor < fields.length && fields[cursor]) {
			const count = Number(fields[cursor++]);
			if (!Number.isSafeInteger(count) || count < 0 || cursor + count + 2 > fields.length)
				return unavailable("Git conflict details are unavailable or unsupported.");
			const paths = fields.slice(cursor, cursor + count);
			cursor += count;
			const type = fields[cursor++];
			cursor++; // Human-readable messages are not parsed or executed.
			if (type.startsWith("CONFLICT")) conflicts.push({ paths, type });
		}
		return {
			...basis,
			status: merge.code === 0 ? ("clean" as const) : ("conflicts" as const),
			conflictingPaths,
			conflicts,
			instruction:
				merge.code === 0
					? "Git found no merge conflicts for these exact commits. Apply the merge explicitly in the workspace, verify, push and publish for fresh review. Custom merge drivers and repository merge configuration are not used. This preview does not establish correctness or approval."
					: "Resolve these Git conflicts in the authorized workspace, verify, push and publish the new revision for fresh review. Working changes were not included in this preview.",
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
