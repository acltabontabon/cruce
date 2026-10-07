# 0007 — Observed refs and repository reconciliation

Status: Accepted, 2026-10-07

## Decision

Observe Artifacts through repository push subscriptions, an installation Queue and a dead-letter Queue. Subscription management uses the explicitly configured `CF_EVENTS_API_TOKEN` with Queues Write authority in the installation account. It never supplies Git credentials or replaces the Artifacts binding. The installation pays infrastructure costs; namespace `observation.read` policy and atomic reservations authorize the work.

A console human repository maintainer explicitly enables observation. This records a standing observation authorization, independent of browser session presence. Current membership and repository Maintain authority are rechecked before provider work and retries; namespace and repository policy may deny further work. Disabling immediately stops accepting signals and records the disabling maintainer's authority for subscription removal, preserving the original enabling record. An enabling maintainer who loses authority cannot continue background work; another current maintainer can disable and resolve outstanding management operations before re-enablement. There is no agent-facing observation configuration command.

The Queue handler is the only ingestion boundary. It validates the configured queue, account, physical namespace, schema and a durable subscription-to-repository mapping, then invokes the Repository DO privately. Stored target identity includes provider repository ID, fork parent, ref and configuration generation. Remote URLs and names only locate candidates. Publication and promotion paths remain authoritative for retention and acceptance.

Events invalidate a target. They do not assign heads. Under the Repository runtime's serialization boundary, a bounded provider ref inspection determines the current value. Event timestamps, before/after claims and truncated commit lists prove neither ordering nor ancestry. Queue message IDs deduplicate transport retries; coalescing and current-ref inspection make duplicate provider emissions harmless even when Queue IDs differ. A previously unknown event can arrive before its subscription route is registered; delivery retries while registration recovers.

Subscription creation is journalled by an installation-controlled name derived from stable repository/provider identity and configuration generation. A retry locates and validates a matching subscription before creating another. Missing subscriptions are recreated under the same configuration; mismatched or externally disabled subscriptions fail closed. Ref checks and subscription recovery share one reservation per target operation. Confirmation is durable before settlement; lost settlement does not repeat confirmed provider reads. Withdrawn observation resolves uncertain subscription creation through explicit removal, preserving and settling the original charged reservation only after removal is confirmed.

## Bounds and honesty

- Four targets per alarm invocation, a persisted cursor and next-attempt time per target, bounded exponential retry (30 seconds to 15 minutes), and 15-minute successful-check intervals. Alarms also retain existing cleanup recovery. This is a recovery target, not a latency guarantee during provider failure, revocation, exhausted budget or maximum-size batch traversal.
- Each target consumes approximately 96 idle check reservations/day, plus event-triggered checks and setup/removal. A repository with two forks needs approximately 288/day before pushes. The existing default namespace allowance remains 100; enablement discloses the estimate and never increases it.
- Ref inventories are limited to 256 entries, advertised Git data to the existing transport bound, and subscription lookup to 20 pages of 100. Incomplete results never establish deletion or health.
- Queue receipts, observations and reservation journals count against the existing coordination capacity. They are not silently pruned; capacity exhaustion blocks new observation work. Ref inventories and confirmed observations are separate from accepted history. Confirmed rewinds and deletions remain explicit, and prior observation records survive.
- Backfill recovers present ref state and available ancestry through bounded Git staging (32 MiB transfer, 20,000 source objects and 64 MiB expanded source). The fetched ref must still match the exact inspected revision; missing, moved or oversized source leaves backfill degraded and comparisons unknown. It never invents a historical sequence of missed pushes. Read-only views label disabled, pending, healthy or degraded observation and preserve the last check time.

## Reconciliation and authority

`get_reconciliation` and repository snapshots expose the same cache-only projection: published revision (or labelled baseline before publication), complete Git ancestry relation, accepted-revision incorporation, proposal blockers and report freshness. Git traversal verifies commit checksums, follows every parent and shares a 20,000-visit/64 MiB budget per request. Missing/corrupt objects or exhausted traversal produce unknown, never a negative ancestry assertion. Read paths never fetch, initialize schema, reserve resources or persist derived results. Explicit source recovery restores unavailable ancestry.

Per workspace, incorporation counts cover all completed promotions; at most sixteen exact examples are returned, prioritizing missing and unknown revisions, with an explicit truncation flag. Immutable promotion history remains available through existing provenance APIs. No acknowledgements establish incorporation.

`sourceHead` remains the accepted revision established by setup or completed authenticated promotion. Observed canonical divergence/deletion blocks new promotions without accepting the new revision. Recovery of a previously attempted promotion still follows its exact existing journal; an event cannot complete it. A successfully verified human promotion updates its confirmed observation so an earlier check cannot leave a false blocker.

Report freshness uses server time separately from presence: fresh below 90 seconds, stale at or above 90 seconds, unknown when the report timestamp is missing. Neither events, heartbeats nor publication create a change-report timestamp.

## C4 gate

No relationship analyzer is added. After C1–C3 are operational, two independently reviewed, reproducible real interactions missed by path overlap are required. Evidence names exact revisions, disjoint paths, the interaction and its consequence; synthetic tests alone do not qualify. The resulting cases determine a later narrowly scoped hint design. No hint may grant authority or assert compatibility.

Hosted acceptance is recorded separately in [verification](../local-verification.md). Local tests cannot establish provider event availability, subscription privileges, delivery latency or actual authenticated human approval.
