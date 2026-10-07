import { credentialHelper } from "./git-remotes.ts";
import { git } from "./local-git.ts";

/** Configure only the explicitly selected canonical URL; other Git destinations stay untouched. */
export async function configureCanonicalCredentials(server: string, namespaceId: string, repositoryId: string, configFile?: string) {
	const origin = new URL(server);
	if (origin.username || origin.password || (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)))
		throw new Error("Use an HTTPS server URL without credentials");
	if (![namespaceId, repositoryId].every((id) => /^[a-zA-Z0-9-]+$/.test(id))) throw new Error("Choose namespace and repository IDs");
	const url = `${origin.origin}/mcp/git/${namespaceId}/${repositoryId}/canonical.git`;
	const config = ["config", ...(configFile ? ["--file", configFile] : ["--global"])];
	await git(process.cwd(), [...config, `credential.${url}.useHttpPath`, "true"]);
	// Clear inherited helpers only for this URL, then install the private OAuth helper.
	await git(process.cwd(), [...config, "--replace-all", `credential.${url}.helper`, ""]);
	await git(process.cwd(), [...config, "--add", `credential.${url}.helper`, credentialHelper(origin.origin, "git")]);
	return url;
}
