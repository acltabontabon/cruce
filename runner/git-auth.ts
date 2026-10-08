import { credentialHelper, serverOrigin } from "./git-remotes.ts";
import { git } from "./local-git.ts";

/**
 * Configure Git once per machine for this Cruce server only. Git matches a configured URL path exactly, so the entry
 * names the server; the helper answers only Cruce Git paths there, and other Git destinations stay untouched.
 */
export async function configureServerCredentials(server: string, configFile?: string) {
	const origin = serverOrigin(server);
	const config = ["config", ...(configFile ? ["--file", configFile] : ["--global"])];
	await git(process.cwd(), [...config, `credential.${origin}.useHttpPath`, "true"]);
	// Clear inherited helpers only for this server, then install the private OAuth helper.
	await git(process.cwd(), [...config, "--replace-all", `credential.${origin}.helper`, ""]);
	await git(process.cwd(), [...config, "--add", `credential.${origin}.helper`, credentialHelper(origin, "git")]);
	return origin;
}
