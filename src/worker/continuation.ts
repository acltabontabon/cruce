import { DomainError } from "../core/errors.ts";
import type { ConnectionGrant } from "./namespace-runtime.ts";
import { hash } from "./store.ts";

/** A submitted operation is durable authorization, never a new system principal.
 * OAuth recovery additionally checks the provider's current grant record. Its
 * encrypted props digest binds the repository approval without storing tokens
 * or decrypting credentials. Changed props require a new authenticated retry.
 */
export async function continuationGrant(grant: ConnectionGrant, kv: KVNamespace, now = Date.now()): Promise<ConnectionGrant> {
	const proof = grant.continuation;
	if (proof?.kind === "console" && grant.actor.kind === "human" && !grant.actor.connectionId) return grant;
	if (proof?.kind === "oauth" && grant.actor.kind === "agent") {
		const current = await kv.get<{ scope: string[]; encryptedProps: string; expiresAt?: number }>(proof.key, "json");
		if (
			!current ||
			!Array.isArray(current.scope) ||
			current.scope.some((scope) => typeof scope !== "string") ||
			(current.expiresAt !== undefined && current.expiresAt * 1000 <= now) ||
			typeof current.encryptedProps !== "string" ||
			!current.encryptedProps ||
			(await hash(current.encryptedProps)) !== proof.propsHash
		)
			throw new DomainError(403, "Cleanup recovery authorization unavailable; retry from an authorized connection");
		return { ...grant, scopes: grant.scopes?.filter((scope) => current.scope.includes(scope)) };
	}
	throw new DomainError(403, "Cleanup recovery authorization unavailable; retry from an authorized connection");
}

/** Capture approval from the authenticated token snapshot, then require that the
 * current connection still has that approval. A newer grant must never lend its
 * approval to an older token whose repository approval differs. */
export async function cleanupTokenGrant(grant: ConnectionGrant, token: string | undefined, kv: KVNamespace) {
	const parts = token?.split(":");
	if (parts?.length !== 3) throw new DomainError(403, "Cleanup recovery authorization unavailable; retry from an authorized connection");
	const snapshot = await kv.get<{ grant: { encryptedProps: string } }>(`token:${parts[0]}:${parts[1]}:${await hash(token!)}`, "json");
	if (!snapshot?.grant.encryptedProps)
		throw new DomainError(403, "Cleanup recovery authorization unavailable; retry from an authorized connection");
	return continuationGrant(
		{
			...grant,
			continuation: { kind: "oauth", key: `grant:${parts[0]}:${parts[1]}`, propsHash: await hash(snapshot.grant.encryptedProps) },
		},
		kv,
	);
}
