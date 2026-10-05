# Changelog

Notable user-facing changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Fixed

- Return safe errors over HTTP and MCP. Provider failures no longer expose Cloudflare API paths, account IDs or raw provider text, validation errors name the invalid field, and unexpected errors stay generic.
- Recover repositories whose creation failed before canonical storage existed. The console explains the missing setup and lets maintainers retry the original setup operation, reusing its budget reservation instead of creating a duplicate.
- Refresh OAuth credentials in later processes. The Git credential helper and long-running bridges now restore the registered callback, so the MCP SDK refreshes tokens instead of failing as a non-interactive client.
- Trim pasted Cloudflare account IDs and API tokens before verifying them, and keep browsers from autofilling saved passwords into the API token field.
- Bind canonical promotion to the exact approved old revision and candidate through the Git update. Persist promotion intent and reconcile interrupted outcomes without another push, recheck human authority on retries, preserve uncertain reservations, and allow console recovery after reload. Promotion provenance now saves before reservation settlement.
- Call the Git gateway’s provider fetch without binding it to the adapter, fixing deployed clone/fetch failures that Node adapter tests did not expose.
- Show rejected or expired OAuth consent as a no-store HTML retry page without issuing a grant.
- Render authenticated OAuth consent as an HTML form instead of displaying its source text, while preserving the provider's consent cookies.
- Sign out clears the Cruce cookie and hands off to Cloudflare Access logout, ending the Access session across the team's applications instead of allowing automatic re-entry.
- Load current personal namespaces from their dedicated identity directory after sign-in, keeping incompatible retired development records untouched.

### Added

- Reproducible two-writer convergence verification using real local Git: independently passing branches merge cleanly but fail a behavioral assertion, then require repair, exact-revision evidence and fresh human review. The same scenario passed against real Artifacts within its explicit 20-reservation budget, including retained source/evidence after fork cleanup. Review authority remains an in-process fixture; deployed authentication and actual client participation are separate verification gaps.

- Public early-development homepage with an illustrative hero showing independent workspace paths, advisory crossings, exact revisions and deliberate canonical convergence, with mobile recomposition and reduced-motion support.
- Cookie-verified public session detection, a lazy-loaded authenticated console, Cruce-only sign-out and a reviewable Cloudflare Access configuration for the public front door.

- Illustrated local console walkthrough covering namespaces, concurrent work, exact-revision review, source artifacts and account access.
- Local bridge worktrees, advisory overlap, upstream reconciliation and exact-revision source provenance.
- Architectural principles and guardrails, Mermaid diagrams, contributor/MCP guidance and a roadmap of future candidates.

### Changed

- Configure Cloudflare Artifacts once per installation through cf; repositories and workspaces inherit storage without namespace account/token setup. Storage identity changes and existing connected-account source fail closed pending an explicit administrator transition.
- Deployment account, origin, Worker name and storage namespace use portable installation settings for self-hosted/open-source installs.

- Redesign the console around what needs a person. Home lists your repositories sorted by attention. A repository opens with an attention bar ("1 change needs your review", "1 workspace behind canonical") and four tabs: Changes, Workspaces, History and Settings. Old Overview, Code, Work and Artifacts links redirect.
- Review a change as one checklist for its exact revision: built on current canonical, policy checks a maintainer confirms in one click, concerns, approval, then **Promote to *branch***, which explains exactly what it moves. The diff opens with the first file shown. Stale and superseded changes are labelled and collapsed.
- Describe workspaces by state (Active, Not reporting, Detached), canonical relation (Up to date, Behind canonical) and overlap in a sentence, and show continuation as "Started in Claude Code · continued in Codex". Release a checkout and delete a fork from the workspace page.
- Add a **Connect an agent** guide with copyable clone, connect and start commands for Claude Code, Codex and Cursor.
- Namespace settings show the Cloudflare account as a status card with **Check connection** and **Replace token**, today's operation usage against the daily limit, and readable policy names.
- Plain operational language throughout: activity reads as sentences, tool names replace OAuth client labels, and tab titles name the page. The console hero, taglines, topology drawings and getting-started blurbs are gone.

- Reset the product direction: Cruce is Git coordination for parallel agentic development, the durable coordination plane for Git work by independent humans and agents. New authoritative [product](docs/product.md) and [domain model](docs/domain-model.md) documents, rewritten principles, MCP guide and roadmap, and [decision records](docs/decisions/README.md) that state what was superseded. Agent execution, scheduling, pause/resume, messaging and acknowledgement protocols are explicitly out of scope.
- **Breaking:** a workspace is owned by a user, not by the agent connection that started it. Any of the owner's authorized connections and tools may continue it. Workspaces record `ownerId` and `createdBy` (provenance) instead of `actor`, and the free-text `context` field is now `description`.
- **Breaking:** the execution attachment is replaceable. `detach_workspace` (MCP), `cruce detach` and the console's **Release execution** free a workspace without losing its fork, revisions or provenance. `cruce resume --workspace ID` continues it in another checkout or on another machine from its pushed fork head. Workspaces gain a `detached` state, and `heartbeat`/`report_change` must name the attached execution.
- Publication no longer requires a local execution to be attached; it reads the pushed fork.
- The homepage illustration shows exact-revision human review instead of agents exchanging messages. Console workspace lists no longer rank agents first or count "agents working."

- Host the public homepage at `cruce.acltabontabon.com` with protected sign-in and private API routes; direct test deployment leaves the alpha release version unchanged.

- Show each illustration note subtly beneath its active progress dot, replacing that step’s label and keeping the diagram clear. Narrow layouts show only the note title.

- Audit and align product documentation around Git-native coordination and convergence across concurrent coding agents. Record implementation evidence, promotion/provider-identity gaps, current competitor capabilities and Cloudflare fit; prioritize safety, deployed two-tool proof and observed activity in a P0/P1/P2 roadmap. Automatic sequencing and supported pause/resume remain exploratory; GitHub integration is evidence-gated. This changes documentation only, not runtime capabilities or human promotion authority.

- Keep the homepage to its hero illustration, remove the How it works link and detailed product walkthrough, use one subdued Sign in text link, and mark early development with a quiet Coming soon note.
- Reframe the hero as the coordination vision: agents share advisories, align routine work and carry accepted changes forward, with unresolved decisions branching to the developer. Replace procedural review stages and dense captions with a compact progress strip, smoother independent-work and context-exchange animation. Keep the vision label without an additional explanation panel. Carry all three illustrative contributions back to separate canonical dots in the order Claude Code, Codex, then Cursor. Replace detached captions with anchored, fading SVG notes; guide attention with subtle path dimming, show only the latest accepted hash, keep moving dots within their own paths, and use one quiet playback text control.

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

- Read-only "observer" workspaces and the `--read` start option. Reading a repository needs a Read grant, not a workspace.
- `report_ref`, the stored reported-ref claims, the console's Observed refs panel and `cruce report-ref`.
- `get_context` and the Babel structural index (`src/intelligence`, `@babel/parser`).
- Roadmap items for automatic sequencing, agent pause/resume, decision acknowledgement, intent reports, business analytics and infrastructure-as-product items.

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
