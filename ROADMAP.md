# Roadmap

[Documentation map](docs/README.md) · [Product](docs/product.md) · [Domain model](docs/domain-model.md) · [Architecture audit](docs/architecture.md#current-limitations)

Cruce is the durable Git coordination plane for parallel agentic development. This roadmap orders work by that thesis: trustworthy foundations and exact-revision reconciliation first, then coordination signals, then broader collaboration and ecosystem reach. Intelligence comes last.

These are candidates, not commitments, dates or work instructions. Current behavior is described in the [architecture](docs/architecture.md), evidence in [verification](docs/local-verification.md), and history in Git. **Now** is needed for a credible end-to-end foundation, **Next** strengthens the coordination product, and **Later** waits for evidence from the earlier stages. Every item must pass the [boundary test](docs/product.md#the-boundary-test).

## Readiness for a supported 0.1.0

Releases stay alpha until these gates are met. Each needs recorded evidence in [verification](docs/local-verification.md), not only local tests.

- **Hosted journey on the current storage binding.** Finish D2 against the release build and deployment-managed Artifacts binding: response loss, membership and grant revocation (M1), and continuation from a second physical machine. Hosted fork cleanup and retained-source proof passed on 2026-10-09.
- **Sustained capacity in a hosted installation.** Repeat the declared [`verify:limits`](docs/architecture.md#bounded-coordination-state-and-retention-recovery) workload against a deployed Worker and record Worker CPU, memory and alarm behavior.
- **Rehearsed recovery.** Run the [operations](docs/operations.md) procedures as timed drills, including a coordination-state restoration, and record what was restored and lost.
- **One supported onboarding path for existing teams.** D4, with an explicit path between Cruce and the team's forge review (E1 or a documented manual flow).
- **An external pilot.** A small group using its existing workflow, with the improvement that counts (reconstruction time, rework, false alarms) and the acceptable added burden declared before it starts.

## Open

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
| D2 | Deployed multi-tool, multi-session participation proof | Now | Core journey and hosted fork cleanup verified; response loss, revocation and a second physical machine remain |
| M1 | Authority changes during operations | Now (with D2) | Open |
| D4 | Existing-repository onboarding | Next | Open; depends on E1 for history import |
| R1 | Name the accepted revisions a proposal is missing | Next | Open |
| R2 | Reconciliation provenance | Next | Open |
| E2 | Stable, documented MCP/HTTP contract | Next | Compatibility rules documented; error semantics and idempotency remain |
| C4 | Relationship hints beyond paths | Later | Evidence-gated |
| M2 | Workspace hand-off between developers | Later | Open |
| M3 | Review requests and reviewer roles | Later | Evidence-gated |
| M4 | Namespace-wide view of concurrent work | Later | Evidence-gated |
| M5 | Caps on live namespace resources | Later | Evidence-gated |
| E1 | GitHub/GitLab upstream: explicit import, divergence, publication of approved revisions | Later (Next if D4 shows adoption needs it) | Open |
| E3 | Use from external orchestrators | Later | Open |
| E4 | Downstream revision provenance for CI/release systems | Later | Open |
| E5 | Push-based console updates | Later | Measured need only |

### Developer workflow

**D2 — Deployed participation proof.** The core journey passed on 2026-10-06: Claude Code and Codex in separate workspaces, detach and continuation in another checkout by another tool, stale detection, reconciliation and two human promotions, judged by a read-only auditor ([evidence](docs/local-verification.md#deployed-multi-tool-participation-d2)). Fork cleanup with retained-source proof passed on the hosted binding on 2026-10-09 ([evidence](docs/local-verification.md#retained-source-proof-on-cloudflare-artifacts)). *Remaining:* response loss, membership and grant revocation (M1), and a physically separate machine. Client labels alone do not count as tool participation.

**D4 — Existing-repository onboarding.** A developer's `~/projects/app` with `origin → GitHub` should gain a Cruce remote and workspaces without changing `origin`, and without having to "move development into Cruce." Attaching today requires a checkout that contains the canonical baseline. History import from a forge is E1.

### Coordination

**C4 — Relationship hints.** Evidence-gated. Require **two independently reviewed, reproducible real interactions missed by path overlap**, identifying exact revisions, disjoint paths and consequences, and measure observation delay, unknown comparisons, coordination effort, false alarms and misses. Synthetic examples alone cannot unlock the gate. Those cases determine the smallest symbol, module or dependency hint worth building. Hints never grant authority or claim compatibility.

### Review and reconciliation

**R1 — Missing accepted revisions.** Review already compares a change since its last review and against current canonical, with canonical's files set apart. Also name the accepted revisions that landed between the proposal's base and current canonical.

**R2 — Reconciliation provenance.** When a workspace publishes a revision that merges accepted canonical source, record which accepted revisions it incorporated, from Git ancestry, so lineage answers "what did this reconciliation include?"

### Multi-user collaboration

**M1 — Authority changes.** Verify and define behavior for membership, grant and scope revocation between steps and during an in-flight provider operation.

**M2 — Hand-off.** Transfer workspace ownership to another developer with an explicit, recorded, authorized transfer. [ADR 0002](docs/decisions/0002-workspace-ownership-and-execution-attachment.md) deliberately excludes this for now.

**M3, M4.** Review notes let any repository writer raise concerns on exact lines ([ADR 0014](docs/decisions/0014-review-notes-on-exact-revisions.md)); requesting review from specific humans, and seeing concurrent work across a namespace's repositories, wait until shared-namespace use shows the need.

**M5 — Live resource caps.** [ADR 0008](docs/decisions/0008-remove-daily-operation-budget.md) removed the daily operation budget. If unbounded growth becomes a real problem, cap live repositories or workspace forks per namespace instead of daily activity.

### Ecosystem

**E1 — Upstream forges.** Explicit import (Artifacts public-HTTPS import; private repositories need a separately validated GitHub App installation transport), external divergence inspection, reconciliation, and publication of exact approved revisions or PR links. One canonical authority inside Cruce. No silent bidirectional sync. Stable external identity. Tokens never in persistent remotes.

**E2 — Contract stability.** [Interface compatibility](docs/releases.md#interface-compatibility) defines versioning and breaking changes for the MCP catalog, console API and bridge. Still to document: error semantics and idempotency, so tools and orchestrators can depend on them without special cases.

**E3 — Orchestrators.** Show an orchestrator (for example a relay or agent framework) creating, continuing and publishing workspaces through MCP/API with no Cruce-side special casing.

**E4 — Downstream provenance.** A read API, or portable Git notes if justified, that lets CI/release systems ask which proposal, reviews and human approval produced a canonical revision. Cruce never runs those systems.

**E5 — Live updates.** The console polls snapshots every 15 s. Use hibernating WebSockets only if measured latency or fan-out justifies them. Delivery never implies attention.

## Done

Finished items stay listed so their IDs keep their meaning. What each covers and how it was verified lives in [verification](docs/local-verification.md) and the [architecture](docs/architecture.md); hosted acceptance that is still missing is part of the readiness gates above.

| ID | Item |
| --- | --- |
| F1 | Promotion against the exact approved base |
| F2 | Durable provider ownership and identity |
| F3 | Pure coordination reads |
| F4 | Bounded source inspection and recoverable cache |
| F5 | Diagnosable operations and safe errors |
| F6 | Bounded state, transfers and explicit retention operations |
| D1 | Continue a workspace across sessions, tools and machines |
| C1 | Observed pushed revisions and canonical movement |
| C2 | Staleness and reconciliation view |
| C3 | Report freshness separate from presence |
| R3 | Publication recovery parity with promotion |

## Removed from the roadmap

Removed by [ADR 0001](docs/decisions/0001-product-boundary-reset.md) as outside the product boundary or not product capabilities. Do not reintroduce them without a new decision record.

- Automatic sequencing and opt-in agent pause/resume.
- Decision delivery, acknowledgement, intent/dependency reports and the agent "interaction contract."
- Business analytics pipelines.
- Workflows, ArtifactFS or other infrastructure as product items. Infrastructure is chosen when a concrete operation needs it.
- Any agent launching, hosting, messaging, scheduling or conversation storage.
- CI/CD, build, deployment, environment, rollout or runtime capabilities.

## How value is validated

Cruce's value appears at scale, so it is validated at scale. Scenarios include at least three concurrent workspaces from at least two different tools. One workspace is continued after a session restart and from a second checkout or machine. Canonical advances while other work continues. Overlapping and non-overlapping work, a clean merge that fails behaviorally, asynchronous review, and stale-proposal detection with reconciliation are all exercised. Later scenarios add a second developer.

Predeclare the measures and thresholds:

- time spent reconstructing state by hand (comparing branches, asking which revision is where);
- rework from late-discovered overlap or stale baselines;
- approvals or promotions of an unintended revision, which must be zero;
- setup and reporting burden, false alarms and misses;
- hosting cost and delay.

Count deliberate review separately from routine coordination. If value concentrates in one area (for example continuation and provenance rather than overlap), narrow the product there. If friction dominates, simplify before adding capability. No metric justifies weakening human review or source safeguards.

## Open feasibility questions

Hosted Artifacts subscription privileges, event latency and recovery remain acceptance checks; event ordering and historical replay are not assumed. Private-import transport remains unresolved. Resolve them with current primary documentation and bounded verification before choosing a mechanism. Record an unknown rather than inferring a guarantee from an example.
