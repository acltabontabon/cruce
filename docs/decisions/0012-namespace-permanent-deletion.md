# 0012 — Namespace permanent deletion

**Status:** Accepted 2026-10-08

## Context

[ADR 0010](0010-repository-archive-and-permanent-deletion.md) lets a namespace Owner permanently delete one repository at a time. A shared namespace created for a team, a client or a temporary effort eventually needs to go away with everything in it. Deleting each repository by hand leaves an empty namespace that still holds members, teams, invitations, policy and a reserved handle, and there is no way to remove it.

## Decision

Add one authenticated console decision, **Delete namespace**, for shared namespaces only. A personal namespace belongs to its account; its owner deletes its repositories instead. Only the current human namespace Owner, without an agent or paired-terminal connection, can delete a namespace, and the confirmation is the exact namespace handle. Agent/MCP discovery does not offer it.

Namespace deletion is the owner's decision to permanently delete every repository in the namespace, archived ones included, and then the namespace. Each repository is deleted by its own ADR 0010 deletion, under the same owner authority, ordering, reservation, identity checks and recovery; namespace deletion adds no second provider-deletion path. Unfinished work ends with its repository exactly as it does there, and the confirmation states how many repositories, archived repositories, workspaces (and attached ones) and open changes it ends.

Authorization waits for whatever any one repository's deletion would wait for: in-flight promotions, unsettled resource operations, push-observation cleanup, an archive or restore awaiting retry, a repository that cannot be read, and a namespace or repository policy that denies repository deletion. Each blocker names its repository. A repository whose deletion its owner already started is resumed under that operation, not blocked.

Deletion is a durable, irreversible intent in the Namespace object. Recording it freezes the namespace at once: only the console Owner still reaches it, so members, agents and terminals are refused every request; no repository, membership, team, invitation, rename or resource reservation other than `repository.delete` is accepted; and repository mutations stop except the deletion itself, the retry of an unfinished archive/restore transition and the recovery of a promotion already under way. Namespace resource policy stays editable by the Owner, because a policy changed after authorization blocks recovery and must remain correctable.

Each attempt starts or resumes at most four repository deletions, taking turns across repositories; each repository deletion also continues on its own alarm. The namespace alarm retries submitted intent every 30 seconds while repositories remain. A repository deletion that blocks (changed authority, policy or provider identity) blocks the namespace deletion with that repository's reason; the Owner resolves it and retries with the original operation identity. When no live repository remains, the directory retires the namespace: its handle becomes reusable, its members stop discovering it and a small ID tombstone prevents a creation key from resurrecting it. The Namespace object then keeps a tombstone with the deletion receipt, the resource reservation ledger and the repository tombstones, and removes members, teams and invitations. Later requests report that the namespace has been deleted.

Like ADR 0010, deletion removes no local checkout, external upstream repository, local writer lock or running agent; their next Cruce or Git request fails because the namespace is gone. Elapsed time, capacity and cleanup still confer no deletion authority.

## Consequences

Namespace Settings explains permanence, lists blockers by repository, requires typing the handle, shows deletion progress and the current reason, and offers the original retry. A completed deletion leaves the namespace list and returns to Home. Local tests and fixtures establish implementation behavior; hosted deletion through the configured Artifacts binding requires separate acceptance evidence.
