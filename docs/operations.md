# Operations

[Documentation map](README.md) · [Cloudflare setup](cloudflare-setup.md) · [Architecture](architecture.md) · [Verification](local-verification.md)

This page is for the installation administrator. Each procedure gives the symptom, how to inspect it with existing reads, the action and what not to do. Every recovery path keeps the original operation identity and reservation. Nothing here deletes retained source, approvals or provenance.

**Status:** these procedures describe current behavior. None has been rehearsed as a timed drill against the hosted test environment. Treat them as written procedure, not proven recovery. [Verification](local-verification.md) records what has been exercised.

## Before an incident

- Preserve the installation account, physical Artifacts namespace (`CRUCE_ARTIFACTS_NAMESPACE`), Worker name and `CRUCE_SECRET`. Account/namespace mismatches fail closed; changing the sealing secret can make credentials and continuation proofs unreadable.
- Keep the deployed Worker version and release tag ([test environment](test-environment.md) records them for the test installation).
- Note the time of any risky change. Durable Object point-in-time recovery addresses storage by time, so the time is the restore target.

## Uncertain or blocked operations

**Symptom.** A repository or namespace operation (creation, fork attachment, publication, cleanup, promotion, source inspection) returns an uncertain outcome or stays `pending`/`blocked`. Retries with a new key are refused because the reservation is still charged.

**Inspect.**
- Namespace maintainers: `GET /api/namespaces/<id>/reservations` pages every reservation with its action, operation and state.
- Repository snapshot: `canonicalSetup` for interrupted repository setup, and `promotionRecovery` for a promotion awaiting its original actor.
- `get_retention` with a `workspaceId` shows cleanup phase, attempts, next attempt and blocker.

**Act.**
- Retry with the original idempotency key and exactly the same input. Promotion recovery remains tied to its original actor. Fork cleanup exposes its recorded command to anyone currently eligible to start it: the owner through any authorized connection, or a maintainer for ended work ([ADR 0015](decisions/0015-resuming-a-recorded-fork-deletion.md)).
- Interrupted repository setup: a human maintainer uses the console's setup retry. It replays the recorded provisioning intent under its original reservation.
- Cleanup and enabled observation resume through bounded Durable Object alarms under current authority. If a blocker names authority, policy, scope or approval, restore it and retry the recorded operation with current approval. An eligible actor may take over recorded fork cleanup; other operations retain their own actor rules.

**Do not.**
- Edit reservation records by hand. For an abandoned operation listed in repository Settings, the console namespace Owner may use **Release** after ensuring no agent will retry it. Release runs/deletes nothing and refuses later retries of that operation; it does not prove what happened in the provider.
- Start a replacement operation with a new key while the original is uncertain.
- Treat elapsed time as resolution.

## Storage identity mismatch or a lost creation response

**Symptom.** One of these errors:
- "Recorded storage identity is unavailable; administrator reconciliation required"
- "Artifacts repository identity changed"
- "Recorded provider repository identities disagree"
- "Existing connected-account storage requires an explicit storage transition by the administrator"

**Cause.** Cruce records every provider repository ID (canonical, forks, retained source and evidence) before use and never adopts a name as proof. The error means one of:
- a physical repository was recreated under the same name
- the binding or account changed
- a creation response was lost before its ID was saved

**Act.**
1. Restore the original binding, account and physical namespace if they changed. Access returns, and the original operation can retry with its charged reservation.
2. If a repository was deleted and recreated, the original source is gone from that name. Do not point Cruce at the new repository. Restore the original from the provider, if possible, or treat the affected repository as lost and record it.
3. A lost creation response leaves an uncertain reservation and no recorded ID. Cruce ships no tool that adopts the existing provider repository. Reconciliation means confirming, outside Cruce, whether the provider created it. If it did not, retry the original operation. If it did, the administrator needs an explicit decision record and code change.

**Do not.** Edit `provider-repository:` records or repository state by hand. Delete or rename Artifacts repositories to "unstick" an operation.

## Storage transitions

Moving an installation to a different account or physical namespace is not supported in place. Existing connected-account records also block access ([ADR 0003](decisions/0003-deployment-managed-storage.md)). Plan a transition as new work:

- reconcile every charged reservation first
- keep the old storage until every published revision is retained elsewhere
- record the decision

To retire a legacy connected-account namespace instead, delete it with **Forget storage** confirmed ([ADR 0013](decisions/0013-forgetting-unreachable-legacy-storage.md)). Cruce removes only its own records; each repository's deletion receipt lists the provider repositories left in the old storage. Removing them there is a separate administrator decision.

## Fork cleanup blockers

**Inspect.** `get_retention`, then explicit `inspect_retention`. The latter is a `source.read` resource operation and checks every fork ref against canonical and retained source.

**Act.** Unretained refs block deletion. Publish what must be kept, or confirm that losing it is intended and resolve it in Git, then run a fresh `inspect_retention`. Incomplete inventories (too many refs, provider errors) also block. Retry after the provider recovers.

**Do not.** Delete the fork in the provider. Cruce would then refuse its recorded identity.

## Lost or stale Git cache

The Repository Durable Object's Git cache is disposable. If reads report "Source cache unavailable; explicitly recover retained source":
1. Run `inspect_source` to read from retained storage.
2. Run `recover_source` with the exact revision to restore it into the cache.
3. Use `GET /api/namespaces/<ns>/repositories/<repo>/export?revision=<sha>` to export a retained revision as a pack for an off-platform copy.

## Observation delivery failures

Push events reach `<worker>-artifact-events`. After bounded consumer retries they move to `<worker>-artifact-events-dead`. The dead-letter queue is consumed too: each message is recorded as a delivery failure, and the target is marked for background reconciliation rather than trusted.

**Act.**
- Restore missing `CF_EVENTS_API_TOKEN` or queue identities.
- Replay through the configured queue only.
- If observation stays degraded, a maintainer can disable it. Confirm subscription removal before removing queue consumers.

**Do not.** Add a public ingestion URL.

Observation never approves, promotes or cleans up anything, so a gap only reduces visibility.

## Restoring coordination state

Coordination state lives in three kinds of SQLite-backed Durable Objects:
- Directory: identity and addresses
- Namespace: membership, grants and reservations
- Repository: workspaces, changes, receipts, activity, archive bundles and the Git cache

OAuth grants live in Workers KV. Source lives in Artifacts.

Cloudflare provides [point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api) for SQLite-backed Durable Objects:
- any time in the last 30 days
- per object
- through `ctx.storage.getBookmarkForTime()` and `ctx.storage.onNextSessionRestoreBookmark()`
- restore takes effect on the object's next start

This is not available in local development.

**Current gap:**
- Cruce ships no administrator entry point that calls these methods. Restoration needs a reviewed, temporary code change that restores the named objects to one bookmark time.
- No restoration has been rehearsed.

**If a restoration is unavoidable:**
1. Stop writes. Deploy a version that refuses mutations, or remove the namespace members' access.
2. Choose one time T before the incident. Restore the affected Repository object and its Namespace object to T together, and the Directory too if identities changed. Restoring only one of them can leave reservations, receipts and repository state disagreeing.
3. Keep the bookmark that `onNextSessionRestoreBookmark` returns. It undoes the restore.
4. Artifacts storage is not rolled back. Publications, forks and promotions after T still exist in the provider, but the restored state does not record them. Treat them as unrecorded. Cruce will refuse to adopt them by name, and they need an explicit decision.
5. OAuth grants in KV are not rolled back. Revocations after T stay revoked. Grants created after T may name memberships or repository approvals the restored state does not contain. Authority is rechecked against current state on every request, so these grants confer nothing the restored state does not.
6. Re-run `get_reconciliation` and compare canonical heads with the provider before reopening writes.

Until a restoration drill is recorded in [verification](local-verification.md), do not promise recovery time or data-loss bounds for coordination state.
