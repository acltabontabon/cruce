# 0001 — Product boundary reset

**Status:** Accepted, 2026-10-06 · **Owners of the resulting state:** [product](../product.md), [domain model](../domain-model.md), [principles](../principles.md), [roadmap](../../ROADMAP.md)

## Context

Cruce was framed as a "Git-native coordination and convergence layer for concurrent coding agents." Its value hypothesis centred on in-flight awareness between agents. The exploratory track included automatic sequencing, opt-in agent pause/resume, decision delivery and acknowledgement, and structured intent reports. Product proof was gated on matched trials of one developer running Codex and Claude Code on one repository.

That framing invited drift toward a local multi-agent orchestrator. A single developer on one machine is already well served by Git worktrees, the worktree modes in Claude Code, Codex and Cursor, local agent frameworks and relays. Cruce is not uniquely valuable for local execution, and it should not compete there.

## Decision

1. **Thesis.** Cruce is Git coordination for parallel agentic development: the durable coordination plane for Git work produced by many independent, interchangeable actors. *Cruce coordinates durable concurrent Git work; other systems execute the work.*
2. **Boundary.** Cruce owns workspace identity, baselines, forks, pushed and published revisions, provenance, concurrency visibility (overlap, divergence, staleness), reconciliation, exact-revision review, human approval, promotion and history. It is not an agent runtime, scheduler, conversation manager, messaging bus, IDE, Git replacement, forge replacement, CI/CD system, cloud development environment or agent vendor platform. See [product non-goals](../product.md#non-goals-and-product-boundaries).
3. **Boundary test.** A capability belongs in Cruce only if it becomes materially more valuable because of durable, remotely observable, independently addressable Git workspaces and canonical revision history.
4. **Target scale.** Value grows with agents × developers × machines × concurrent workstreams × duration. The single-developer, single-agent case is explicitly not a design target.
5. **Composition.** Orchestrators and relays sit above Cruce and may use it through MCP or the API. The model stays agent-neutral.
6. **Primitives before intelligence.** Exact revisions, baselines, refs, forks, paths, diffs, provenance and approval state come first. Prediction, semantic analysis, dependency graphs and sequencing are deferred.
7. **Human authority.** Canonical promotion stays an explicit, authenticated human decision about an exact revision.

## Superseded

| Previous decision or framing | Replacement |
| --- | --- |
| "Coordination and convergence layer for concurrent coding agents"; value centred on agents noticing each other in flight | Durable Git coordination plane; value centred on durable identity, exact revisions, reconciliation and promotion across sessions, machines, tools and developers |
| Exploratory automatic sequencing and opt-in agent pause/resume (former principles §5, roadmap Exploratory) | Removed. Cruce does not control agent execution |
| Proposed decision delivery, acknowledgement, intent/dependency reports and the "interaction contract" (former roadmap P1.2 and interaction contract, MCP "proposed coordination integrations") | Removed. Messaging and acknowledgement belong to agent frameworks; Cruce exposes recorded state |
| First audience and value gate: one developer, one repository, Codex and Claude Code | Validation at the target scale: concurrent workspaces across sessions, tools, machines and, later, developers ([roadmap](../../ROADMAP.md#how-value-is-validated)) |
| Workspace owned by one actor connection with an immutable execution context | [ADR 0002](0002-workspace-ownership-and-execution-attachment.md) |
| `get_context`: base-revision instruction files plus a Babel structural index delivered to agents | Removed. Agents read files at a revision with Git. Structural analysis is deferred |
| Read-only "observer" workspaces | Removed. Reading needs a Read grant, not a workspace |
| `report_ref` claims and the observed-refs store | Removed. Pushed revisions are observed from the fork; event-based observation is on the roadmap |
| Business analytics, Workflows and ArtifactFS as product roadmap items | Removed from the product roadmap; infrastructure choices are made when a concrete need arises |

## Alignment audit (Phase 2)

Inspected: README, AGENTS.md, CONTRIBUTING, ROADMAP, every document under `docs/`, `src/shared`, `src/core`, `src/worker`, `runner`, `src/intelligence` and `src/ui` at commit `923644d`.

**Aligned and foundational.** The Namespace → Repository → Workspace hierarchy, stable IDs and the Directory/Namespace/Repository Durable Object split. Canonical Artifacts repositories, reusable direct writer forks and pinned baselines. The normal Git smart-HTTP gateway with short-lived scoped tokens. Exact-revision publication with ancestry checks. Separate source and evidence records. Proposals, reviews, controller readiness and human-only promotion with the exact-base journal. Advisory path overlap with honest trust labels. Canonical divergence (`get_workspace_updates`). Guarded fork cleanup. Lineage. Namespace budgets. The local bridge's worktrees, unique remotes, persistent locks and preservation of existing remotes. Explicit removal of deployments and CI.

**Partially aligned.**
- The workspace was durable on the server but bound in practice to one agent OAuth connection (`agent-<connectionId>`) and one immutable execution context. Each `cruce mcp` process created fresh workspace state. So a workspace could not outlive its agent session, move to another machine, or continue in another tool.
- Presence was folded into the workspace state enum.
- The `context` field named free-form description and collided with agent-context language.
- Agent-first sorting and "N agents working" in the console privileged one actor kind.
- The bridge instructions told agents to call `get_context` for instructions.

**Contradicting the boundary.**
- Roadmap and principles carried agent pause/resume, automatic sequencing, decision delivery and acknowledgement. These are execution and messaging concerns.
- The homepage illustration told a story of "agents align" and agents exchanging context, which implies a messaging bus.
- `get_context` delivered instruction files and a structural index to agents. That is agent-runtime feeding plus premature intelligence.
- `report_ref` kept a parallel store of unverified ref claims beside Git.
- Read-only workspaces modelled presence sessions as work.

**Unnecessary now.** The Babel structural index and its `@babel/parser` dependency. Business analytics, Workflows and ArtifactFS roadmap items. The single-developer matched-trial gate as the definition of product proof.

## Keep / change / remove / defer (Phase 6)

| Capability | Decision | Reason |
| --- | --- | --- |
| Namespace / Repository / Workspace, stable IDs, DO ownership split | **KEEP** | Core of the durable model |
| Canonical Artifacts repo, direct reusable forks, pinned baseline (`cruce-base`) | **KEEP** | The durable, addressable surface Cruce controls |
| Git gateway, credential helper, 60 s tokens | **KEEP** | Git stays Git; credentials stay server-side |
| Publication, source/evidence artifacts, ancestry checks | **KEEP** | Exact-revision retention and provenance |
| Proposals, reviews, readiness, human promotion with exact-base journal | **KEEP** | Reconciliation and human authority |
| Advisory path overlap, canonical divergence | **KEEP** | Boring, honest concurrency primitives |
| Fork cleanup guards, local cleanup checks | **KEEP** | Conservative retention |
| Lineage, activity | **KEEP** | Historical traceability |
| Local bridge worktrees, unique remotes, locks, reservations | **KEEP** | Local execution model without owning execution |
| Human terminal pairing | **KEEP** | Human participation in one workspace, never promotion authority |
| Client configuration writers for Codex / Claude Code / Cursor | **KEEP** as convenience | Outside the domain model; confers no authority |
| Workspace ownership by actor connection | **CHANGED** → owner user + creating actor | [ADR 0002](0002-workspace-ownership-and-execution-attachment.md) |
| Immutable execution context | **CHANGED** → replaceable attachment with `detach_workspace` and a `detached` state | Continuation across sessions, tools and machines |
| Reports not tied to an execution | **CHANGED** → `heartbeat`/`report_change` name the attached execution | Reports describe one checkout; stale bridges cannot overwrite them |
| `cruce resume` only for prepared workspaces | **CHANGED** → `cruce resume --workspace ID` continues from the pushed fork head; `cruce detach` added | Workspace ≠ checkout |
| Workspace `context` field | **CHANGED** → `description` | Terminology discipline |
| Bridge instructions, MCP server instructions, homepage narrative, console actor emphasis | **CHANGED** | Remove orchestration and messaging implications; stay agent-neutral |
| Read-only observer workspaces (`mode`) | **REMOVED** | Not Git work; reading needs no workspace |
| `report_ref`, `RefObservation`, observed-refs panel, `cruce report-ref` | **REMOVED** | Unverified pseudo-ref store duplicating Git |
| `get_context`, `src/intelligence`, `@babel/parser` | **REMOVED** | Agent instruction delivery and premature intelligence |
| Pause/resume, sequencing, decision/acknowledgement protocol, analytics, Workflows/ArtifactFS roadmap items | **REMOVED** from roadmap and docs | Outside the boundary or not product capabilities |
| Event-observed pushes and canonical movement | **DEFER** (roadmap: coordination, next) | Highest-value coordination signal; needs account-crossing feasibility work |
| Provider identity on every operation; account binding after disconnect | **DEFER** (roadmap: foundation, now) | Known correctness gaps, unchanged by this reset |
| Strictly pure coordination reads | **DEFER** (roadmap: foundation) | Routing still writes Directory and initialization metadata |
| Workspace hand-off between developers | **DEFER** (roadmap: multi-user) | Needs an explicit transfer authority model |
| Forge import / approved-revision publication | **DEFER** (roadmap: ecosystem) | Adoption path; one canonical authority |
| Symbol or structural overlap, dependency hints | **DEFER** (roadmap: later) | Only after primitives prove insufficient |

## Consequences

- Product documents, principles, MCP guidance and the roadmap were rewritten to this boundary. Superseded instructions were deleted rather than kept beside the new ones.
- MCP and API contracts changed incompatibly: removed tools and fields, new `detach_workspace`, required execution identity on reports, workspace `ownerId`/`createdBy`/`description`. There is no compatibility layer. Early-stage repository state in development environments is not migrated.
- Value must be shown at the scale Cruce targets, not by out-competing local orchestrators on a single machine.
