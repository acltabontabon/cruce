import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { DomainError } from "../core/errors.ts";
import type { AgentConnection } from "../shared/platform.ts";

/** Recorded in plain grant metadata at approval, so the console can list connections without their encrypted props. */
export interface ConnectionMetadata {
	connectionId: string;
	clientName: string;
	repositories: "all" | { id: string; label: string }[];
}
const MAX_CONNECTIONS = 500;
const metadataOf = (value: unknown): Partial<ConnectionMetadata> => (value && typeof value === "object" ? value : {});

/** Lists the signed-in person's own grants; the provider keys grants by user, so no other person's connection can appear. */
export async function listConnections(oauth: OAuthHelpers, userId: string): Promise<AgentConnection[]> {
	const grants: Awaited<ReturnType<OAuthHelpers["listUserGrants"]>>["items"] = [];
	let cursor: string | undefined;
	do {
		const page = await oauth.listUserGrants(userId, { limit: 100, cursor });
		grants.push(...page.items);
		cursor = page.cursor;
	} while (cursor && grants.length < MAX_CONNECTIONS);
	const clients = new Map<string, Promise<string>>();
	const clientName = (clientId: string) => {
		if (!clients.has(clientId))
			clients.set(
				clientId,
				oauth.lookupClient(clientId).then(
					(client) => client?.clientName ?? "Agent",
					() => "Agent",
				),
			);
		return clients.get(clientId) as Promise<string>;
	};
	const connections = await Promise.all(
		grants.slice(0, MAX_CONNECTIONS).map(async (grant): Promise<AgentConnection> => {
			const metadata = metadataOf(grant.metadata);
			return {
				id: grant.id,
				client: metadata.clientName ?? (await clientName(grant.clientId)),
				connectionId: metadata.connectionId,
				repositories: metadata.repositories === "all" || Array.isArray(metadata.repositories) ? metadata.repositories : undefined,
				scopes: grant.scope,
				createdAt: grant.createdAt * 1000,
				expiresAt: grant.expiresAt ? grant.expiresAt * 1000 : undefined,
			};
		}),
	);
	return connections.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Revokes one of the signed-in person's grants and its tokens. Revocation is keyed by the owner, so another person's grant
 * ID matches nothing; repeating it is harmless. Requests already in flight may complete before KV propagation reaches them.
 */
export async function revokeConnection(oauth: OAuthHelpers, userId: string, grantId: string) {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) throw new DomainError(400, "Connection required");
	await oauth.revokeGrant(grantId, userId);
}
