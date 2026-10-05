# Changelog

Notable user-facing changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Added

- Illustrated local console walkthrough covering namespaces, concurrent work, exact-revision review, source artifacts and account access.
- Local bridge worktrees, advisory overlap, upstream reconciliation and exact-revision source provenance.
- Architectural principles and guardrails, Mermaid diagrams, contributor/MCP guidance and a roadmap of future candidates.

### Changed

- Align product documentation and diagrams around proactive coordination across independent coding agents, with a two-vendor validation pilot and explicit limits. Put intent/dependency tracking, decision acknowledgements and opt-in supported controls in the roadmap; no runtime capabilities or promotion authority change.

- Give the avatar menu a compact Cruce profile card with the junction motif, an initial tile and a distinct sign-out row.

- Make repository search a real header input with compact anchored results instead of a modal, and use an unboxed mobile search icon beside the avatar. Cmd/Ctrl K focuses the same field; preserve page context, keyboard selection, partial results, retries and a compact mobile search panel.

- Replace the sidebar and modal scope picker with a slim header, balanced logo/search/avatar controls and searchable namespace/repository dropdowns. Home clears scope; the avatar opens an identity-and-sign-out menu in place without duplicate namespace navigation, and Alpha moves to the footer. Preserve keyboard access, saved links and Back navigation.

- Simplify repository navigation to Overview, Code, Work and Settings. Browse published revisions and provenance in Code, and inspect stored revision evidence alongside changes and workspaces in Work; reserve Cloudflare Artifacts naming for infrastructure.

- Redesign the console around independent workspace paths, exact-revision review and human decisions: interlaced Cruce identity, compact namespace home, truthful shared-surface topology, focused work/artifact inspection and accessible mobile navigation. Add local-checkout guidance and preserve canonical authority, permissions and retry behavior.

- Tidy console home hierarchy, compact spacing, readable namespace details, aligned search controls and subtle rounded account/sidebar hover states; correct singular repository/workspace counts.

- Clarify provider versus source/evidence terminology, durable workspace/fork ownership, advisory overlap and exact-revision human promotion without changing domain behavior.

- End Cruce coordination at human-reviewed reconciliation into canonical Git; CI, releases, deployments and runtimes remain external.

- Adopt Namespace → Repository → Workspace ownership with namespace access/budgets and durable human/agent workspaces.
- Use canonical Artifacts repositories, isolated writer forks, normal Git transport, exact-revision publication and human-reviewed source promotion.
- Replace the console and demo around the current ownership model.
- Consolidate product and architecture documentation around coordination across independent coding agents.

### Removed

- Repository Deployments capability, environment configuration, preview/production operations, rollback, Workers Builds observation and deployment workflows, including their APIs, scopes, budgets and state.
- Unused build-artifact and runtime-verification abstractions; source artifacts, reported evidence and human attestation remain.

- Legacy radar routes and compatibility aliases.
- Redundant progress log, superseded implementation plans and overlapping documentation.

## [0.1.0-alpha.1] - 2026-10-05

First alpha release.

### Added

- Agent missions, isolated Git workspaces, revision publication and proposals through MCP and the local bridge.
- Control Tower coordination, verification, promotion and deployment records backed by Cloudflare Artifacts.
- Project console with Access sign-in, MCP OAuth and an offline demo.
- Checked release-tag deployments; package and MCP versions aligned at `0.1.0-alpha.1`.

[Unreleased]: https://github.com/acltabontabon/cruce/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/acltabontabon/cruce/releases/tag/v0.1.0-alpha.1
