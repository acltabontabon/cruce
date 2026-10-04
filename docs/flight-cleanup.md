# Flight resource cleanup

Cruce owns the resources created for each Flight. One Artifacts repository per Flight remains the
isolation boundary; completed execution resources are temporary, while accepted work and coordination
history remain available.

## Retention and recovery

- Landing immediately schedules repository deletion. Before deletion, Cruce fetches canonical and
  verifies that the landing commit and published head are reachable and the canonical landing note
  belongs to the Flight. A verification failure preserves the repository and retries cleanup without
  changing the successful Flight's phase.
- Failed, cancelled, and lost Flights retain published work for 24 hours from their first terminal
  transition. **Keep for recovery** pauses repository expiry; **Restore automatic expiry** restores the
  original deadline. Overdue work becomes immediately eligible. Retention cannot be changed once
  deletion starts or after work expires.
- Tokens and execution resources are released immediately, including for kept repositories. Unpublished
  sandbox files are not a recovery archive. Terminal agents cannot checkout, refresh, heartbeat, publish,
  or start another sandbox task. A token minted concurrently with termination is revoked before it can
  be returned. External runner processes stop cooperatively; Cruce blocks further protocol work.
- Queued or provisioning launches that never start fail after 30 minutes, just as discovery without a
  plan expires. Both routes enter the same cleanup lifecycle.

## Durable ownership and retries

The project's Durable Object stores a separate `flightResources` ledger before invoking a fork or
Workflow creation. Records contain the namespace, exact repository name, repository ID when known,
project and Flight IDs, reset epoch, execution-resource identifiers, expiry, and independent progress
for tokens, Workflow, sandbox, repository, subscriptions, and local resources. No credentials are stored
in this ledger.

Records survive restarts and demo resets. An interrupted fork can be adopted only when its exact name,
description, and canonical fork source establish ownership; a recorded repository ID must match before
revoking tokens or deleting a repo. Canonical is always protected. A persisted ten-minute provisioning
lease prevents deletion while a fork or subscription call is still completing; late results update the
ledger without reviving a terminal Flight.

The existing Durable Object alarm schedules at most ten cleanup jobs per run, even without active
Flights and while a demo is paused. Failed steps retry after one minute, then five minutes, then hourly.
Successful steps are checkpointed separately. After three failures, one attention item explains that
cleanup needs intervention; it resolves when the failing steps recover. Logs identify resources and
steps without copying platform error messages or credentials.

Deletion is complete only after the repository is absent. Subscription removal is paginated and removes
all matches; failures continue retrying. Expired local Flight and staging refs, token/remote caches, and
the in-memory Git cache are cleared. Old reset jobs cannot clear a newer Flight's refs.

A daily reconciliation scans one namespace page per alarm, persisting the cursor between pages. It
repairs recorded repository leaks. Legacy candidates without provable ownership are reported for review
and left untouched. This feature does not automatically delete unknown historical infrastructure.

## Interfaces and migration

Flight snapshots and updates include `finishedAt` and `cleanup` (`status`, `expiresAt`, `keep`, and
`deletedAt`). Flight details display cleanup progress and recovery controls. The existing authenticated
command endpoint accepts `{ type: "retain", flightId, keep }` for unsuccessful terminal Flights.

Landed history and diffs use preserved commit identifiers after the isolated repository and local
Flight refs are gone. Expired unsuccessful history and changes return HTTP 410 with **Work expired**.
Agent status remains available, but terminal status no longer advertises a checkout remote.

On first load, legacy terminal snapshots receive cleanup metadata. Landed Flights use their existing
landing time and require canonical verification. Unsuccessful Flights with unknown termination times
receive a fresh 24-hour recovery window. Owned records without a remaining Flight are treated as lost
and receive the same window.

Cleanup does not prune unreachable objects in the durable Git database or erase audit history. Git
object reclamation is a separate storage-maintenance concern and must preserve canonical history.
