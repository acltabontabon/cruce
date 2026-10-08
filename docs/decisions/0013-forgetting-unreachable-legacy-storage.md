# 0013 — Forgetting unreachable legacy storage

**Status:** Accepted 2026-10-08

## Context

[ADR 0003](0003-deployment-managed-storage.md) replaced namespace-connected storage accounts with one installation Artifacts binding. Namespaces that still record a connected account fail closed for every resource operation until an explicit storage transition, and no transition exists. [ADR 0010](0010-repository-archive-and-permanent-deletion.md) and [ADR 0012](0012-namespace-permanent-deletion.md) delete a repository only after confirming its recorded provider repositories are absent. For a legacy namespace that confirmation can never happen, so its repositories and the namespace itself can never be deleted, and a deletion started anyway freezes without finishing.

## Decision

A repository or shared namespace whose storage is legacy connected-account storage can be deleted only by **forgetting** that storage. The authenticated console Owner must explicitly confirm that Cruce will not delete the old storage, in addition to the exact repository name or namespace handle. The console states that the old storage keeps its Git until someone removes it in that account.

Forgetting applies only to legacy connected-account storage. Storage that is merely unavailable or whose recorded installation identity changed can be restored, so deletion keeps waiting for it, and a request to forget reachable or restorable storage is refused.

A forgetting deletion follows ADR 0010 except for provider effects: it calls no provider and requires no recorded provider identity. The owner's confirmation stands in for confirmed absence. It still freezes first, uses one `repository.delete` reservation for operation identity and policy (without binding storage), waits for in-flight promotions, unsettled resource operations and observation cleanup, purges coordination records and the Git cache, and leaves the same tombstones. Its deletion receipt keeps the inventory of provider repositories it left behind (current canonical, forks and retained stores, plus identities recorded earlier), so they can be found and removed outside Cruce.

Namespace deletion of a legacy namespace forgets every repository's storage under one confirmation, then retires the namespace as ADR 0012 describes. Unsettled operations still block it: releasing one remains the Owner's separate, explicit decision.

## Consequences

Legacy test and early namespaces can be retired from Cruce. Retained source in the old storage is no longer reachable through Cruce afterwards; keeping or removing it is an administrator decision in that account. This amends the confirmed-absence requirement of ADR 0010 and ADR 0012 for legacy storage only.
