# 0010 — Repository archive and permanent deletion

**Status:** Accepted 2026-10-08

## Context

A namespace owner needs to retire finished repositories and remove repositories deliberately created for temporary work. Workspace completion and fork cleanup preserve history, but do not provide repository retirement. Permanent repository deletion conflicts with the unconditional retention language in principles 11 and ADRs 0005/0009.

## Decision

Add three authenticated console decisions: **Archive repository**, **Restore repository**, and **Delete repository**. Only a current human namespace Owner, without an agent or paired-terminal connection, can perform them. Agent/MCP discovery does not offer these decisions.

Archive makes the repository read-only and preserves canonical Git, forks, published revisions, evidence and history. Restore permits new work again. Both decisions use durable operation identities and freeze writes while an interrupted Namespace/Repository transition awaits authenticated retry. Archived repositories remain discoverable and labelled for reading and restoration.

Archive and deletion require all workspaces to have ended, all changes to be closed, promotions and resource reservations to be settled, and push observation/subscription cleanup to have finished. Disconnected or detached workspaces remain unfinished work. Historical execution metadata on an ended workspace is not an active checkout reservation. Retirement never ends somebody else's work or releases local writer locks.

Permanent deletion additionally requires the exact repository name as confirmation. This is an explicit exception to indefinite source/provenance retention: it authorizes removal of this repository's canonical Git, forks, retained source/evidence stores, coordination records and derived Git cache. It does not remove local checkouts, external upstream repositories, namespace membership, or another repository's resources. Ordinary completion, archival, cache eviction, capacity limits and elapsed time continue to confer no deletion authority.

Deletion is a durable, irreversible intent. It freezes new writes before provider effects, uses one namespace `repository.delete` reservation, and rechecks current owner authority, resource policy and pinned installation/provider identity before each effect. No-resource registrations can be deleted without initializing cloud storage. Recover at most four recorded provider repositories per attempt; confirm absence for each, remove canonical last, persist confirmation before settlement, then purge bounded batches of coordination records and the Git cache. An alarm recovers only submitted intent. Changed authorization/policy/identity blocks recovery and leaves an inspectable retry with the same operation identity; unknown outcomes remain reserved. No credential is stored in the intent.

Keep a small deletion receipt/tombstone and namespace reservation ledger to prevent resurrecting an old stable ID or repeating an uncertain effect. Deleted repository descriptors move out of the namespace's live repository list into indexed tombstones, so the name and live capacity can be reused by a new stable ID. Reusing a creation key does not recreate a deleted repository.

## Consequences

The console explains permanence, shows controller-derived blockers, requires typing the name, shows partial cleanup and offers the original retry. A completed deletion leaves the repository list; old links report deletion. Archival remains the reversible choice when history should survive.

This amends the unconditional repository-retention parts of ADRs 0005 and 0009. Their workspace cleanup, immutable finished-work archives and no-expiry deletion rules otherwise remain in force. Local tests and fixtures establish implementation behavior; hosted deletion through the configured Artifacts binding requires separate acceptance evidence.
