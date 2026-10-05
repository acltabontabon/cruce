import { fileURLToPath } from "node:url";
import { git } from "./local-git.ts";

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export function credentialHelper(server: string, client: string) {
	return `!${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("./git-credential.mjs", import.meta.url)))} --server ${shellQuote(server)} --client ${shellQuote(client)}`;
}
/** Unique remote and branch configuration never rewrites another checkout's origin. */
export async function configureFork(cwd: string, workspaceId: string, server: string, client: string, path: string) {
	if (!/^[a-zA-Z0-9-]+$/.test(workspaceId)) throw new Error("Invalid workspace identity");
	const url = new URL(path, server);
	if (url.origin !== new URL(server).origin || !url.pathname.startsWith("/mcp/git/") || url.username || url.password)
		throw new Error("Invalid Git remote");
	const remote = `cruce-${workspaceId}`;
	const branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
	if (branch !== `cruce/workspace-${workspaceId}`) throw new Error("Configure remotes only on this workspace's dedicated branch");
	await git(cwd, ["config", `remote.${remote}.url`, url.href]);
	await git(cwd, ["config", `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`]);
	await git(cwd, ["config", `branch.${branch}.remote`, remote]);
	await git(cwd, ["config", `branch.${branch}.pushRemote`, remote]);
	await git(cwd, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
	await git(cwd, ["config", `credential.${url.href}.useHttpPath`, "true"]);
	await git(cwd, ["config", `credential.${url.href}.helper`, credentialHelper(server, client)]);
	return { remote, url: url.href };
}
