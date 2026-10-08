# Product

[Documentation map](README.md) · [Domain model](domain-model.md) · [Principles](principles.md) · [Roadmap](../ROADMAP.md)

This is the authoritative statement of what Cruce is, why it exists and what it deliberately does not do. The [domain model](domain-model.md) defines the concepts; the [principles](principles.md) turn this boundary into review rules; the [architecture](architecture.md) describes the current implementation. [ADR 0001](decisions/0001-product-boundary-reset.md) records the reset that established this direction and what it superseded.

## Thesis

**Cruce is Git coordination for parallel agentic development.** It gives independent Git work a durable identity, exact starting revision, visibility into concurrent work and a reviewed, human-approved path into canonical Git. Other systems execute the work.

## Vision

Work should outlive the session, tool, checkout or machine that produced it. Developers keep Git, their agents, editors and CI/CD; Cruce retains the coordination state needed to continue and reconcile concurrent work.

## The problem

As work spans developers, tools, machines and days, people must track baselines, overlap, stale revisions, reviewed commits and what actually landed. Local worktrees isolate files; they do not provide Cruce's shared durable workspace identity, revision-bound decisions and retained provenance.

## Who it is for

Teams or individuals with several concurrent workstreams, asynchronous review, changing canonical history, or work continued across sessions and tools. A single short-lived task may gain little; the product does not need to serve every local execution case.

## What Cruce owns

Cruce answers questions such as:

| Question | Cruce concept |
| --- | --- |
| What exact canonical revision did this workspace start from? | Workspace baseline |
| What work is happening concurrently, and who or what is advancing it? | Workspaces, execution attachments, provenance |
| What revision has a workspace actually pushed, and what changed since its baseline? | Workspace fork, published revisions, diffs |
| Which repository areas appear to overlap? Which work is stale relative to canonical? | Concurrency view: path overlap, divergence |
| What exact revision is proposed, reviewed and approved? | Proposal, review, approval bound to a revision |
| Can these pieces of work be reconciled, and what blocks promotion? | Reconciliation and readiness |
| What revision reached canonical, and through which decision? | Promotion and provenance |
| Can another session, tool or machine continue this work? | Durable workspace identity, replaceable execution attachment |
| What happened to this work historically? | Lineage |

Every Cruce capability should become materially more valuable because Cruce has durable, remotely observable, independently addressable Git workspaces and canonical revision history.

## Non-goals and product boundaries

These boundaries are part of the product, not temporary scope cuts. Changing one requires an explicit architectural decision, not incremental feature drift.

| Cruce is not | Why | What Cruce does instead |
| --- | --- | --- |
| **An agent runtime** | Agents already run in their own tools and environments | Coordinates the Git work they produce, wherever they run |
| **An agent scheduler** | Deciding which AI process runs next is execution orchestration | Shows overlap, divergence and readiness; people and their tools decide what to do |
| **An agent conversation manager** | Prompts, chat history and agent reasoning belong to the agent tool | Records revisions, provenance and decisions, never conversations |
| **A multi-agent messaging bus** | Agent-to-agent communication is a different layer; tools such as Agent Relay already address it | Can be used *by* such systems through MCP/API |
| **An IDE or editor** | Development happens in the developer's editor | Read-only revision, diff and provenance inspection |
| **A replacement for Git** | Git is the protocol and data model underneath everything | Uses clone, fetch, pull, push, commit, refs and merge as they are |
| **A GitHub/GitLab replacement** | Forges remain the public and organizational collaboration systems | Coordinates concurrent work before it becomes upstream history |
| **CI/CD** | Builds, test infrastructure, releases, deployments, environments, rollout, rollback and runtime operations belong to dedicated systems | Records revision-linked evidence and exposes revision/provenance data for downstream systems |
| **A cloud development environment** | Codespaces-style hosting is a different product | Hosts Git coordination state, not development machines |
| **An agent vendor platform** | No vendor gets special architectural authority | Treats every tool as an authorized actor with a label, nothing more |

### The boundary test

For every proposed capability, ask:

> If replacing Cruce with local Git worktrees plus an agent orchestrator produces essentially the same capability, why does this feature belong in Cruce?

A Cruce feature should benefit from at least one of the following: durable remote workspace identity; independently addressable Git workspaces; coordination across machines, developers, agent vendors or long-running work; canonical repository awareness; baseline and revision tracking; provenance; concurrency visibility; reconciliation; review against exact revisions; approval; promotion; or historical auditability. If none apply, the capability probably belongs somewhere else.

## Composition with other tools

Cruce is composable by design. An orchestration framework, Claude Code, Codex, a developer's CLI session or a shell script can all use the same API and MCP surface. Cruce does not need to know which one it is talking to.

```text
Agent Relay / agent framework / IDE agent
        ↓  coordinates execution, communication, delegation
Cruce
        ↓  coordinates durable Git work, reconciliation and promotion
Canonical Git (Cloudflare Artifacts)
        ··· optional forge import / upstream publication: roadmap
```

### Integration philosophy

| Surface | Role | Rule |
| --- | --- | --- |
| **Git** | Source transport and history | Normal Git against canonical and workspace remotes; no proprietary pseudo-Git commands |
| **MCP** | Cruce coordination for agents | Exposes the Cruce model (workspaces, revisions, overlap, proposals, provenance), never generic Git, forge or agent-framework features. See [MCP](mcp.md) |
| **CLI / local bridge** | Local onboarding and execution attachment | Creates worktrees, configures remotes and credential helpers, and reports local state; never launches agents |
| **HTTP API and console** | Human visibility and decisions | Renders controller-derived state; humans approve and promote |
| **Agent frameworks and orchestrators** | Execution, delegation, messaging | Consumers of Cruce, not things Cruce replaces |
| **GitHub / GitLab** | Upstream and organizational collaboration | Explicit import and publication of approved revisions (roadmap); never silent bidirectional sync or a second canonical authority |
| **CI/CD and release systems** | Builds, checks, deployment | Downstream consumers of revision and provenance data; may supply evidence that Cruce records as reported |

Client-specific setup (for example writing an MCP configuration for Codex, Claude Code or Cursor) is a convenience. It never changes the domain model or confers authority.

## Product experience

A developer should be able to open Cruce and understand, without inspecting ten terminals or comparing branches by hand:

- what is happening, and who or what is working on it;
- where each piece of work started and what it has changed;
- what potentially overlaps and what is stale relative to canonical;
- what needs attention, what can be reviewed and what is blocked;
- what is ready to reconcile, which exact revision is being approved, and what reached canonical.

The console stays developer-native, Git-native, simple, legible and opinionated. It uses progressive disclosure rather than an enterprise dashboard of cards. It is technically honest: it labels reported claims as reported, shows unavailable data as unavailable, and never presents overlap as a verdict. The [design guide](design.md) owns visual rules.

## Honesty about what Cruce knows

Coordination is not omniscience. Cruce may report overlapping paths, overlapping symbols where confidently known, potentially related changes, divergence, stale baselines and likely reconciliation risk. It does not say that changes are safe to merge unless that is actually justified. Overlap is advisory: it is not scheduling clearance and not semantic correctness. A clean merge does not prove correct behavior.

Correctness and clarity come before cleverness. The early product is built from boring, trustworthy primitives: exact revisions, baselines, refs, forks, commits, paths, diffs, provenance, workspace relationships, reconciliation state and approval state. Conflict prediction, semantic analysis, dependency graphs and automatic sequencing are deferred until those primitives are solid. See the [roadmap](../ROADMAP.md).

## Human authority

Agents may inspect, propose, explain, prepare, reconcile, compute overlap and help resolve conflicts. Canonical promotion remains an explicit, authenticated human decision about an exact revision. Agent autonomy must not quietly become repository authority. Any future policy that changes this must be a deliberate architectural decision.

## Why Cloudflare Artifacts

Every Cruce repository has a canonical Git repository in Cloudflare Artifacts, and each writer workspace owns a direct fork of it. Cruce controls that surface: it can pin baselines, give each workspace an independently addressable remote, issue short-lived scoped credentials, retain exact source and promote with a non-forced Git update. GitHub or GitLab may remain the public or organizational repository; the [domain model](domain-model.md#canonical-repository-and-upstream) describes that relationship. Using Cloudflare is not, by itself, differentiation. The installation administrator configures Artifacts once through cf; namespace users inherit storage and do not connect Cloudflare accounts ([ADR 0003](decisions/0003-deployment-managed-storage.md)). A new canonical remote remains an adoption cost the product must earn.

## Alternatives and risks

Local Git worktrees and agent orchestrators already provide execution isolation. Forges provide review and merge queues. Cruce must earn its additional remote and setup cost through durable coordination across tools, developers and machines.

The main risks are adoption friction, sparse/noisy observations, clients ignoring context and existing tools supplying enough coordination. Validate reduced reconciliation effort and rework at the intended scale; see [value validation](../ROADMAP.md#how-value-is-validated).
