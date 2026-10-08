/** Standard Git credential helper. Stores no Artifacts credentials or secrets in Git config. */
import { readFile } from "node:fs/promises";
import { DEFAULT_AGENT_SCOPES } from "../src/core/capabilities.ts";
import { Credentials, login } from "./oauth.ts";

const args = process.argv.slice(2);
const option = (key: string) => args[args.indexOf(`--${key}`) + 1];
const server = args.includes("--server") ? option("server") : undefined;
const client = args.includes("--client") ? option("client") : "git";
/** The command that re-authorizes the connection this helper reads; the bridge's connection for workspace forks. */
let recovery = "cruce auth --server URL --namespace ID --repository ID";
async function main() {
	if (!server || !client || !/^[a-zA-Z0-9-]+$/.test(client)) throw new Error("Choose --server URL and --client NAME");
	const origin = new URL(server);
	if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") throw new Error("Use HTTPS");
	if (args.includes("login")) {
		if (!args.includes("--namespace") || !args.includes("--repository")) throw new Error("Choose namespace and repository IDs");
		const target = { namespaceId: option("namespace"), repositoryId: option("repository") };
		const credentials = new Credentials(origin.origin, client, target);
		await credentials.load();
		await login(origin.origin, credentials, DEFAULT_AGENT_SCOPES, target);
		return;
	}
	const operation = args.at(-1);
	if (operation !== "get") return;
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (input.length > 8192) throw new Error("Invalid credential request");
	}
	const fields = Object.fromEntries(
		input
			.trim()
			.split("\n")
			.map((line) => {
				const i = line.indexOf("=");
				return [line.slice(0, i), line.slice(i + 1)];
			}),
	);
	if (fields.protocol !== origin.protocol.slice(0, -1) || fields.host !== origin.host || !fields.path?.startsWith("mcp/git/")) return;
	if (args.includes("--human-file")) {
		const connection = JSON.parse(await readFile(option("human-file"), "utf8")) as {
			server: string;
			humanToken?: string;
			namespaceId: string;
			repositoryId: string;
			workspaceId?: string;
		};
		const base = `mcp/git/${connection.namespaceId}/${connection.repositoryId}/`;
		if (
			new URL(connection.server).origin !== origin.origin ||
			!connection.humanToken ||
			/[\r\n]/.test(connection.humanToken) ||
			!fields.path.startsWith(base)
		)
			return;
		process.stdout.write(`username=cruce\npassword=${connection.humanToken}\n\n`);
		return;
	}
	const match = /^mcp\/git\/([a-zA-Z0-9-]{1,160})\/([a-zA-Z0-9-]{1,160})\/[^/]+\.git$/.exec(fields.path);
	if (!match) return;
	const target = `--server ${origin.origin} --namespace ${match[1]} --repository ${match[2]}`;
	recovery = client === "git" ? `cruce auth ${target}` : `cruce connect ${target} --client ${client}`;
	const credentials = new Credentials(origin.origin, client, { namespaceId: match[1], repositoryId: match[2] });
	// Concurrent pushes share one rotating refresh token; reuse current tokens and refresh under the shared lock.
	if (!(await credentials.refresh())) throw new Error("Git connection needs sign-in");
	const token = credentials.data.tokens?.access_token;
	if (!token || /[\r\n]/.test(token)) throw new Error("Git connection needs sign-in");
	process.stdout.write(`username=cruce\npassword=${token}\n\n`);
}
main().catch((error) => {
	const cause = error instanceof Error ? ` (${error.message.replace(/\s+/g, " ").slice(0, 200)})` : "";
	process.stderr.write(`Cruce Git authentication failed${cause}. Run ${recovery} to authorize Git.\n`);
	process.exitCode = 1;
});
