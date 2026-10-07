# 0009 — Replaceable observations and archived finished work

Status: Accepted 2026-10-08

Amends [0005](0005-bounded-state-and-authorized-cleanup-recovery.md). Its other decisions stand.

## Context

ADR 0005 moved receipts and activity into indexed records and kept every operation identity forever. The bridge sends a heartbeat and a report every 30 seconds with fresh identities, so each connected workspace added two permanent receipts per tick: about 5,760 records a day. Ten bridges would reach the 200,000-record ceiling in about three and a half days of ordinary use. Every report that changed the reported paths also added a permanent activity event.

The per-repository limits of 256 workspaces, 512 changes and 512 promotions were the lengths of hot arrays that never shrank. They bounded a repository's lifetime, not its concurrent work, and fork cleanup reclaimed nothing. A team doing normal, successful work would eventually be refused.

## Decision

**Presence and reports are latest-wins observations.** `heartbeat` and `report_change` keep one replaceable record per workspace and tool, holding the latest operation identity, its fingerprint and its reply timestamps, plus one record for the reply body. Retrying the latest operation replays its exact reply. A changed request under that identity is refused. Reusing another tool's identity is refused. A missing reply record blocks replay rather than repeating the call.

An older or unknown identity runs as a new observation under current authority. Refusing superseded identities reliably would mean keeping every old identity, which is the growth this record removes. The only effect is overwriting reported presence, head, branch, commits and paths, which are observations and never authority. Nothing is reserved, published, approved or promoted, and the next report corrects a stale one. `lastReportAt` is the time the report was received. The bridge does not journal these calls as pending, so an uncertain report never blocks presence or another operation's retry. Steady presence rewrites fixed records and needs no new capacity, so it keeps working inside the recovery reserve. Only real growth is admitted against it.

**Change reports are coalesced in activity.** A workspace records at most one `changes_reported` event per 15 minutes. A change seen inside the window is recorded by the first report after it closes. Publication, review, verification and promotion events are never coalesced.

**Finished work leaves hot state as an archive bundle.** A bundle is one completed or cancelled workspace whose fork is absent or deleted and whose cleanup, if any, is complete. It contains the workspace, its changes, their verifications and promotions, and every publication and evidence record it produced. It is archived only when:

- every change is rejected or promoted
- every promotion has failed, or is complete and settled
- none of its promotions is among the 16 newest complete promotions
- no publication in the repository may still settle
- no change outside the bundle names its evidence

Promotions form one linear chain: each starts from the previous accepted head, and the push is not forced. Keeping the newest accepted promotions hot therefore keeps reconciliation exact. Hot state stays referentially closed, so live views, readiness and attention never consult the archive.

Archival is written in the same transaction as the transition that finished the work. It is a relocation, not a deletion. Bundles are immutable and retained, indexed by every record ID and published revision they contain. The deleted fork's and retained storage's provider identities stay recorded. Archival never uses the recovery reserve. When storage is full it is skipped, and a later save retries it; the transition itself is never refused. Reads never archive.

Reads that name archived records see them without writing. New mutations on archived records are refused. A retry of the operation that finished the work replays its receipt without provider calls. Change numbers come from a persistent counter and never repeat. `get_archive` pages bundles newest first and returns the bundle containing a subject. The console shows them as Earlier work in History.

The 256/1,024/512/2,048/512 limits now bound live work. State recorded before this change gets its change counter set from its existing changes on the next mutation. Nothing was archived before, so that count is exact.

## Consequences

`pnpm verify:limits` declares a workload of ten workspaces reporting every 30 seconds with worst-case churn:

- no receipt growth
- 40 observation records in total
- 960 activity records a day
- about 207 days to the record ceiling

Activity remains the one lifetime-growing record type; an explicit activity retention policy needs a separate decision. It also archives 1,000 finished workspaces with ten live ones and pages all of them back.

Limits:

- Ancestors of revisions published only by archived, unpromoted work are no longer known to cache reads. The exact archived revisions remain known.
- Lineage of an archived subject is traced within its own bundle and current hot records.
- Earlier heartbeat and report receipts written under ADR 0005 stay retained and counted; nothing migrates them.
- Hosted Worker CPU, memory and alarm behavior under this workload have not been measured.
