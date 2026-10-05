# Changelog

Notable user-facing changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Added

- Local bridge worktrees, advisory overlap, upstream reconciliation and artifact-bound deployment provenance.
- Architectural principles and guardrails, Mermaid diagrams, contributor/MCP guidance and a roadmap of future candidates.

### Changed

- Adopt Namespace → Repository → Workspace ownership with namespace access/budgets and durable human/agent workspaces.
- Use canonical Artifacts repositories, isolated writer forks, normal Git transport, exact-revision publication and human-reviewed source promotion.
- Replace the console and demo around the current ownership model.
- Consolidate product and architecture documentation around coordination across independent coding agents.

### Removed

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
