# Decision records

[Documentation map](../../README.md#documentation-map) · [Product](../product.md) · [Principles](../principles.md)

Focused records of consequential decisions whose rationale is larger than its owning document can reasonably hold. Each record states context, decision, consequences and what it supersedes. Owning documents ([product](../product.md), [domain model](../domain-model.md), [architecture](../architecture.md)) describe the current state; these records explain why it changed. Git history preserves implementation history. These are not progress logs.

| Record | Status | Summary |
| --- | --- | --- |
| [0001 — Product boundary reset](0001-product-boundary-reset.md) | Accepted 2026-10-06 | Cruce is the durable Git coordination plane for parallel agentic development; execution, messaging, scheduling and CI/CD are out of scope. Includes the alignment audit and the keep/change/remove/defer analysis |
| [0002 — Workspace ownership and execution attachment](0002-workspace-ownership-and-execution-attachment.md) | Accepted 2026-10-06 | Workspaces are owned by users, not agent connections; execution attachments are replaceable |
| [0003 — Deployment-managed storage](0003-deployment-managed-storage.md) | Accepted 2026-10-06 | Installation Artifacts binding replaces namespace account connections; namespace permissions, budgets and durable storage identity remain |
| [0004 — Bounded source inspection and recoverable cache](0004-bounded-source-inspection-and-cache.md) | Accepted 2026-10-06 | Explicit budgeted provider inspection and exact retained-source recovery; coordination reads remain pure and the Git cache becomes evictable |
| [0005 — Bounded state and authorized cleanup recovery](0005-bounded-state-and-authorized-cleanup-recovery.md) | Accepted 2026-10-06 | Indexed retained coordination records, explicit capacity limits, inspectable retention blockers and bounded alarms for submitted fork deletion |
| [0006 — Qualified approval and durable publication recovery](0006-qualified-approval-and-publication-recovery.md) | Accepted 2026-10-07 | Server-stamped human-maintainer approvals, fresh approval for unmarked open changes, exact publication journals and result-before-settlement ordering |
| [0007 — Observed refs and repository reconciliation](0007-observed-refs-and-reconciliation.md) | Accepted 2026-10-07 | Opt-in event observation, bounded recovery and pure published-ancestry projections; observations never establish acceptance |
| [0008 — Remove the namespace daily operation budget](0008-remove-daily-operation-budget.md) | Accepted 2026-10-08 | Drop the daily operation count and limit; keep reservations for retry identity and per-action resource policy. Supersedes the budget parts of 0003 and 0004 |
| [0009 — Replaceable observations and archived finished work](0009-replaceable-observations-and-archived-finished-work.md) | Accepted 2026-10-08 | Presence and reports keep one replaceable record per workspace; change reports are coalesced; finished work moves to immutable archive bundles so limits bound live work. Amends 0005 |

| [0010 — Repository archive and permanent deletion](0010-repository-archive-and-permanent-deletion.md) | Accepted 2026-10-08 | Owner-only reversible archive and explicit permanent deletion, with durable cleanup, namespace-gated retries and minimal tombstones. Amends retention in 0005 and 0009 |
| [0011 — Account-level connections and local setup](0011-account-level-connections-and-local-setup.md) | Accepted 2026-10-08 | Connections approve all accessible repositories (default) or a chosen list; install, Git sign-in and tool connection happen once per machine; a checkout's canonical remote is an address, never authority |
| [0012 — Namespace permanent deletion](0012-namespace-permanent-deletion.md) | Accepted 2026-10-08 | Owner-only deletion of a shared namespace and every repository in it, driven through each repository's own deletion, with an immediate freeze, directory retirement and a minimal tombstone. Extends 0010 |
| [0013 — Forgetting unreachable legacy storage](0013-forgetting-unreachable-legacy-storage.md) | Accepted 2026-10-08 | Repositories and namespaces on legacy connected-account storage are deleted by forgetting that storage after explicit owner confirmation; no provider call, inventory kept. Amends 0010 and 0012 |
| [0014 — Review notes on exact revisions](0014-review-notes-on-exact-revisions.md) | Accepted 2026-10-09 | Line-anchored concerns and comments on exact revisions that follow a change across republishing; agents read and answer them through MCP and the bridge, only a human maintainer resolves them |
| [0015 — Resuming a recorded fork deletion](0015-resuming-a-recorded-fork-deletion.md) | Accepted 2026-10-09 | Anyone who could start a fork deletion may resume the recorded one; earlier drivers' reservations settle with it. Amends 0005 |

Add a record only for a decision that changes the product boundary, the domain model, authority or a core dependency. Number records sequentially, and never rewrite an accepted record's decision. Supersede it with a new one.
