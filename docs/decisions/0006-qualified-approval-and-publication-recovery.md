# 0006 — Qualified approval and durable publication recovery

Status: Accepted 2026-10-07

## Context

The authority table already requires an authenticated human with Maintain authority to approve for promotion. The controller accepted any human writer's approval, and historical review records did not capture the authority exercised. Treating an existing author as eligible today cannot establish their authority when the approval was recorded.

Publication could retain source or evidence and then lose its record because namespace settlement preceded the durable receipt. A later workspace completion or publication could block recovery of that exact retained work. Setup and attachment shared the same ordering.

## Decision

- Stamp promotion-qualifying reviews with server-verified human-maintainer authority. Agents retain informational reviews; Developers may raise concerns or disagree, but cannot approve for promotion. Paired terminals cannot exercise human-maintainer decisions.
- Unmarked historical reviews remain in history. Still-open changes require fresh qualified approval. Previously completed promotions and canonical history are preserved. A qualified approval remains a historical decision; this does not introduce current-access revalidation of its author. The current promoter and every retry must remain authorized.
- Persist publication provenance and an exact retention intent before pushing. The intent binds the command fingerprint, source revision, review base, retained repository ID/ref, result ID, time and content hash. Evidence reconstruction preserves its original author and commit.
- Record confirmation, then atomically save the artifact, activity and receipt before settling the original reservation. Setup and fork attachment also save their result before settlement. Saved-result retries recheck authority and policy and repair settlement without provider I/O.
- Reconcile an attempted retention write against the exact recorded ref and repository ID. A mismatching ref fails closed. An absent ref permits a retry only under current authority and an unfinished workspace. Already confirmed retention may be recorded after the workspace ends or the cache disappears. Older recovery never regresses a newer workspace publication.
- Pending publications reserve record capacity. Uncertain outcomes stay charged; no elapsed-time cleanup, autonomous publication runner or new infrastructure dependency is introduced.

## Consequences

Open changes may need approval again after this update. Review history is preserved rather than assigning authority retrospectively. Git review must include object ID, entry type and mode so protected-path checks also cover executable bits, symlinks and submodules.

Provider effects and coordination metadata remain separate systems. Exact retry reconciliation does not make them transactional or protect against every external provider writer. Coordination reads remain cache-only and do not initialize, repair or settle anything.

Local failure tests cover the transition and recovery. Hosted authentication, binding recovery and in-flight revocation acceptance remain separate work; see the [verification guide](../local-verification.md).
