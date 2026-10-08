# Changelog

Notable user-facing changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Added

- **Review notes.** Leave a concern or a comment on any line of a change, or on the whole change. Concerns block promotion until a maintainer resolves them with a reason, and they carry over when the workspace proposes a fixed revision, so republishing can't drop one. The owner's agent reads the notes, fixes the code, proposes the new revision and replies citing it; agents can add notes and reply, but never resolve. New MCP tools `get_review_notes`, `add_review_note` and `reply_review_note`, and the `address_review_notes` prompt ([ADR 0014](docs/decisions/0014-review-notes-on-exact-revisions.md)).
- **Lane map** on the Workspaces tab. Each workspace is drawn from its fixed baseline along recorded time, with its reported revisions, published revisions and open change, and a breathing tip while a checkout is connected. Shared paths are marked as advisory, promoted work rejoins main, work already in main folds into one "N merged" pill, and **Replay history** plays back the recorded events. Lanes are labelled by owner, large maps stay bounded, and **Pause motion** and reduced motion are respected.
- **Midnight**, a dark theme alongside the light Daylight theme. The console follows the system by default; the avatar menu offers System, Dark or Light.
- **Set up a machine once.** The client installs from the Cruce website. The **Local setup** page in the avatar menu gives the one-time commands, `cruce login` to authorize Git for every repository you can access and `cruce connect --client claude|codex|cursor` to register Cruce in that tool, and lists your **Agent connections**, what each can reach and do, with Revoke. Connected tools find their repository from the checkout they start in, and one bridge can coordinate several isolated workspaces ([ADR 0011](docs/decisions/0011-account-level-connections-and-local-setup.md)).
- **Archive and deletion.** Namespace Owners can archive, restore or permanently delete a repository from Settings, confirmed by its exact name. Deletion removes Cruce's source and history but never local checkouts or external upstreams ([ADR 0010](docs/decisions/0010-repository-archive-and-permanent-deletion.md)). Shared namespaces get owner-only **Delete namespace**, confirmed by its handle ([ADR 0012](docs/decisions/0012-namespace-permanent-deletion.md)), and repositories or namespaces on legacy storage that Cruce can no longer reach can be deleted by forgetting that storage ([ADR 0013](docs/decisions/0013-forgetting-unreachable-legacy-storage.md)). Workspace pages get **Delete workspace**: one confirmed action that ends the workspace, withdraws its open changes, releases its checkout and deletes its fork, and stops while the fork holds unpublished commits.
- **Earlier work** in History and the `get_archive` MCP read. Ended, cleaned-up workspaces stay readable with their changes, publications, evidence and promotions, and old links open a read-only record instead of "unavailable".
- **Continue this workspace** on workspace pages: what travels to another machine or tool (only pushed commits) and the detach and `cruce resume` steps.
- **Help for agents to stay current.** Every bridge response starts with a `Cruce:` sentence naming the owner's workspaces behind canonical and notes waiting for them, and `cruce connect --client claude` adds a prompt hook (`cruce hint`) that says the same. Agents merge canonical into their attached workspace just before publishing and proposing. `cruce preview` checks locally whether merging canonical would conflict, and a reconciliation view and `get_reconciliation` read show exact Git ancestry and blockers.
- **Coordination for integrations**: a subscribable MCP coordination resource, a read-only `cruce watch --coordination` feed, an attention projection on repository snapshots and `get_repository`, and opt-in pushed-ref observation. None of them publish, approve or wake agents.
- A [GitHub sign-in guide](docs/cloudflare-setup.md#github-sign-in): with GitHub as the Access application's only provider and Instant Auth, **Sign in** goes from the homepage straight to GitHub's authorization page, the Access policy still decides who is admitted, and existing users keep their identity.
- An [operator runbook](docs/operations.md) and [interface compatibility](docs/releases.md#interface-compatibility) notes.

### Changed

- Documentation now has a task-based entry point, a focused current architecture and one verification summary with explicit local, hosted and historical evidence limits. Setup, storage and deletion descriptions match the current implementation.
- **Workspaces is the repository's main view.** A repository's changes now sit under the workspaces that made them, so the Changes tab and the attention bar are gone. Workspaces lists each workspace once, with its open changes nested under it, decisions for you first and the lane map below. Filters (All, Needs you, Mine, Needs Git update, Not proposed) show their counts and appear only when they narrow the list, and a shared path is named once, on the row it concerns. Saved `#/changes` links still work. The header bar holds the tabs and a **main · revision · Clone** control with the clone and existing-checkout commands.
- **Change review leads with one next step**: one button (for example **Check the answers**), a compact checklist ending in Promote, and the files on one page with likely review targets first and tests, docs, generated files and lockfiles folded under **Supporting**. Notes sit beside their lines, any two revisions can be compared starting from what changed since the last review, and a finished step is not offered again. Keyboard: `n`/`p` files, `j`/`k` changes, `]`/`[` notes, `v` viewed, `x` fold.
- **Home leads with Needs you**: only the decisions you can make now, each with its owner, exact revision, blocker and your action. Work waiting on its owner or a maintainer is under **Waiting on others**, and the namespace overview counts Needs you too.
- **A redesigned console** on one visual system: Geist and JetBrains Mono, open lists between hairlines, frames only around the lane map, diffs and source, a quiet branded backdrop, and each workspace's lane colour on its rows, page and checklist. Rows lead with the accountable owner, and tools appear as provenance ("Worktree attached through Codex"). Workspace pages lead with the next step and fold identifiers away.
- **The public homepage, session screen, tool connection page, logo and favicon use the console palette** in either appearance, and the Access sign-in branding payload uses its Daylight colours. A cold start shows one splash, the Cruce mark drawing itself, until the first page. Inside the console, work you asked for shows a progress line under the header and placeholders instead of "Loading…". Sign in goes straight to Cloudflare Access. The README now shows the lane map and the review loop in motion.
- **Reconcile just before review.** A change on a stale base holds back Approve and evidence until the updated revision exists, and its owner gets a copyable handoff for their agent. A re-proposed change opens on **Since reviewed #N** with files that only came from canonical set apart, and a promotion names the workspaces it left behind. Stale work is labelled **Needs Git update**, divergence is never presented as proof of a conflict, and states read "Not compared yet" and "Already in canonical" where they apply.
- **Changes tidy themselves.** Proposing a newer revision supersedes the older open change ("Superseded by #N"). Cancelling a workspace withdraws its open changes, and ending one releases its checkout. Published revisions nobody has proposed are marked **Not proposed**, with **Propose for review** for the owner.
- **Evidence and history read plainly.** Evidence is worded by how far it is trusted ("Tests reported passing; human attestation required", **Attest tests pass**). Each History promotion names the approving and promoting humans, the source workspace and its owner, the previous canonical revision and the passing evidence.
- The tool consent page defaults to **All repositories you can access**, following your current roles and grants, including repositories added later. **Choose repositories** still narrows a connection.
- **Delete repository** no longer requires ending work first: live workspaces and open changes end with it, and the confirmation counts them. Archive still requires finished work.
- **Repository storage stays bounded.** Each workspace keeps only its latest heartbeat and report, "changed files" activity is recorded at most once every 15 minutes, and the limits of 256 workspaces, 512 changes and 512 promotions count only live work ([ADR 0009](docs/decisions/0009-replaceable-observations-and-archived-finished-work.md)).
- Bridge coordination context states each instruction once and replaces unchanged state with a one-line notice, so a busy repository's context dropped from about 22 KB to 15 KB.
- **Upgrade:** installed clients need `cruce login` and `cruce connect` once per machine; earlier per-repository credentials are no longer read. Revoke old per-repository connections from Local setup, and remove project-level `cruce` entries from `.mcp.json`, `.cursor/mcp.json` or `.codex/config.toml` and Cruce blocks from `CLAUDE.md`, `AGENTS.md` or `.cursor/rules/cruce.mdc`. Participation guidance now travels as MCP server instructions.

### Removed

- `cruce auth`, the `--namespace` and `--repository` options of `cruce connect`, and per-repository consent. Use Local setup instead.
- The namespace daily operation budget ([ADR 0008](docs/decisions/0008-remove-daily-operation-budget.md)). Nothing stops at midnight UTC any more; per-operation resource policy stays under **Storage operations**, and retries still reuse their original reservation.

### Fixed

- Deleting an ended workspace's fork works on Cloudflare Artifacts again, instead of every ref showing its retention proof as unavailable. A blocked fork deletion can be finished by anyone who could start it, from the console or the bridge ([ADR 0015](docs/decisions/0015-resuming-a-recorded-fork-deletion.md)).
- Git pushes no longer fail with "Invalid refresh token" when several agents push at once. When Git authentication fails, the credential helper prints the exact `cruce login` or `cruce connect` command to run.
- Publishing from a workspace whose baseline is ahead of canonical now reviews against that baseline instead of failing.
- An operation Cruce refused no longer leaves a reservation that blocks repository deletion. Settings lists any cloud operation that never settled, and the Owner can **Release** it.
- An interrupted promotion whose update already reached canonical now completes even if evidence or policy changed afterwards, and evidence is recorded only for open changes.
- Agent connections and paired terminals keep working after the browser session that approved them expires. Membership, grants, approved repositories and scopes are still checked on every request.
- Malformed or oversized Git packs, and evidence reads after cache loss, return actionable errors, and a failed cache recovery never leaves a partial pack.

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
