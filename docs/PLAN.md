# Native platform delivery — current direction

The 2026-10-05 clarification replaces the GitHub-first plan. Accepted source and collaboration are native to Cruce and Cloudflare Artifacts. External Git hosting is not required.

Local gates passed: typecheck, lint, 244 tests, offline build and the preserved independent scenario. Native sign-in and keyboard/mobile entry were inspected in the browser; authenticated activity and lineage still require Access.

Delivered in this working tree: native system identity/membership, Access/MCP OAuth, typed native/machine commands, intents and specialized missions, durable workstream/session separation, one Artifacts workspace per workstream, observed-versus-verified source, partial clearance and drift, immutable source/evidence artifacts, proposals, revision-bound verification and human review, explicit disagreement resolution, versioned policy, resumable non-forced source promotion, source export, native console and lineage.

Release gates still required: authenticated native tools on a real Access deployment; two-agent full refresh/amendment through Codex/Claude and tested Cursor capability claims; disposable native Artifacts publication/evidence/promotion smoke; actual Jev binding call; labeled 200-case judgment evaluation. Automatic semantic constraints stay off. Existing compatibility/demo verification does not satisfy these native gates.

Next dependent slices: native managed execution and independently verified tests; binary/large artifact transport; artifact retention/archival policy; risk-specific security approvals; rollback mission convenience; releases and environment promotion with explicit deployment policy; external import/mirroring as interoperability.

The console must never claim a release/deployment or runtime verification that has not actually occurred. Preserve actual source, causal decisions and honest coverage at every boundary.

## Historical implementation plan

The following is retained as the record of the deterministic coordination MVP and cleanup refinement, not the current product north star.

# Cruce — implementation plan

Cruce ("Tower" was the working codename) is active traffic control for coding agents built on
Cloudflare Workers + Artifacts. Worktrees solve isolation; Cruce solves coordination. This plan
tracks the MVP phases and remaining work as of **2026-10-04**, using the implementation and recorded
verification. [Progress](PROGRESS.md) is the detailed log; [architecture](architecture.md) describes
the current implementation; [Cloudflare setup](cloudflare-setup.md) covers runtime and deployment.

## Previously verified platform observations (2026-10-04)

These observations come from the recorded bootstrap and integration checks. This documentation
refresh does not recheck live infrastructure or current platform documentation. Sandbox execution
remains unverified; its runtime design is described below.

- Account `e51a8ff5…` (single account) is on **Workers Paid**; Artifacts and Containers respond.
- `cf` 1.0.0-beta.12 drives projects through `cloudflare.config.ts` + the Cloudflare Vite plugin 2.0 beta.
  It supports Artifacts bindings, Durable Objects, Workflows, Containers. Wrangler is not needed.
- Artifacts binding has **no local simulator**; local dev uses `bindings.artifacts({ dev: { remote: true } })`.
- `create()` returns a token valid ~1 year and `fork()` a 24h write token → Cruce revokes both immediately.
- Git push/clone/fetch/notes verified with a standard git client and transient `http.extraHeader`.
- Event subscriptions: account-level source `artifacts` (events `repo.created|forked|deleted|imported`)
  and per-repo source `artifacts.repo` with `namespace` + `repo_name` (events `pushed|cloned|fetched|token.created|token.revoked`).
  Delivery verified on queue `cruce-artifact-events`.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 0 | Cloudflare / Artifacts bootstrap (push + separate clone + notes + events) | done |
| 1 | Scaffold + domain model | done |
| 2 | Deterministic traffic controller (matrix, graph, right-of-way, leases, gate) | done |
| 3 | Seeded simulation (demo repo + scripted Flight work, verified with real git) | done |
| 4 | Work + optional Traffic (React Flow + ELK) | done |
| 5 | Realtime (Durable Object WebSockets) | done |
| 6 | Plan amendments + partial clearance in the UI | done |
| 7 | Real Git in the control plane (isomorphic-git: diff, preflight, merge, notes) | done |
| 8 | Real Artifacts canonical repo + Flight forks | done |
| 9 | Git notes + Artifact event subscriptions | done |
| 10 | One real Claude Code Flight in a Cloudflare Sandbox | runtime implemented; execution unverified |
| 11 | Concurrent real Flights | verified through the external runner |
| 12 | Bounded judge (rule-based + optional model judge) | implemented; Jev optional, not integrated |
| 13 | Workers Builds / previews for Cruce's own repo | partial: source mirrored; Builds connection and previews unverified |
| 14 | Demo hardening | done |
| 15 | Delivered documentation + cleanup | done |

Recorded verification includes real concurrent external Flights with partial clearance and stale
re-planning, independent Git clone/tests/notes checks, and isolated Artifacts event and token checks.
The Work/Traffic refinement was checked with browser flows, typecheck, lint, 156 tests, an offline
build and the independent demo scenario. These are historical results, not checks rerun by this refresh.

## Remaining work

- **Verify Sandbox execution.** Run one real Flight end to end through discovery, plan, clearance,
  publish, validation and landing. This requires Docker for the image build, configured
  `FlightSandbox`/`FlightWorkflow` resources (`CRUCE_SANDBOX=on`) and `ANTHROPIC_API_KEY`.
- **Connect Workers Builds and verify previews.** Source mirroring to `cruce/cruce-platform` is done;
  the owner/dashboard connection and a verified preview deployment remain open. Follow
  [Workers Builds / previews](cloudflare-setup.md#workers-builds--previews-cruces-own-source).
- **Deploy the latest refinement.** The earlier MVP was deployed; the Work/Traffic refinement and
  associated hardening are available in the checkout but recorded as not deployed to production.
- **Optional Jev integration.** The judge interface, rule-based judge and optional model judge exist.
  Jev has no verified API access or integration and is not required for deterministic scheduling.

## Key design decisions

1. **One Artifacts repo per Flight**, forked from the canonical repo (`auth-service--f021`).
2. **Two enforcement layers.** Execution policy (the cleared route in the agent's brief) and a
   Cruce-controlled publish gate: the diff is mapped to symbols; only then is a short-lived write
   token used by Cruce to push, then revoked. Agents submit changes; Cruce rebuilds and gates the
   commit. The Sandbox's Outbound handler injects read credentials for clone/fetch of its own Flight
   repository and refuses pushes. Agents never hold write credentials.
3. **Pure controller.** `src/core` has no I/O; the Durable Object hosts it. Everything is replayable.
4. **Git is the source of truth for integration.** Prediction (Flight Plans) and verification (Git
   preflight, three-way merge) are shown separately.
5. **Structural index in the Worker** with `@babel/parser` (tree-sitter grammars need runtime Wasm
   compilation, which Workers forbid; ast-grep is native).
6. **Two agent runtimes, one protocol.** The external runner executes Claude Code on a developer
   machine. The implemented Sandbox runtime uses one container Durable Object with `ctx.container`
   per Flight, a Workflow for its lifecycle and an Outbound WorkerEntrypoint for egress policy.
   External execution is verified; Sandbox execution remains unverified.
