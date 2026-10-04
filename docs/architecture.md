# Native architecture — current direction

The latest product clarification supersedes the GitHub-first plan and the historical launcher model below. Cruce is a standalone agent-native platform. No GitHub App, external PR check, installation registry or GitHub sign-in participates in the native path.

```text
Human console / existing agent tools
       │ HTTPS + OAuth Streamable HTTP MCP / local stdio bridge
       ▼
Worker: identity + native system membership + typed command adapters
       │ immutable tenant/system identity
       ▼
ControlTower Durable Object: SystemRuntime + CoordinationRuntime
       │ pure PlatformController + WorkstreamController
       │ SQLite: intents, missions, sessions, plans, lineage, policy, IO tickets
       │ actual Git objects + parser indexes
       ▼
Cloudflare Artifacts
       ├ accepted system source
       ├ immutable baseline snapshots
       ├ one isolated fork per mission workstream
       └ versioned immutable evidence outputs
```

`SystemDirectory` stores native membership and immutable authority identities. Renames affect display metadata. Cloudflare Access JWTs are cryptographically validated; OAuth credentials grant machine contribution, never human promotion. Each request rechecks native membership.

Human and machine adapters call the same application commands. Durable workstreams outlive sessions. One writer executes per workstream; leases expire independently of source artifacts, publications and unresolved dependencies. Local Git assertions remain distinct from managed verified scope.

Source publication verifies exact Git objects and declared scope before a server-only short-lived token can push to the workspace. Unknown symbols may widen conservative scheduling but never grant write permission. Unsupported languages/parser failures retain file-level coverage.

Native collaboration is intent → mission → execution/workspace → immutable artifact → proposal → exact-revision verification/review → source promotion. Agents report evidence and independent agents review; only human maintainers promote. Policy changes invalidate old proposal readiness. Reviews preserve disagreement and explicit resolution. Prepared promotion tickets and fixed publication revisions survive retries. Promotion is a non-forced accepted-source advance, not deployment.

The native console shows activity, attention, readiness and recent decisions. Its lineage graph and read-only evidence/source views disclose technical detail progressively. The isolated legacy demo remains `/demo`; legacy runner/Sandbox APIs require explicit compatibility opt-in.

Jev jobs use typed bounded evidence, exact-input fingerprints, two concurrent requests, deadlines, three attempts and daily budgets. Automatic semantic constraints remain gated off pending labeled evaluations. Hosted native execution, runtime test verification, releases and environment deployment are subsequent delivery slices, not simulated completion.

## Historical coordination runtime (retained compatibility)

The following records explain the existing deterministic demo, Sandbox and cleanup behavior. Their Flight/landing terms and launcher architecture are historical, not the native product contract.

# Architecture

Cruce is Cloudflare-native: one Worker (API + static Work/Traffic UI), one Durable Object per project as the
authoritative control tower, a Workflow per live Flight, a container Sandbox per live Flight, Artifacts
for every repository, and Queues event subscriptions for repository events.

```
                         ┌───────────────────────────── Cloudflare ──────────────────────────────┐
 Work / Traffic UI ─────┼─ WebSocket ─┐                                                         │
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
| Agent protocol | `src/worker/protocol.ts` | status · plan · amend · request · activity · heartbeat · ack-instruction · publish · validate · land · checkout · refresh · fail. Provider-neutral; an MCP adapter can map 1:1. |
| FlightWorkflow | `src/worker/agents/flight-workflow.ts` | Durable lifecycle of a live Flight: provision → sandbox → discovery → plan → hold/wait → execute → gate → tests → land; re-plan when stale. |
| FlightSandbox | `src/worker/agents/flight-sandbox.ts` | Container DO per Flight: clone (read-only), run Claude Code in the background, collect changes, run tests, resync to Cruce's commit. Heartbeats leases while the agent works. |
| Outbound | `src/worker/agents/outbound.ts` | Sandbox egress policy: protocol for its own Flight only; read token injected for `git-upload-pack` on its own repo; `receive-pack` refused; model key injected; everything else 403. |
| External runner | `runner/cruce-runner.ts` | Same lifecycle from a developer machine with the local `claude` CLI and a restricted tool allowlist. |
| Work / Traffic | `src/ui/*` | Work lists tasks, attention and recent results. Task details explain scope, coordination, activity and changes. Optional Traffic uses React Flow + ELK for active scope; controller logs and infrastructure stay in advanced details. |

## Key decisions

- **One Durable Object per project is the single authority.** All coordination state changes happen in one
  synchronous `mutate()`; Git work happens outside it and its results are applied in a later mutate.
  Concurrent initial readers share bootstrap; failed initialization can retry.
- **Cruce is the only writer to Artifacts.** Agents submit changes; Cruce rebuilds the commit (same id when
  the agent supplies its metadata), runs the publish gate on the *real* diff, then pushes with a 60 s token
  that is revoked immediately. Sandboxes get read access through the egress policy and never see a token.
- **Git in the control plane.** isomorphic-git on Durable Object SQLite gives Cruce a persistent object
  database: fetches are incremental, preflight is a non-destructive three-way merge, landing is a real
  merge commit, notes carry context. A `local` backend uses the same code with no remotes (offline demo).
- **Babel instead of tree-sitter in the Worker.** Tree-sitter grammars are Wasm side modules that Workers
  cannot compile at runtime; ast-grep is native. `StructuralIndexer` is an interface so a tree-sitter /
  ast-grep indexer can run in the Sandbox for other languages.
- **Workflows for live Flights, alarms for time and cleanup.** The demo is a deterministic script stepped by DO
  alarms. Demo prepare, reset, replay and advancement are serialized. Live Workflows wait for events with
  a one-minute heartbeat/status check; external runners poll at 15 seconds while idle. Idle waiting does
  not consume execution rounds. Controller alarms check live timeouts every 30 seconds without moving
  an earlier deadline when another heartbeat arrives.
- **Namespaces separate environments**: `cruce-dev` (local) and `cruce` (production).

## Data model (abridged)

`Mission` → `Flight` (phase, plan, planHistory, artifact, stale, publishes, optional instruction) → `FlightPlan`
(readSet, writeSet, contractSet, dependencies, assumptions, risk, amendment) → `TrafficPicture`
(congestions, clearances, edges, deadlocks, landingOrder, attention, occupancy). See `src/core/domain.ts`
and `src/core/traffic.ts`.

The domain names remain internal: the UI generally says Task, Run, Plan, Scope and Integrated.
Snapshots and WebSocket updates include `integrationBlockers` derived by the controller; the UI does
not independently decide whether a run may integrate.

## Validation and instructions

Validation attaches only to the exact approved publish commit named in the request. Unknown or
rejected commits are refused. Integration requires a passing report for the latest approved publish;
an older commit's result cannot satisfy it. Sandbox and external test results use the command exit
status, including timeout failure. A repository without a test script reports a validation failure
with a missing-test reason. Missing or skipped tests cannot satisfy integration. Demo test reports are
explicitly scripted; real scenario tests run separately.

A reroute request persists on the Flight with a stable ID, target resources and pending/acknowledged
state. Repeated requests reuse the outstanding ID. Both status APIs and the text brief retain pending
instructions and acknowledged receipts, with the plan version at request time. Both live runtimes
deliver the request at the next safe boundary, before further work,
publishing or integration, then acknowledge receipt through `ack-instruction`. Delivery does not claim
success: an amended plan and its new clearance show the outcome. A failed delivery remains pending.
The demo's scripted agent amends immediately. Cancellation immediately blocks agent protocol work and
schedules durable token revocation, Workflow termination, and sandbox destruction. External runner
processes stop cooperatively at their next boundary. See [Flight resource cleanup](flight-cleanup.md).

## Changes API

`GET /api/projects/:project/flights/:flightId/changes` returns file counts and line statistics with
explicit base, head and canonical commit IDs. Add `?path=<encoded-path>` for one unified file diff.
Active runs compare their accepted workspace head to its merge base with canonical; rejected staging
commits are excluded. Completed runs compare the integration commit to its first parent, so later
canonical changes do not change their result. These are published changes, not an agent's unsubmitted
working tree. Binary, oversized or overly complex diffs are omitted with a reason and incomplete
statistics are identified.

## Failure handling

| Situation | Behaviour |
|---|---|
| Agent crash / silence | Planned runs expire after 10 min without agent contact, including fully held runs with no leases → Flight LOST → leases released → dependents re-evaluated. Persisted heartbeat or plan-filing time survives controller restart. |
| Launch failure | Failed repository provisioning or Workflow creation marks the run FAILED and closes any issued repository credentials; no queued run is left behind. |
| Sandbox failure | Workflow step retries; final failure marks the Flight FAILED and retains published work for 24 hours unless kept for recovery. Execution resources are released. |
| No Flight Plan | Discovery timeout (30 min) → plan-timeout attention, Flight failed, no code executed. |
| Route expansion | Publish gate rejects with the out-of-clearance symbols; the agent amends (request airspace) or reverts. Live runtimes fail after three unsuccessful publish attempts rather than integrate an older approved commit. Repeated gate violations raise attention. |
| Validation failure | Missing or failed reports block integration. A failed test command fails the live run; published work is retained for 24 hours unless kept for recovery. |
| Stale plan | Stale state immediately returns the runtime to refresh/replan, including when detected during tests. Replanning consumes the work budget; returning without an amended plan fails the run. |
| Dependency failure | Flights that declared a dependency on a failed Flight raise attention. |
| Git conflict | Preflight reports conflicting paths; the Flight is not landed; attention raised. |
| WebSocket drop | The client reconnects with backoff and receives an authoritative snapshot. |
| Duplicate Artifacts event | Deduplicated by (type, repo, after/tokenId, timestamp); push recording is idempotent per commit. |
| Deadlock | Tarjan SCC detection; the highest-priority, earliest-filed Flight gets right-of-way in the cycle; flagged for review. |
