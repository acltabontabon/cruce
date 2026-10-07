# Changelog

Notable user-facing changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Added

- Add opt-in pushed-ref observation with policy-gated subscriptions, idempotent Queue ingestion, bounded gap recovery and visible degraded state. Observations never publish or approve source.
- Add a repository reconciliation view and `get_reconciliation` MCP read based on exact published Git ancestry, with proposal blockers and explicit unknown results.
- Show report freshness independently of presence throughout workspace and reconciliation views.
- Add a dark console theme, Midnight, alongside the light Daylight theme. The console matches the system by default, and the avatar menu offers System, Dark or Light.
- Lead Home with **Needs you** across repositories, followed by advisory heads-ups.
- Add a lane map to Workspaces that draws canonical promotions and each live workspace from its fixed baseline through head, published revision and change. Unplaced baselines and quiet checkouts are drawn dashed, and shared paths are marked as advisory.
- Add **Agent connections** to the avatar menu: every agent you approved, with its mark, approved repositories, permissions, approval and expiry, and a confirmed **Revoke**. Names and marks are what each agent reports about itself. New approvals record the client name and approved repositories with the grant so they can be listed; older grants show "Repositories not recorded".
- Add a read-only attention projection to repository snapshots (and the `get_repository` MCP read). Each current change, and each live workspace that needs reconciliation, carries its responsible owner, exact revision and comparison basis, one group (Operation needs attention, Ready to promote, Needs human review, Needs preparation or Needs reconciliation), every structured blocker in order, and the next actions available to the viewer under current authority. It writes nothing, reads no source and assigns nothing.
- Filter repository Changes by **Needs you** or by attention group, and Workspaces by **Mine**, **Needs reconciliation** or owner. Filters live in the URL, so links, reloads and Back keep them.
- Add **Continue this workspace** to workspace pages: what travels (only pushed commits), the reported head against the observed fork branch and last publication, and the existing detach and `cruce resume` steps. Other users are told that only the owner can attach it and that ownership transfer is unsupported.
- Add a Cruce sign-in page at `/sign-in`. The homepage's **Sign in** opens it, and signed-out repository links, invitations and expired sessions show it in place with what signing in will open. Its button still hands off to Cloudflare Access; an optional `CRUCE_SIGN_IN_PROVIDER` label (for example GitHub) names the Access identity provider on the button.
- Add **Earlier work** to repository History and the `get_archive` MCP read. An ended workspace whose fork is cleaned up moves there with its closed changes, publications, evidence and settled promotions, and stays readable by any of its IDs or revisions. Links to archived changes, workspaces and records open a read-only record instead of "unavailable".
- Add an [operator runbook](docs/operations.md) for uncertain operations, storage identity mismatches, cleanup blockers, cache loss, observation delivery failures and coordination-state restoration. It states which procedures have not been rehearsed.
- Document interface compatibility for the MCP catalog, console API and bridge in [releases](docs/releases.md#interface-compatibility).

### Changed

- Replace the three overlapping repository setup buttons with one **Set up locally** guide containing Clone, Existing checkout and Connect an agent.
- Animate connected workspace presence and highlight newly reported heads or publications, with Pause motion and reduced-motion support. Fold detached lanes and rows into counted disclosures, and keep large lane maps bounded and paginated without dropping workspaces.

- Redesign tool authorization with a focused repository picker, search, plain-language permissions, connection details and clear connect/cancel actions. Empty and expired requests include recovery guidance.

- Make Home's **Needs you** viewer-specific: it lists only decisions you can make now, each with its owner, exact revision, primary blocker, the number of further blockers and your action. Visible work whose next step belongs to its owner or a maintainer moves to **Waiting on others**. Capped repository summaries say "Showing 8 of 17" and link to the full filtered list.
- Lead change and workspace rows with the accountable owner, resolved from namespace identity with an explicit fallback; tool labels move to provenance ("Worktree attached through Codex", "published through Codex, Maya's connection"). The lane map labels each lane with its owner.
- Group repository Changes by next action instead of one review list, and count recovery, promotion, review, preparation and reconciliation separately in the attention bar, where each count opens its filtered list. Stale changes are now reconciliation work rather than hidden with superseded ones.
- Count diverged work, unpublished baselines behind canonical and published ancestry missing accepted revisions as needing reconciliation. A published revision already contained in canonical no longer counts as behind, and workspaces with unavailable ancestry are counted separately as missing knowledge. Canonical comparison is offered for diverged as well as behind workspaces.
- Word evidence by its trust: "Required tests evidence missing", "Tests reported passing; human attestation required", "Tests failing" and "Tests attested". The maintainer action reads **Attest tests pass** for reported results and **Record checked tests pass** when nothing was reported.
- Show on each History promotion the approving human, the promoting human, the source workspace and its owner, the previous canonical revision and the passing evidence for the promoted revision.
- Replace the namespace overview's **Needs review** count with the viewer-specific **Needs you** count.
- Give the console a quiet branded backdrop: a faint accent glow, a fading dot grid and the Cruce crossing in hairlines, in both themes.
- Highlight rows on hover or keyboard focus with a soft accent spotlight that follows the pointer, a faint accent wash and an accent edge drawn in from the left.
- Redesign the console on one token-based visual system with Geist and JetBrains Mono, open lists between hairline rules, and frames only around the lane map, diffs and source.
- Show each workspace's lane colour on its rows, its workspace page and its change's review checklist. Turn the repository attention bar into a strip of counts that each open where they are handled.
- Add the attention items behind the counts, and the state of live workspaces, to repository summaries so Home can name each decision. Summaries carry the viewer's actionable items first, capped at eight, with exact totals.
- Presence and change reports no longer use up repository storage. Each workspace keeps only its latest heartbeat and report, so connected bridges add no records over time. A retry of the latest report replays exactly; an older one is treated as a new report. The bridge no longer holds back other operations while a report is uncertain ([ADR 0009](docs/decisions/0009-replaceable-observations-and-archived-finished-work.md)).
- Record at most one "changed files" activity event per workspace every 15 minutes. A change inside the window is recorded when it closes.
- Repository limits of 256 workspaces, 512 changes and 512 promotions now count live work. Finished, cleaned-up work no longer counts, and change numbers continue without repeating. Settings shows live workspaces and the archived count.
- Run the console browser tests in release checks.

### Removed

- Remove the namespace daily operation budget ([ADR 0008](docs/decisions/0008-remove-daily-operation-budget.md)). Resource operations, including source reads, no longer count against a daily limit, and nothing stops at midnight UTC. Namespace settings keep per-operation resource policy under **Storage operations**, and the namespace overview no longer shows today's usage. Retries still reuse their original reservation.

### Fixed

- Keep repository-scoped CLI authorization on the named repository, replacing the multi-repository picker with explicit access confirmation. Validate the original consent target on submission and keep OAuth grants in separate files per repository.

- Let one MCP bridge coordinate multiple isolated workspaces with explicit `workspaceId`, independent retry state and per-workspace reports. `attach_workspace` creates or reuses the local worktree, and CLI continuation/publication becomes visible without restarting MCP. Previously attached workspaces stay attached.

- Supply an installable local client from the Cruce website before clone, checkout attachment or agent setup. Replace source-checkout path placeholders with installed `cruce` commands; `cruce auth` configures repository-scoped Git authentication so cloning uses ordinary `git clone`.

- Complete an interrupted promotion whose update already reached canonical, even if evidence or policy changed afterwards. Record evidence only for open changes.
- Limit terminal bridge discovery to its approved namespace and repository.
- Keep agent OAuth connections and paired terminals working after the browser's Access session that approved them expires. Connections now last for their own grant or terminal authorization, and current membership, grants, approved repositories and scopes are still checked on every request. Existing connections need no reconnection.
- Return actionable errors for malformed or oversized Git packs, and for evidence reads after cache loss. Never leave a partial pack after a failed cache recovery.

## [0.1.0-alpha.3] - 2026-10-07

### Changed

- Simplify the homepage and namespace/repository console, with clearer status, focused diffs and a review checklist that leads with the next blocker.
- Unify Clone, Attach local checkout and agent setup, including Git credentials, fork-cost disclosure and manual copy options.
- Add explicit, budgeted inspection and recovery of stored source, evidence and history. Bound coordination state, cloud inputs and local caches while preserving retained source and provenance.

### Fixed

- Require authenticated human Maintain authority for promotion approval; older unqualified approvals need a fresh decision. Include executable bits, symlinks and submodules in review and protected-path checks.
- Recover interrupted publication, setup, attachment, promotion and explicitly requested fork deletion with the original operation and reservation, preserving newer work and confirmed results.
- Pin provider repository identity and refuse recreated storage names; existing storage without recorded IDs requires administrator reconciliation. Coordination reads remain free of writes and cloud calls, including after restart.
- Preserve local writer ownership, mutation identity and existing-checkout remotes through interrupted attachment and cleanup; save private state atomically.
- Prevent overlapping or late console updates, clear data after access denial and support retries and partial results. Keep report freshness separate from heartbeats.
- Return safe HTTP/MCP errors and redact credentials, source and provider details from retry diagnostics.

## [0.1.0-alpha.2] - 2026-10-06

### Added

- Brand the existing Cloudflare Access email-and-code screen with Cruce's mark, paper background, forest text and sign-in guidance. Keep a reviewable branding payload and installation instructions.
- Public homepage with an illustrative concurrent-work diagram, responsive layouts and reduced-motion support; private console data remains authenticated.
- Reproducible two-writer Git convergence verification and a local console walkthrough. Deployed multi-tool participation evidence records independent Claude Code and Codex work, cross-connection continuation, stale detection and human-approved promotion.

### Changed

- Reset Cruce around durable Git coordination, organized as Namespace → Repository → Workspace. Workspaces belong to users and outlive agent sessions; one explicitly detachable execution attachment can be replaced by another authorized connection or tool. Reports name the attached execution, while publication reads the pushed fork.
- **Breaking:** configure Artifacts once per installation through cf. Namespaces no longer accept Cloudflare account credentials. Account/storage identity is pinned; legacy connected-account namespaces block resource operations pending an explicit administrator transition. Existing source is not migrated or deleted.
- **Breaking:** workspace ownership uses `ownerId` and `createdBy`; `context` becomes `description`. Observer workspaces and retired project/mission aliases are removed.
- Redesign the console around repositories needing attention, with Changes, Workspaces, History and Settings tabs, exact-revision review checklists, focused diffs, plain status language and a Connect an agent guide. Preserve scoped search, keyboard navigation, deep links, Back, retries and late-response protection.
- Use portable deployment account, origin, Worker and storage settings. Update the release environment to the existing custom domain.
- Sign out ends the Cloudflare Access session across the team's applications after clearing the Cruce cookie.

### Fixed

- Validate the exact approved base and candidate during non-forced Git promotion. Persist promotion intent and reconcile interrupted outcomes without another push, preserving uncertain reservations and rechecking current human authority.
- Let maintainers retry failed canonical repository setup with the original operation and budget reservation.
- Refresh OAuth credentials in later Git-helper and bridge processes; render consent and consent failures as HTML, and correct the native Worker Git-fetch receiver.
- Load current personal namespaces from their dedicated identity directory after sign-in. Return safe HTTP/MCP errors without provider paths, account IDs or raw provider messages.

### Removed

- Agent execution, scheduling, messaging, pause/resume and acknowledgement protocols; `report_ref`, `get_context` and the structural index. Reading a repository requires a Read grant, not a workspace.
- Repository deployment, environment, preview, rollback, build and runtime operations. Cruce's own release pipeline remains installation infrastructure.
- Legacy radar routes, compatibility adapters, progress logs and superseded implementation plans.

## [0.1.0-alpha.1] - 2026-10-05

First alpha release.

### Added

- Agent missions, isolated Git workspaces, revision publication and proposals through MCP and the local bridge.
- Control Tower coordination, verification, promotion and deployment records backed by Cloudflare Artifacts.
- Project console with Access sign-in, MCP OAuth and an offline demo.
- Checked release-tag deployments; package and MCP versions aligned at `0.1.0-alpha.1`.

[Unreleased]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.3...HEAD
[0.1.0-alpha.3]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/acltabontabon/cruce/releases/tag/v0.1.0-alpha.1
