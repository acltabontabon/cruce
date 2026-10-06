# 0004 — Bounded source inspection and recoverable Git cache

Status: Accepted 2026-10-06

## Context

Artifacts is source authority; Repository DO SQLite is coordination authority. The bare Git cache nevertheless became necessary for reading published source and promoting it. Cache loss could strand retained revisions after successful remote retention, while repeated fetches accumulated packs indefinitely. Replacing Git ancestry with the provider's first-parent history would incorrectly exclude merged work.

Coordination reads must stay free of provider calls, provisioning, reservations and durable writes. Source inspection and recovery need an explicit resource boundary rather than an automatic fetch hidden in a metadata read.

## Decision

Keep `get_source`, `get_history`, `get_diff`, `read_artifact`, pack export and workspace comparisons as cache-only reads. Add explicit `inspect_source` and `recover_source` resource operations to the shared catalog. Both require repository Read authority, `cruce:read` for agents, exact input and an idempotency key. Namespace policy and the shared daily budget gate `source.read` before provider access; repository policy only narrows it. The console discloses cloud access and one reservation per request before offering these operations.

Use identity-checked Artifacts commit/tree/file/history APIs for listings, individual files, evidence and explicitly labelled first-parent history. Fetch no packs for those views. Bound calls, tree entries, inline bytes and responses. Show binary/oversized content as unavailable; fail an incomplete bounded listing rather than presenting it as complete. Authorize ancestor inspection by walking every parent of recorded retained tips, never by treating `log()` as complete ancestry.

Keep Git objects for full ancestry, diffs, packs, retention and promotion. SQLite enforces a 64 MiB byte ceiling and 20,000 rows during writes, with a 48 MiB / 10,000-row retention threshold at explicit mutation boundaries. Bytes include paths and file data, not SQLite page overhead. Evict the entire bare generation together, including refs, shallow state, packs and indexes. Clear decoded in-memory objects at those boundaries. Metadata, provider IDs, reservations and remote retained refs are outside eviction.

Recovery validates recorded provider identity and the exact retained ref, fetches into clean staging without stale negotiation refs, traverses and checksum-validates the complete all-parent graph, and imports a validated pack into the bounded cache. Git requests/exports are capped at 32 MiB, and traversal at 20,000 objects / 64 MiB of expanded wrapped objects. Recovery never accepts a moved ref, missing parent/blob or shallow boundary as retained source. Larger repositories remain accessible with ordinary external Git and bounded provider file reads; these Worker limits are not provider repository limits or a guarantee of peak decompression memory.

Attachment, publication, cleanup and promotion recover/check source within their existing authorized reservation when necessary. Recovery after a lost promotion response preserves the original operation and never repeats an attempted push. Initial and evidence authors/timestamps are journalled so cache loss before retention does not change the exact commit on retry. General publication receipt/settlement parity remains R3.

## Consequences

Retained source remains inspectable without a fork or local cache. Eviction can make cache-only comparisons unavailable; explicit recovery restores them without changing ownership, baselines, review, approval, accepted source or provenance. Inspection/recovery retries repeat bounded I/O with the original reservation under current authority; large source responses are not durable receipts. A separate intent fingerprint prevents operation-key reuse across resource and control commands.

This preserves the product boundary and ADRs 0001–0003. It adds no source provider, agent runtime, scheduler, automatic source cleanup or second canonical authority. Local SQL/native Git/binding fixture tests establish the implemented contract; deployed binding behavior and Worker memory limits still require hosted acceptance. See [F4 verification](../local-verification.md#bounded-source-inspection-and-cache-recovery-f4).
