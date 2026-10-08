# 0015 — Resuming a recorded fork deletion

**Status:** Accepted 2026-10-09

Amends [0005](0005-bounded-state-and-authorized-cleanup-recovery.md).

## Context

ADR 0005 journals one fork deletion per workspace and lets only its original actor retry it after a block. An agent connection, a paired terminal and the console are different actors, even for the same person. When a deletion an agent started was blocked, for example by a retention proof that could not be read, the console said only the person who started it could retry, and a new deletion was refused because one was already recorded. Recovering needed that exact agent connection and its operation key, which the local bridge did not keep. On the hosted test environment this left a cancelled workspace's fork undeletable from the console.

The original actor adds nothing to safety. Every attempt already rechecks the caller's current authority, scopes, resource policy, retention proof and provider identity before any provider call.

## Decision

A recorded deletion is identified by its command (workspace, operation key and fingerprint), not by the actor who started it. Anyone who could start that deletion now may resume it: the workspace owner through any authorized connection, or a maintainer once the workspace has ended. The console, `get_workspace` and `get_retention` show the recorded command to those actors, and the bridge resumes it under its recorded key instead of minting a new one. A different command is still refused while one is recorded.

The resumer's grant becomes the operation's continuation proof for later recovery, and their reservation is the current one. Earlier drivers' reservations are kept on the operation and settled with it, so no reservation stays uncertain once the deletion is confirmed. Their retries of the same command replay the confirmed result. The operation keeps its recorded identity throughout. A blocked attempt keeps the reservation it took.

## Consequences

- A blocked deletion can be finished from the console or by any of the owner's connections without the starting connection.
- Background recovery runs under whoever last drove the deletion, so their current authority applies.
- Earlier drivers stay visible through their reservations; repository Settings no longer lists them as unfinished once the deletion is confirmed.
