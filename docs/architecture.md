# Architecture

Cruce is Cloudflare-native: one Worker (API + static Radar UI), one Durable Object per project as the
authoritative control tower, a Workflow per live Flight, a container Sandbox per live Flight, Artifacts
for every repository, and Queues event subscriptions for repository events.

```
                         ┌───────────────────────────── Cloudflare ──────────────────────────────┐
 Radar (React Flow+ELK) ─┼─ WebSocket ─┐                                                         │
 runner / MCP / agents ──┼─ HTTPS ─────┤   Worker (router, auth, queue consumer)                 │
                         │             ▼                                                         │
                         │   ControlTower DO  (one per project — authoritative)                  │
                         │     Controller (src/core: matrix, graph, right-of-way, leases, gate)  │
                         │     Tower runtime: provision · publish gate · preflight · land · refresh
                         │     SQLite: state, audit log, bare Git workspace (isomorphic-git)      │
                         │        │  fork / tokens / log          ▲ repo.* / pushed / token.*    │
                         │        ▼                               │                              │
                         │   Artifacts  cruce/auth-service  ── cruce/auth-service--f021 … (forks) │
                         │        ▲  60 s write token per push (Cruce only)                     │
                         │        │                                                              │
                         │   FlightWorkflow (per live Flight) ──► FlightSandbox DO + container   │
                         │        waitForEvent(tower-wake, agent-*)       Claude Code             │
                         │                                   egress ──► Outbound (policy)        │
                         └────────────────────────────────────────────────────────────────────────┘
```

## Components

| Component | Where | Responsibility |
|---|---|---|
| Controller | `src/core/controller.ts` | Pure state machine. Commands (submit plan, request airspace, publish, land, override, tick) produce a new state and explained events. Time is injected; no I/O. |
| Clearance engine | `src/core/traffic.ts` | Pairwise conflict matrix → right-of-way → waits-for graph → deadlock breaking → per-Flight clearance (cleared / held / land-after) and congestion records with "why" and a traffic plan. Recomputed after every command. |
| Structural index | `src/intelligence/structural-index.ts` | `@babel/parser` over TypeScript: modules (from `cruce.json`), files, classes, members, functions, line ranges (incl. doc comments), resolved imports. |
| ControlTower DO | `src/worker/control-tower.ts` | One per project. Hosts the controller, persists state + audit log in SQLite, serves WebSockets (hibernation), drives the demo clock with alarms, routes Artifacts events, wakes live Flight workflows. |
| Tower runtime | `src/worker/tower.ts` | Controller + Git: provision forks, publish gate end to end, preflight, landing merges with notes, baseline refresh, reset. Runtime-agnostic (tests run it on an in-memory filesystem). |
| Project Git | `src/worker/project-git.ts`, `src/worker/git/*` | A bare isomorphic-git workspace on DO SQLite (`SqlFs`). Canonical at `refs/heads/main`, each Flight at `refs/heads/flights/<id>`; Artifacts repos are remotes. Commits are built from trees; merges are real three-way merges; notes on `refs/notes/cruce`. |
| Artifacts host | `src/worker/artifacts-host.ts` | Binding wrapper: create/fork (and immediately revoke the returned long-lived tokens), 60 s tokens per Git operation, read tokens for sandboxes. |
| Event subscriptions | `src/worker/event-subscriptions.ts` | Per-repo `artifacts.repo` subscriptions (pushed, token.created, token.revoked) → queue → Worker → ControlTower (idempotent). |
| Agent protocol | `src/worker/protocol.ts` | status · plan · amend · request · activity · heartbeat · publish · validate · land · checkout · refresh · fail. Provider-neutral; an MCP adapter maps 1:1. |
| FlightWorkflow | `src/worker/agents/flight-workflow.ts` | Durable lifecycle of a live Flight: provision → sandbox → discovery → plan → hold/wait → execute → gate → tests → land; re-plan when stale. |
| FlightSandbox | `src/worker/agents/flight-sandbox.ts` | Container DO per Flight: clone (read-only), run Claude Code in the background, collect changes, run tests, resync to Cruce's commit. Heartbeats leases while the agent works. |
| Outbound | `src/worker/agents/outbound.ts` | Sandbox egress policy: protocol for its own Flight only; read token injected for `git-upload-pack` on its own repo; `receive-pack` refused; model key injected; everything else 403. |
| External runner | `runner/cruce-runner.ts` | Same lifecycle from a developer machine with the local `claude` CLI and a restricted tool allowlist. |
| Radar | `src/ui/*` | React Flow + ELK airspace map, Flight list, context panel (Flight / congestion / resource), tower log, Git history with notes. |

## Key decisions

- **One Durable Object per project is the single authority.** All coordination state changes happen in one
  synchronous `mutate()`; Git work happens outside it and its results are applied in a later mutate. No
  distributed coordination bugs.
- **Cruce is the only writer to Artifacts.** Agents submit changes; Cruce rebuilds the commit (same id when
  the agent supplies its metadata), runs the publish gate on the *real* diff, then pushes with a 60 s token
  that is revoked immediately. Sandboxes get read access through the egress policy and never see a token.
- **Git in the control plane.** isomorphic-git on Durable Object SQLite gives Cruce a persistent object
  database: fetches are incremental, preflight is a non-destructive three-way merge, landing is a real
  merge commit, notes carry context. A `local` backend uses the same code with no remotes (offline demo).
- **Babel instead of tree-sitter in the Worker.** Tree-sitter grammars are Wasm side modules that Workers
  cannot compile at runtime; ast-grep is native. `StructuralIndexer` is an interface so a tree-sitter /
  ast-grep indexer can run in the Sandbox for other languages.
- **Workflows for live Flights, alarms for the demo.** The demo is a deterministic script stepped by DO
  alarms (pause/step/speed for video). Live Flights are long-running and failure-prone, so they run as
  Workflows and wait with `waitForEvent` (no polling while held).
- **Namespaces separate environments**: `cruce-dev` (local) and `cruce` (production).

## Data model (abridged)

`Mission` → `Flight` (phase, plan, planHistory, artifact, stale, publishes, leases) → `FlightPlan`
(readSet, writeSet, contractSet, dependencies, assumptions, risk, amendment) → `TrafficPicture`
(congestions, clearances, edges, deadlocks, landingOrder, attention, occupancy). See `src/core/domain.ts`
and `src/core/traffic.ts`.

## Failure handling

| Situation | Behaviour |
|---|---|
| Agent crash / silence | Leases expire after 10 min without heartbeat → Flight LOST → leases released → dependents re-evaluated (`Controller.tick`). |
| Sandbox failure | Workflow step retries; the Flight's Artifacts repo is preserved; on final failure the Flight is FAILED with the reason. |
| No Flight Plan | Discovery timeout (30 min) → plan-timeout attention, Flight failed, no code executed. |
| Route expansion | Publish gate rejects with the out-of-clearance symbols; the agent amends (request airspace) or reverts. Three rejections escalate to a human. |
| Dependency failure | Flights that declared a dependency on a failed Flight raise attention. |
| Git conflict | Preflight reports conflicting paths; the Flight is not landed; attention raised. |
| WebSocket drop | The client reconnects with backoff and receives an authoritative snapshot. |
| Duplicate Artifacts event | Deduplicated by (type, repo, after/tokenId, timestamp); push recording is idempotent per commit. |
| Deadlock | Tarjan SCC detection; the highest-priority, earliest-filed Flight gets right-of-way in the cycle; flagged for review. |
