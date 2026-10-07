# 0005 — Bounded state and authorized cleanup recovery

Status: Accepted 2026-10-06

Amended by [0009](0009-replaceable-observations-and-archived-finished-work.md): presence and reports keep replaceable records instead of per-call receipts, and finished work moves to archive bundles.

## Context

Global Directory enumeration and growing whole-state JSON made costs depend on installation history. Heartbeat receipts and activity accumulated inside every repository read/write; namespace reservations accumulated inside every authority check. SQLite's [row limit](https://developers.cloudflare.com/durable-objects/platform/limits/) is finite. The Git gateway buffers packs and has a separate 32 MiB ceiling. Pending fork deletion depended on a caller remaining connected and repeating the request.

Published source, ownership, decisions, operation identities and provenance must survive interruption. Dropping old receipts can turn an old key into permission for another effect. Deleting old source to reclaim capacity contradicts explicit retention. A general workflow engine or agent scheduler does not belong in Cruce.

## Decision

Keep the existing Directory, Namespace and Repository DO authority split. Directory identity, user, namespace and handle lookup uses indexed keys. Per-user discovery candidates are advisory addresses, capped and rechecked against Namespace membership/grants. Register a candidate before an explicit membership grant, so a lost response cannot hide a successful grant; stale candidates grant no authority. Do not introduce a second membership store.

Move receipts, activity and resource reservations to individually indexed records. Keep only recent activity in the hot repository state; retain all historical events and operation identities. Namespace budget counters preserve atomic UTC-day charging across repositories, retries and restarts. Hash request fingerprints so evidence content does not inflate operation records. Repeated heartbeat/report replies share immutable content-addressed workspace templates and per-receipt timestamps, preserving the exact original response without copying all reported paths. Missing/corrupt templates block replay rather than repeat a mutation. Use atomic SQLite transactions for state, receipts, activity, cleanup phases and counters. Coordination reads create no schema, index, counter or alarm.

Use an enforced pilot capacity envelope, owned by [the limits contract](../../src/shared/limits.ts) and documented in [architecture](../architecture.md#bounded-coordination-state-and-retention-recovery). Bound UTF-8 record bytes, hot-state bytes, logical cardinalities, retained data/record count, discovery candidates, history pages, remote ref inventory and recovery batches. Reserve storage headroom for previously authorized recovery. Larger capacities require new measurements; these limits do not claim unlimited repository scale. Capacity exhaustion retains data and rejects new work before provider resource calls. No automatic receipt, event, reservation, source or workspace deletion is introduced.

Add `get_retention` as a recorded-state read and `inspect_retention` as explicit, budgeted `source.read` work. Inspect stable provider identity and every remote ref within the inventory bound, using retained all-parent source rather than first-parent display history. Record exact unretained refs, completeness, blockers and check time. An incomplete or uncertain inventory blocks deletion; do not silently truncate it into a proof. Inspection never deletes anything and never substitutes for a fresh check in cleanup.

Journal `cleanup_workspace` authorization before provider I/O, then persist `deleting` before requesting deletion and `confirmed` before namespace settlement. Arm a DO alarm before accepting durable intent. Recover at most four due operations per wakeup, under the original operation identity, actor and reservation. Recheck membership, repository access, capability scopes, resource policy and pinned provider identity. Console authorization is a stored authenticated human decision whose current namespace/repository authority still applies. OAuth recovery binds the current grant's encrypted repository approval and intersects current scopes; deleted/expired/changed grants stop recovery. Store no Access JWT or OAuth/provider token in cleanup journals or snapshots. A changed approval requires an authenticated retry from the original actor; the retry renews continuation proof without changing operation identity.

Use exponential delay from 30 seconds to one hour for transient/pending outcomes. Authorization, policy, identity, capacity and retention blockers stop automatic attempts and stay inspectable. A confirmed deletion retries settlement without provider deletion. At-least-once alarms never imply exactly-once provider delivery; repeated DELETE/absence checks validate the same provider ID. No expiry or presence timeout creates an intent, releases a reservation or deletes source. Publication recovery remains R3; promotion keeps its existing exact-base human decision boundary.

The same-domain record layout changes on explicit sign-in/mutation only. Directory conversion preserves stable IDs and conservative discovery candidates atomically; existing whole-record reads remain pure until then. Repository mutations archive existing receipts/activity, and namespace mutations compact reservations/counters. There are no retired-domain aliases, automatic source moves or provider identity adoption. Oversized conversion fails without discarding the existing records.

## Consequences and verification boundary

Hot reads/writes stop growing with the operational history window; retained history stays available in bounded pages. The selected envelope eventually stops new work rather than silently erasing auditability. State/storage counters exclude SQLite page/index overhead and the separate bounded Git cache. Blocked operations may require restoring authority/storage or retrying with renewed connection approval; elapsed time does not unblock them.

The [measurement harness](../../tools/measure-state.ts) and [F6 evidence](../local-verification.md#bounded-state-and-authorized-retention-recovery-f6) distinguish local SQLite/Node measurements from deployed Worker performance. Hosted alarm delivery, KV revocation propagation, provider deletion timing and Worker peak memory still require acceptance. OAuth grant inspection relies on the installed OAuth provider's persisted grant format and KV's propagation; it cannot promise synchronous revocation during an already in-flight provider call.

This complements ADRs 0001–0004 without changing canonical authority, retention or the boundary against agent execution, scheduling and general workflows.
