# Changelog

Notable user-facing changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Added

- Review notes. Hover a line in a change and press **+** to leave a concern or a comment on that exact line, or add one on the whole change. Concerns block promotion until a maintainer resolves them with a reason, and they follow the change when its workspace publishes a fixed revision, so republishing can't drop one. The owner's agent reads them with the new `get_review_notes` MCP tool, fixes the code, publishes and proposes the new revision, and answers with `reply_review_note`, citing that revision; it can also leave notes with `add_review_note`, but never resolve one. The bridge's `Cruce:` sentence and the Claude prompt hint name changes whose notes wait for the owner, and the `address_review_notes` MCP prompt runs the whole loop from tools that support prompts. See [ADR 0014](docs/decisions/0014-review-notes-on-exact-revisions.md).
- A calmer change review. The page leads with one next step and one button (for example **Check the answers** when your agent has replied), with the checklist as small steps that open on demand. Changed files read as one page with line numbers, changed words highlighted, light syntax colouring, whitespace-only changes hidden, and unchanged lines a click away. Files that likely matter come first; tests, docs, generated files, lockfiles, deletions and files from canonical are folded under **Supporting**. Notes sit beside their lines on wide screens. A revision timeline compares any two revisions of the change, starting from what changed since the last review. Keyboard: `n`/`p` files, `j`/`k` changes, `]`/`[` notes, `v` viewed, `x` fold.

- A repository or shared namespace on legacy connected-account storage, which Cruce can no longer reach, can now be deleted by forgetting that storage. The delete dialog explains that Cruce removes only its own records and requires checking **I understand Cruce will not delete the old storage**; the old storage keeps its Git until removed in that account. Storage that is only temporarily unavailable still blocks deletion. See [ADR 0013](docs/decisions/0013-forgetting-unreachable-legacy-storage.md).
- Add owner-only **Delete namespace** to shared namespace Settings. It permanently deletes every repository in the namespace, archived ones included, through each repository's own deletion, then removes the namespace and frees its handle. The confirmation requires typing the handle and says how many repositories, workspaces and open changes it ends; blockers are listed by repository, and a namespace whose storage is unavailable cannot start a deletion it could not finish. Once authorized, the namespace is read-only and only its owner can still open it; progress, the current reason and a retry of the original operation stay in Settings. Personal namespaces cannot be deleted. See [ADR 0012](docs/decisions/0012-namespace-permanent-deletion.md).
- Set up a machine once instead of once per repository. A new **Local setup** page in the avatar menu holds the one-time commands: install the client, `cruce login --server URL` to authorize Git for every repository you can access, and `cruce connect --server URL --client claude|codex|cursor` to register Cruce in that tool's own user-level settings. Below them, **Agent connections** lists each connection, what it reaches and what it may do, with Revoke. A repository's **Set up locally** now only clones it, or attaches an existing checkout with `git remote add cruce <canonical URL>` (or `cruce human` to work yourself), and links to Local setup. Connected tools find the repository from the checkout they start in. Outside a Cruce checkout the bridge explains how to start, and the Claude prompt hint stays silent. See [ADR 0011](docs/decisions/0011-account-level-connections-and-local-setup.md).
- The tool consent page defaults to **All repositories you can access**, which follows your current namespace roles and repository grants, including repositories created or shared later. **Choose repositories** still narrows a connection. The server rejects an empty or no-longer-accessible choice.

- Reconcile just before review. Changes on a stale base withhold Approve and evidence attestation until the updated revision exists, and their owner gets a copyable handoff for any agent session (plus `cruce resume`) on the change and workspace pages. A re-proposed change opens its diff on **Since reviewed #N**, with files that only came from canonical grouped apart, so a second review covers only what is new. A promotion names the workspaces it left behind, without asking anyone to update them yet.
- Coordinating agents now see workspaces left behind by a promotion. Every bridge tool response starts with a `Cruce:` sentence naming each of the owner's unended workspaces behind canonical, published or not, and `cruce connect --client claude` installs a Claude Code prompt hook (`cruce hint`) that adds the same sentence to the user's next prompt.
- Add **Delete workspace** to workspace pages: one confirmed action for the owner that ends the workspace, withdraws its open changes, releases its checkout and deletes its cloud fork, after which it moves to Earlier work in History with its published revisions and history. It replaces the separate Inspect retention and Delete fork steps. Deletion still stops when the fork holds commits that were never published, and the page lists those refs. Human owners no longer need Maintain to delete their own workspace's fork, and a maintainer can finish deleting someone else's ended workspace.

- Add owner-only Archive, Restore and permanent Delete in repository Settings, with unfinished-work blockers, exact-name confirmation, read-only archives, recoverable identity-checked cloud cleanup and original-operation retries. Deletion removes Cruce source/history while preserving local checkouts and external upstream repositories.

- Lane map: draw workspaces on a compressed axis of recorded time. Each lane leaves main at its baseline commit, shows its reported revisions as dots, published revisions as rings and its change as a capsule at the exact revision, and reaches "now" while the workspace exists; a breathing tip means a present connection and a dotted tail means the workspace stopped reporting. Long idle gaps are marked as breaks. Focusing a lane highlights how many promotions main recorded since its baseline. **Replay history** scrubs or plays the recorded starts, reports, publications, changes, approvals and promotions; presence, relation and shared paths are current facts and show only live.
- Lane map: promoted work now rejoins the main line on its own rail, with a draw-in, a travelling spark and a pulse at the junction (paused by "Pause motion", off under reduced motion). Only a recorded promotion draws a return path. Work already in canonical, through its own promotion or another workspace's, folds into a single "N merged" pill on main and into a collapsed group in the workspace list; unfold it with "Show N already in main". Work with newer commits, an open change or a detached checkout never folds.
- Show published revisions that no change proposes yet: an attention item, a "Not proposed" filter and pill, a lane-map label, and a one-click "Propose for review" for the owner (single or all). Shared reported paths are summarized once above the workspace list instead of repeated on every row. Agent instructions now say that `publish_revision` does not request review and to propose the revision when the task's work is done.
- Add an explicit local `preview_reconciliation` / `cruce preview` check against accepted canonical, with exact commits, conflict paths/types and honest unavailable/unrelated results. Scratch Git objects are isolated and working changes are preserved.
- Deliver bounded reported-overlap warnings, canonical update hints and continuation workspace IDs through bridge coordination context; add a read-only `cruce watch --coordination` JSON feed for external hosts.
- Deliver fresh, exact-revision reconciliation context with local bridge tool results and expose a subscribable MCP coordination resource. Connected subscribers receive changed-state notifications; reads recheck authority and never execute Git or wake agents.
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
- Add **Earlier work** to repository History and the `get_archive` MCP read. An ended workspace whose fork is cleaned up moves there with its closed changes, publications, evidence and settled promotions, and stays readable by any of its IDs or revisions. Links to archived changes, workspaces and records open a read-only record instead of "unavailable".
- Add an [operator runbook](docs/operations.md) for uncertain operations, storage identity mismatches, cleanup blockers, cache loss, observation delivery failures and coordination-state restoration. It states which procedures have not been rehearsed.
- Document interface compatibility for the MCP catalog, console API and bridge in [releases](docs/releases.md#interface-compatibility).

### Changed

- The repository page no longer repeats its name below the header. The header breadcrumb names the namespace and repository. One bar below it holds the tabs and a **main · revision · Clone** control, which opens the clone and existing-checkout commands. The separate **Set up locally** button and its Settings entry are gone. The Changes rail lists promotions only, since the bar already shows the canonical revision.
- A repository's changes now live under the workspaces that made them. The **Changes** tab is gone: **Workspaces** lists each workspace once, with its open changes nested under it along its lane colour, workspaces with a decision for you first, and the lane map below the list. Filters are **All**, **Needs you**, **Mine**, **Needs Git update** and **Not proposed**, and the attention bar's counts open the same list filtered. A workspace with an open change never folds away, and open changes from ended workspaces keep their own section. Saved `#/changes` links open the merged list with the same filter, and `#/changes/<id>` still opens the review. The Changes rail's workspace and promotion panels are gone; History holds promotions.
- Bridge agents now merge canonical into the workspaces attached to them just before publishing and proposing, and update other behind workspaces only when the user asks. The leading sentence now starts with `Cruce:` and separates attached workspaces from the rest; each coordination instruction is stated once, and identical coordination state is replaced by a one-line "unchanged" notice on later responses (a busy repository's block went from about 22 KB to 15 KB, and to one line when nothing changed).

- Installed clients need `cruce login` and `cruce connect` once per machine; earlier per-repository credentials are no longer read. Revoke old per-repository connections from Local setup, and delete project-level `cruce` entries in `.mcp.json`, `.cursor/mcp.json` or `.codex/config.toml` and the Cruce participation blocks in `CLAUDE.md`, `AGENTS.md` or `.cursor/rules/cruce.mdc`; participation guidance now travels as MCP server instructions.
- **Delete repository** no longer requires ending work first. Live workspaces, attached, disconnected or detached, and open changes end with the repository, and the confirmation says how many. Deletion still waits for in-flight promotions, unsettled resource operations and push-observation cleanup. Archive still requires finished work ([ADR 0010](docs/decisions/0010-repository-archive-and-permanent-deletion.md), amended).
- Proposing a newer revision from a workspace closes its older open change ("Superseded by #N"), so stale changes no longer wait for review or block archive.
- Cancelling a workspace (`end_workspace` with `cancelled`) withdraws its open changes, and ending any workspace releases its checkout reservation. `cruce end` and `cruce detach` release the local checkout when the workspace was already ended elsewhere.
- Say "Not compared yet" instead of "Canonical unavailable" when there is no accepted canonical revision to compare against, and "Already in canonical" instead of "Behind canonical" for work whose published revision canonical already contains.
- Label stale work as **Needs Git update**, distinguish agent-capable reconciliation from human approval, and guide agents to reconcile within their authorized task before proposing or requesting promotion. Divergence is not presented as proof of merge conflicts.

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

- Remove `cruce auth` and the `--namespace`/`--repository` options of `cruce connect`, the repository-scoped consent confirmation, and the **Connect an agent** tab of **Set up locally**. Use Local setup instead.
- Remove the namespace daily operation budget ([ADR 0008](docs/decisions/0008-remove-daily-operation-budget.md)). Resource operations, including source reads, no longer count against a daily limit, and nothing stops at midnight UTC. Namespace settings keep per-operation resource policy under **Storage operations**, and the namespace overview no longer shows today's usage. Retries still reuse their original reservation.

### Fixed

- A review step that is done no longer offers to do it again: recording a test pass or approving closes the step, an attested pass offers only **Record a failure instead**, and an approved revision shows no second Approve. Review note cards and the note composer line up cleanly, the line "+" sits on the line's own gutter, and the notes margin appears only while a file has a note, so the diff otherwise takes the full width. A change page leaves out the repository-wide attention bar and leads with its own next step; its file list drops the filter for 8 files or fewer and the group headings when there is only one group.
- The repository attention bar is gone; it only repeated the Workspaces list. Filters now carry their counts and appear only when they narrow the list, so a small repository shows no filter row; the "Matching workspaces" heading and the "Showing N of M" line are gone; rows no longer repeat what their pills say, and name the owner only when it is someone else's work or several people own work. One quiet line names an operation needing attention, degraded observation or unavailable ancestry.
- Workspace pages lead with the next step and show one value per fact, with machine and checkout identifiers folded under **Identifiers** and the observed pushed ref only when observation is on.

- Fix repository deletion stopping in **Deleting** after its first batch of cloud removals. The wake-up set when an attempt began fired before that attempt's recorded next time, found nothing due and scheduled nothing more; it now schedules the next wake-up. Each attempt now requests deletion of its whole batch of up to four cloud repositories and confirms them together on the next attempt, instead of one repository per 30-second attempt.
- Fix repository deletion staying blocked by "Recover unfinished resource operations" after an operation Cruce refused, such as a publication rejected for its review base. A refusal before any cloud call now releases its reservation instead of leaving it uncertain. Repository Settings lists any cloud operation that never settled, and the Owner can **Release** it; releasing runs, retries and deletes nothing, and a later retry of that operation is refused.
- Fix Git pushes failing with "Invalid refresh token" when several agents push at once. Workspace forks, the bridge and the Git credential helper share one OAuth connection whose refresh token rotates on every use, and each helper process spent it independently. Refreshes now happen under the connection's file lock after re-reading it, so one process spends each refresh token and the others reuse its still-current access token.
- When Git authentication fails, the credential helper now prints the exact command for the connection it reads (`cruce connect … --client NAME` for workspace forks, `cruce auth …` for canonical) with the real server, namespace and repository, and the cause.
- Publishing from a workspace whose baseline is ahead of canonical (for example a published skeleton not yet promoted) now reviews against that baseline instead of failing with "Integrate the review base with Git before publishing" and requiring an explicit `baseRevision`.
- Lane map: promoted revisions on main are labelled with the workspace that produced them, the caption names the work folded into main instead of only counting it, and revisions reported before a lane's baseline reached main are joined to the lane by a dotted lead-in instead of floating loose.
- Keep repository-scoped CLI authorization on the named repository, replacing the multi-repository picker with explicit access confirmation. Validate the original consent target on submission and keep OAuth grants in separate files per repository.

- Let one MCP bridge coordinate multiple isolated workspaces with explicit `workspaceId`, independent retry state and per-workspace reports. `attach_workspace` creates or reuses the local worktree, and CLI continuation/publication becomes visible without restarting MCP. Previously attached workspaces stay attached.

- Supply an installable local client from the Cruce website before clone, checkout attachment or agent setup. Replace source-checkout path placeholders with installed `cruce` commands; `cruce auth` configures repository-scoped Git authentication so cloning uses ordinary `git clone`.

- Align repository sketches, attention summaries and arrows across Home and namespace lists. Give namespace metadata clean lines, keep shared row metadata together when it wraps, and align prefixed form controls with ordinary inputs.

- Avoid flashing a loading screen during fast sign-in checks and keep the homepage background consistent from first paint. Sign in goes directly to Cloudflare Access; private links and expired sessions retain their destination without an extra Cruce sign-in page.

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
