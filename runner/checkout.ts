import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./local-git.ts";

/** The Cruce repository a checkout names: an address carrying stable IDs, never identity or authority. */
export interface CheckoutAddress {
	server: string;
	namespaceId: string;
	repositoryId: string;
}
const id = /^[a-zA-Z0-9-]{1,160}$/;
const canonicalPath = /^\/mcp\/git\/([a-zA-Z0-9-]{1,160})\/([a-zA-Z0-9-]{1,160})\/canonical\.git$/;

/**
 * Find which Cruce repository this directory works on, without writing anything: first the local connection state an
 * attachment recorded, then a remote naming exactly one repository's canonical Git on the server. The server rechecks
 * the connection's authority on every request, so a remote only selects what to ask for.
 */
export async function resolveCheckout(directory: string, server?: string): Promise<CheckoutAddress | undefined> {
	const origin = server ? new URL(server).origin : undefined;
	const gitDir = await git(directory, ["rev-parse", "--absolute-git-dir"]).catch(() => undefined);
	if (!gitDir) return undefined;
	const recorded = await readFile(join(gitDir, "cruce", "connection.json"), "utf8")
		.then((text) => JSON.parse(text) as Partial<CheckoutAddress>)
		.catch(() => undefined);
	if (
		recorded?.server &&
		id.test(recorded.namespaceId ?? "") &&
		id.test(recorded.repositoryId ?? "") &&
		(!origin || new URL(recorded.server).origin === origin)
	)
		return { server: new URL(recorded.server).origin, namespaceId: recorded.namespaceId!, repositoryId: recorded.repositoryId! };
	if (!origin) return undefined;
	const remotes = await git(directory, ["config", "--get-regexp", "^remote\\..*\\.url$"]).catch(() => "");
	const found = new Map<string, CheckoutAddress>();
	for (const line of remotes.split("\n")) {
		const value = line.slice(line.indexOf(" ") + 1).trim();
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			continue;
		}
		const match = canonicalPath.exec(url.pathname);
		if (url.origin !== origin || url.username || url.password || !match) continue;
		found.set(`${match[1]}/${match[2]}`, { server: origin, namespaceId: match[1], repositoryId: match[2] });
	}
	if (found.size > 1) throw new Error(`Several Cruce repositories are remotes here (${[...found.keys()].join(", ")}); keep one`);
	return found.values().next().value;
}
