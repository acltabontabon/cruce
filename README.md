# Cruce

Cruce is a **Git-native coordination and convergence layer for concurrent coding agents**.

**Git records what happened. Cruce coordinates what is happening.** Independent agents keep their own tools and local environments. Cruce connects their durable workspaces through shared awareness, exact source provenance, intentional reconciliation and human-governed canonical promotion.

Branches, worktrees and forks already provide isolation. Cruce must earn its place by helping independent participants understand interacting work and canonical movement early enough to reduce avoidable rework. The complete lifecycle is the product, not a conflict warning or an agent launcher.

The implemented foundation provides cooperative path reports, accepted-source comparisons, durable workspace forks, exact-revision retention, review and promotion. Observed push events, independently fresh convergence evidence and proven context consumption across tools are gaps. Automatic sequencing and supported pause/resume are exploratory. See the [product thesis and competitive assessment](docs/product-thesis.md) and [implementation audit](docs/architecture.md#implementation-audit).

```mermaid
flowchart TB
    A[Agent in tool A] --> WA[Durable workspace A and isolated checkout]
    B[Agent in tool B] --> WB[Durable workspace B and isolated checkout]
    WA <-->|Git and MCP| C[Cruce control plane]
    WB <-->|Git and MCP| C
    C --> O[Current: shared reports and canonical context]
    O -.-> E[Proposed: observed activity and convergence evidence]
    C --> R[Exact source retention and human review]
    R -->|Readiness and explicit promotion| G[Canonical Git in Cloudflare Artifacts]
    G --> F[Continuing writers incorporate and verify]
    F --> C
```

Solid links show implemented mechanisms, subject to the [audit's correctness gaps](docs/architecture.md#architecture-contradictions-and-correctness-gaps); dashed links are proposed. Overlap is advisory, not a semantic conflict or compatibility guarantee. Cruce does not launch agents or require scheduling clearance for local edits.

## Git stays Git

> If Git already has a primitive for something, Cruce should use Git instead of inventing another one.

Keep using `git clone`, `git fetch`, `git pull`, `git push`, `git commit`, `git branch`, `git diff` and `git log`. Cruce adds participation, authorization, shared observations and revision-bound decisions. It does not add a replacement Git command language.

The ownership model is **Namespace → Repository → Workspace**. A namespace owns access and budgets. Every repository has an authoritative canonical Git repository backed by Cloudflare Artifacts. Each writer workspace owns one reusable direct fork of canonical and records an actor, task and immutable starting commit. An agent may participate in many workspaces; the workspace owns its fork, not the vendor. A worktree or clone is its local execution context, not its durable identity. Existing checkout attachment preserves remotes and never silently uploads history.

Normal pushes go to the writer's fork. Publication retains an exact pushed revision as a Cruce source artifact, distinct from the Cloudflare Artifacts provider. Evidence records revision-linked claims/results separately. Publication proves which source was retained, not that it is correct; human-approved, controller-gated promotion advances canonical source. Cruce’s responsibility ends when isolated concurrent work is safely reviewed and reconciled into the canonical Git repository. CI, build/release orchestration, deployment, environment management, rollback and runtime operation belong to external systems. See the [architecture](docs/architecture.md) for the complete flow and its trust boundaries.

## Try the local console

Use Git, Node 22.18+ and pnpm (CI uses Node 24 and pnpm 12.4.2):

```sh
pnpm install --frozen-lockfile
pnpm dev:fixture
```

Open the printed loopback URL. The fixed-clock fixture uses the real console and controllers with deterministic Git source; identity and provider behavior are simulated. It does not connect to live namespaces or consume cloud resources.

Follow the [local console walkthrough](docs/local-demo.md) for screenshots and a guided tour of the sample workspaces, review, published revisions and evidence views.

To use Cruce with real repositories, follow [Git and bridge setup](docs/native-setup.md). Hosted repositories require a namespace's explicitly connected Cloudflare account and consume resources. Cloud hosting does not imply cloud execution of agents.

## Status

Cruce is early, experimental software, and its name remains provisional. Local controller, Git, bridge and browser evidence exists. A real-Artifacts two-writer convergence scenario passed with fixture authority; newer deployed checks exercised owner setup, canonical provisioning and a repaired consent form. Authenticated publication/promotion and actual two-tool participation remain unverified. [Verification](docs/local-verification.md) records the precise revisions and limits; these separate checks were not performed by the documentation audit.

The [architecture audit](docs/architecture.md#implementation-audit) identifies expected-base promotion races, incomplete provider identity checks and account-binding recovery as corrections needed before a credible end-to-end proof. This documentation pass does not fix those runtime gaps.

The proposed first pilot uses one developer, one repository, Codex and Claude Code, subject to demonstrated integration support. It must show reduced routine intervention, duplicated effort and integration rework against ordinary worktrees and Git review, within predeclared limits on delay, reporting effort, cost and quality. The [roadmap](ROADMAP.md#how-we-choose-what-to-build) includes failure and simplification criteria; product value and cross-tool context consumption remain unproven.

Cruce is not a Git/Git-worktree replacement, a Claude Code worktree manager, a GitHub/GitLab clone, a remote IDE, a cloud coding environment, an agent runtime, a general agent orchestrator or a CI/CD replacement. Its scope is coordination of concurrent repository work. See [product boundaries](docs/product-thesis.md).

## Documentation map

| I want to… | Read |
| --- | --- |
| Understand the problem, audience and scope | [Product thesis](docs/product-thesis.md) |
| Explore the development console with screenshots | [Local console walkthrough](docs/local-demo.md) |
| Make or review an architectural decision | [Principles and guardrails](docs/principles.md) |
| Understand ownership, source convergence, implementation gaps and Cloudflare fit | [Architecture and audit](docs/architecture.md) |
| Connect a checkout and participate | [Git and bridge setup](docs/native-setup.md) |
| Integrate an agent or change the tool surface | [MCP and agent participation](docs/mcp.md) |
| Develop and verify a contribution | [Contributing](CONTRIBUTING.md), [verification](docs/local-verification.md) |
| Configure hosted resources | [Cloudflare setup](docs/cloudflare-setup.md), [test environment](docs/test-environment.md) |
| Explore future ideas | [Future direction and ideas](ROADMAP.md) |
| Work as a coding agent in this repository | [AGENTS.md](AGENTS.md) |
| Inspect change history or release procedures | [Changelog](CHANGELOG.md), [releases](docs/releases.md) |

Principles state the constraints; architecture describes the current design; the roadmap contains future candidates; verification records evidence; the changelog summarizes changes. Git history preserves implementation history. A historical success or future plan is not evidence of a current capability.
