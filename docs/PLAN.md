# Cruce — implementation plan

Cruce ("Tower" was the working codename) is active traffic control for coding agents built on
Cloudflare Workers + Artifacts. This plan is the working order of the MVP; `docs/PROGRESS.md` is
the log of what is actually done.

## Verified platform facts (Oct 2026)

- Account `e51a8ff5…` (single account) is on **Workers Paid**; Artifacts and Containers respond.
- `cf` 1.0.0-beta.12 drives projects through `cloudflare.config.ts` + the Cloudflare Vite plugin 2.0 beta.
  It supports Artifacts bindings, Durable Objects, Workflows, Containers. Wrangler is not needed.
- Artifacts binding has **no local simulator**; local dev uses `bindings.artifacts({ dev: { remote: true } })`.
- `create()` returns a token valid ~1 year and `fork()` a 24h write token → Cruce revokes both immediately.
- Git push/clone/fetch/notes verified with a standard git client and transient `http.extraHeader`.
- Event subscriptions: account-level source `artifacts` (events `repo.created|forked|deleted|imported`)
  and per-repo source `artifacts.repo` with `namespace` + `repo_name` (events `pushed|cloned|fetched|token.created|token.revoked`).
  Delivery verified on queue `cruce-artifact-events`.
- Sandbox SDK 1.0: one Durable Object with `ctx.container` per sandbox; all egress goes through an
  `Outbound` WorkerEntrypoint → Cruce injects Git credentials at the network edge.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 0 | Cloudflare / Artifacts bootstrap (push + separate clone + notes + events) | done |
| 1 | Scaffold + domain model | done |
| 2 | Deterministic traffic controller (matrix, graph, right-of-way, leases, gate) | done |
| 3 | Seeded simulation (demo repo + scripted Flight work, verified with real git) | done |
| 4 | Radar UI (React Flow + ELK) | next |
| 5 | Realtime (Durable Object WebSockets) | |
| 6 | Plan amendments + partial clearance in the UI | |
| 7 | Real Git in the control plane (isomorphic-git: diff, preflight, merge, notes) | |
| 8 | Real Artifacts canonical repo + Flight forks | |
| 9 | Git notes + Artifact event subscriptions | |
| 10 | One real Claude Code Flight in a Cloudflare Sandbox | |
| 11 | Concurrent real Flights | |
| 12 | Bounded judge (rule-based; Jev optional) | |
| 13 | Workers Builds / previews for Cruce's own repo | |
| 14 | Demo hardening | |
| 15 | Docs + cleanup | |

## Key design decisions

1. **One Artifacts repo per Flight**, forked from the canonical repo (`auth-service--f021`).
2. **Two enforcement layers.** Execution policy (the cleared route in the agent's brief) and a
   Cruce-controlled publish gate: the diff is mapped to symbols; only then is a short-lived write
   token used, then revoked. In the Sandbox, the token is injected by the Outbound handler and the
   sandbox never holds it.
3. **Pure controller.** `src/core` has no I/O; the Durable Object hosts it. Everything is replayable.
4. **Git is the source of truth for integration.** Prediction (Flight Plans) and verification (Git
   preflight, three-way merge) are shown separately.
5. **Structural index in the Worker** with `@babel/parser` (tree-sitter grammars need runtime Wasm
   compilation, which Workers forbid; ast-grep is native).
