import { fileURLToPath } from "node:url";
import { git } from "./local-git.ts";

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export function credentialHelper(server: string, client: string, humanFile?: string) {
	return `!${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("./git-credential.mjs", import.meta.url)))} --server ${shellQuote(server)} --client ${shellQuote(client)}${humanFile ? ` --human-file ${shellQuote(humanFile)}` : ""}`;
}
/** Unique remote and branch configuration never rewrites another checkout's origin. */
export async function configureFork(cwd: string, workspaceId: string, server: string, client: string, path: string, humanFile?: string) {
	if (!/^[a-zA-Z0-9-]+$/.test(workspaceId)) throw new Error("Invalid workspace identity");
	const url = new URL(path, server);
	if (url.origin !== new URL(server).origin || !url.pathname.startsWith("/mcp/git/") || url.username || url.password)
		throw new Error("Invalid Git remote");
	const remote = `cruce-${workspaceId}`;
	const branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
	if (!humanFile && branch !== `cruce/workspace-${workspaceId}`)
		throw new Error("Configure remotes only on this workspace's dedicated branch");
	const previous = await git(cwd, ["remote", "get-url", remote]).catch(() => undefined);
	if (previous && previous !== url.href) throw new Error("The workspace remote name is already in use; existing remotes are preserved");
	await git(cwd, ["config", `remote.${remote}.url`, url.href]);
	await git(cwd, ["config", `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`]);
	if (!humanFile) {
		await git(cwd, ["config", `branch.${branch}.remote`, remote]);
		await git(cwd, ["config", `branch.${branch}.pushRemote`, remote]);
		await git(cwd, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
	}
	await git(cwd, ["config", `credential.${url.href}.useHttpPath`, "true"]);
	await git(cwd, ["config", `credential.${url.href}.helper`, credentialHelper(server, client, humanFile)]);
	return { remote, url: url.href };
}
/** Continue a workspace from its pushed fork head. Only pushed revisions travel; divergence is left to Git. */
export async function continueFromFork(cwd: string, remote: string, workspaceId: string) {
	const branch = `cruce/workspace-${workspaceId}`;
	await git(cwd, ["fetch", remote]);
	const pushed = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}^{commit}`]).catch(() => undefined);
	if (!pushed) return undefined;
	try {
		await git(cwd, ["merge", "--ff-only", pushed]);
	} catch {
		throw new Error(`Local history does not fast-forward to the pushed workspace head ${pushed}; reconcile with Git in ${cwd}`);
	}
	return pushed;
}
