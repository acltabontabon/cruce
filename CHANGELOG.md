# Changelog

Notable user-facing changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Fixed

- Pin provider repository IDs before token cleanup or Git access and validate canonical, fork and source/evidence retention identities on resource operations and retries. Recreated names fail closed. Storage restoration preserves interrupted promotion recovery and existing reservations. Published storage records now include the provider ID; unrecorded existing storage requires administrator reconciliation.

### Changed

- Redesign the repository pages in the same paper-and-ink system. The repository header carries a scope line and mono canonical revision, the attention bar uses status dots, and the four tabs are mono and ink-ruled. Changes shows what waits for review beside canonical and live workspaces; History puts the canonical timeline and activity beside published revisions and evidence; Settings uses the two-column sections of namespace settings. A change opens with its diff (added and removed lines coloured) beside a sticky review checklist that ends in Promote. Workspace and record pages lead with their own title over a fact grid, and the repository header steps back while they are open.
- Redesign the namespace console to match the homepage. A namespace is now one overview without tabs: a count strip (repositories, needs review, ready to promote, active workspaces), repositories and recent activity, with People, Teams and today's operations alongside. Invitations, role changes and teams are edited in place; an invitation link stays on screen with a copy button. Settings is its own page with segmented resource rules and a usage meter. Home uses the same layout, and the create dialogs show the handle prefix, derive a namespace handle from its name and offer Cancel. Saving no longer blanks the namespace while it refreshes. Old `#/members` and `#/teams` links open the overview.
- Redesign the public homepage to lead with context: three generations of software development (written, assisted, agentic) and where Cruce sits in the third. An animated Git graph then shows how it works: workspaces from an immutable baseline, advisory overlap, exact-revision human approval, sequential non-forced promotion and explicit reconciliation, with tools as annotations. Three plates cover durable workspaces, exact revisions and composability with plain Git. The page is shorter, keeps the paper-and-ink identity, and supports reduced motion, keyboard stage controls, 320px screens and 200% zoom.

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

[Unreleased]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/acltabontabon/cruce/releases/tag/v0.1.0-alpha.1
