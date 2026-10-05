# Product

[Documentation map](../README.md#documentation-map) · [Domain model](domain-model.md) · [Principles](principles.md) · [Roadmap](../ROADMAP.md)

This is the authoritative statement of what Cruce is, why it exists and what it deliberately does not do. The [domain model](domain-model.md) defines the concepts; the [principles](principles.md) turn this boundary into review rules; the [architecture](architecture.md) describes the current implementation. [ADR 0001](decisions/0001-product-boundary-reset.md) records the reset that established this direction and what it superseded.

## Thesis

**Cruce is Git coordination for parallel agentic development.**

It is the durable coordination plane for Git work produced by many independent actors: Claude Code, Codex, Cursor, other coding agents, scripts, orchestration frameworks and human developers. Cruce does not run that work. It gives the work a durable identity, an exact starting point, an observable relationship to other concurrent work, and a reviewed, human-approved path into canonical Git.

> Cruce coordinates durable concurrent Git work; other systems execute the work.

Put differently: Cruce lets agents work in parallel without Git itself becoming the coordination problem.

## Vision

Agents, agent sessions, terminals, local worktrees and machines are transient. Agent vendors are interchangeable. The work they produce is not transient. It needs an identity that outlives any session, a known starting revision, retained history and a way to converge with everything else being changed at the same time.

When Cruce succeeds, developers can let many independent humans and agents work concurrently without keeping the repository's reconciliation state in their heads. They still use Git, their preferred agents, their editors and their CI/CD systems. Cruce gives all of that concurrent work one durable coordination layer.

## The problem

One developer running a few agents on one machine is already well served. Git branches, Git worktrees, Claude Code, Codex and Cursor worktree modes, local multi-agent frameworks, relay tools and shell scripts all isolate and run local work. **Cruce does not claim that local multi-agent execution is a problem only it can solve, and it does not try to solve it.**

The difficulty grows along a different axis:

```text
agents × developers × machines × concurrent workstreams × duration
```

As that product grows, the developer becomes the coordination system. They track which terminal started from which commit, which branches overlap, which work is stale because canonical moved, which revision a reviewer actually inspected, whether the approved revision is the one that landed, and whether yesterday's work on another machine can be continued. None of that state is durable. It sits in terminals, local paths, branch names and memory, and it disappears when a session ends or a laptop closes.

Git records what happened. It does not record that a stream of work exists, where it started, who or what is advancing it, how it relates to other in-flight work, or which exact revision a human approved for canonical. Those are Cruce's concerns.

## Who it is for

A single developer, one agent and one task may get little from Cruce. That is acceptable; the product is not distorted to capture that case.

Cruce becomes more valuable when:

- several agents or developers work on the same repository at the same time;
- work lives for hours or days, across sessions and machines;
- different tools perform different parts of the work;
- canonical moves while other work continues;
- review happens asynchronously and must refer to exact revisions;
- many independent revisions must eventually converge safely.

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
Canonical Git (Cloudflare Artifacts) ⇄ upstream forge (GitHub, GitLab, …)
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

Every Cruce repository has a canonical Git repository in Cloudflare Artifacts, and each writer workspace owns a direct fork of it. Cruce controls that surface: it can pin baselines, give each workspace an independently addressable remote, issue short-lived scoped credentials, retain exact source and promote with a non-forced Git update. GitHub or GitLab may remain the public or organizational repository; the [domain model](domain-model.md#canonical-repository-and-upstream) describes that relationship. Using Cloudflare is not, by itself, differentiation. Requiring a connected account and a new canonical remote is an adoption cost the product must earn.

## Alternatives and risks

Primary documentation was checked on **2026-10-06**. These are documented capabilities, not hands-on comparisons.

| Alternative | What it already provides | Implication for Cruce |
| --- | --- | --- |
| [Git worktrees](https://git-scm.com/docs/git-worktree), [Codex](https://learn.chatgpt.com/docs/environments/git-worktrees), [Cursor](https://cursor.com/docs/configuration/worktrees) | Local isolation for parallel agents | Complements, not competitors. Cruce must not re-implement local isolation as its value |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams), Agent Relay, [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Agent messaging, shared tasks, delegation, advisory file leases | A different layer. Cruce should be usable underneath them, not compete as an inbox or scheduler |
| [Conductor](https://www.conductor.build/docs), [GitButler](https://docs.gitbutler.com/ai-agents/parallel-agents) | Local multi-agent workspaces with review flows | Strong for one developer on one machine; Cruce's ground is durable, cross-machine, cross-developer and cross-vendor coordination |
| [GitHub agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents), [merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-merge-queue), [Graphite](https://graphite.com/docs/graphite-merge-queue) | Forge-hosted agents, review and integration validation | Cruce coordinates concurrent work before it becomes forge history; it does not duplicate merge queues |

The largest risks are adoption friction (a connected account and an extra remote), sparse or noisy observations, agents that ignore coordination context, and incumbents bundling enough of this. The product must show reduced reconciliation effort and rework at the scale it targets. See [how the roadmap validates value](../ROADMAP.md#how-value-is-validated).
