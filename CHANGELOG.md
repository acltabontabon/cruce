# Changelog

Notable user-facing changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

## [0.1.0-alpha.4] - 2026-10-09

### Added

- **Review notes.** Comment or raise a concern on any line of a change. Concerns block promotion until a human resolves them and carry over to the next revision. The owner's agent reads them, fixes the code and replies; only humans resolve. New MCP tools `get_review_notes`, `add_review_note` and `reply_review_note`, and the `address_review_notes` prompt ([ADR 0014](docs/decisions/0014-review-notes-on-exact-revisions.md)).
- **Lane map.** The Workspaces tab draws each workspace from its baseline, with its revisions, open change, presence and shared paths. Promoted work rejoins `main`, and **Replay history** plays it all back.
- **Midnight**, a dark theme. The console follows the system, or choose Light or Dark from the avatar menu.
- **Set up a machine once.** `cruce login` authorizes Git for every repository you can access, and `cruce connect --client claude|codex|cursor` registers Cruce in your tool. **Local setup** lists your agent connections, with Revoke ([ADR 0011](docs/decisions/0011-account-level-connections-and-local-setup.md)).
- **Archive and deletion** for repositories, shared namespaces and workspaces, each confirmed by name, with blockers listed first ([ADR 0010](docs/decisions/0010-repository-archive-and-permanent-deletion.md), [0012](docs/decisions/0012-namespace-permanent-deletion.md), [0013](docs/decisions/0013-forgetting-unreachable-legacy-storage.md)).
- **Earlier work** in History keeps ended workspaces readable, with their changes, evidence and promotions.
- **Continue this workspace** shows what travels to another machine or tool, and how.
- **Agents stay current.** Bridge responses name the owner's work behind `main` and notes waiting for them. Agents merge `main` just before proposing, and `cruce preview` checks a merge locally first.
- **Integration feeds**: an MCP coordination resource, `cruce watch --coordination` and opt-in pushed-ref observation. None of them publish, approve or wake agents.
- **GitHub sign-in** through Access, with a [setup guide](docs/cloudflare-setup.md#github-sign-in).

### Changed

- **Workspaces is the main repository view.** Changes sit under the workspace that made them, so the Changes tab and attention bar are gone. Filters show counts and appear only when they help.
- **Review leads with one next step**, a short checklist ending in Promote, and files ordered by what likely matters, with notes beside their lines.
- **Home leads with Needs you**: only decisions you can make now.
- **A redesigned console** in Geist and JetBrains Mono, with lane colours, owners first and quieter pages.
- **One palette everywhere.** The homepage, sign-in, tool connection page, logo and favicon match the console, and the homepage shares its backdrop. A single splash covers cold starts.
- The homepage footer links the source and a Ko-fi page, which is also the repository's Sponsor button.
- **Reconcile just before review.** Stale changes hold back approval until updated, re-review shows only what's new, and stale work reads **Needs Git update**.
- **Changes tidy themselves.** A newer proposal supersedes the older one, and ending a workspace withdraws its changes and releases its checkout.
- Tool consent defaults to **All repositories you can access**.
- **Delete repository** no longer requires ending work first.
- **Storage stays bounded**: limits count only live work ([ADR 0009](docs/decisions/0009-replaceable-observations-and-archived-finished-work.md)).
- The README, contributor guide, roadmap and docs are shorter and match current behavior.
- **Upgrade:** run `cruce login` and `cruce connect` once per machine; per-repository credentials are no longer read. Revoke old connections from Local setup, and remove project-level `cruce` entries from `.mcp.json`, `.cursor/mcp.json` or `.codex/config.toml` and Cruce blocks from `CLAUDE.md`, `AGENTS.md` or `.cursor/rules/cruce.mdc`.

### Removed

- `cruce auth`, the `--namespace` and `--repository` options of `cruce connect`, and per-repository consent.
- The namespace daily operation budget ([ADR 0008](docs/decisions/0008-remove-daily-operation-budget.md)).

### Fixed

- Fork deletion works on Cloudflare Artifacts again, and anyone who could start a blocked deletion can finish it ([ADR 0015](docs/decisions/0015-resuming-a-recorded-fork-deletion.md)).
- Pushes from several agents at once no longer fail with "Invalid refresh token".
- Publishing from a baseline ahead of `main` no longer fails.
- A refused operation no longer blocks repository deletion; Owners can release unsettled ones from Settings.
- Interrupted promotions that already reached `main` complete.
- Agent connections outlive the browser session that approved them, with access still rechecked on every request.
- Bad Git packs and lost caches return clear errors, never partial state.

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

[Unreleased]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.4...HEAD
[0.1.0-alpha.4]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/acltabontabon/cruce/releases/tag/v0.1.0-alpha.1
