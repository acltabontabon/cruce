import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./local-git.ts";
import { writeState } from "./state-file.ts";

interface RepositoryConnection {
	server: string;
	namespaceId: string;
	repositoryId: string;
}
async function registryPath(cwd: string, workspaceId: string) {
	if (!/^[a-zA-Z0-9-]{1,160}$/.test(workspaceId)) throw new Error("Valid workspace ID required");
	const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return join(common, "cruce", "connections", `${workspaceId}.json`);
}
export async function registerWorkspaceState(cwd: string, workspaceId: string, stateFile: string) {
	await writeState(await registryPath(cwd, workspaceId), { stateFile });
}
/** Local addressing only. The server still checks current authority and execution ownership. */
export async function findWorkspaceState(cwd: string, workspaceId: string, repository: RepositoryConnection) {
	try {
		const registry = await registryPath(cwd, workspaceId);
		const pointer = (await readFile(registry, "utf8")
			.then(JSON.parse)
			.catch(async (error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				// A managed worktree also carries its authoritative state-file address.
				// This lets an installed bridge continue existing local work before its first registry save.
				const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
				const copy = JSON.parse(await readFile(join(common, "worktrees", workspaceId, "cruce", "connection.json"), "utf8")) as {
					stateFile?: string;
				};
				if (!copy.stateFile)
					throw new Error("Existing local workspace has no authoritative state file; inspect its connection before attaching");
				return { stateFile: copy.stateFile };
			})) as { stateFile: string };
		const state = JSON.parse(await readFile(pointer.stateFile, "utf8")) as RepositoryConnection & { workspaceId?: string };
		if (state.workspaceId !== workspaceId) return undefined;
		if (
			state.server !== repository.server ||
			state.namespaceId !== repository.namespaceId ||
			state.repositoryId !== repository.repositoryId
		)
			throw new Error("Local workspace belongs to another repository connection");
		return pointer.stateFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}
