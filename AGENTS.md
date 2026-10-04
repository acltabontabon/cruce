# AGENTS.md — working on Cruce

Instructions for coding agents (Claude Code, Codex, …) changing this repository. Read this first.

## What Cruce is (do not dilute it)

1. Cruce is **active traffic control** for coding agents — an execution control plane. It is not an
   agent dashboard, not "GitHub with AI", not a prettier worktree manager.
2. Preserve the thesis: **worktrees solve isolation; Cruce solves coordination.** Every feature must help
   answer: *what is happening, where, why, what did Cruce do, do I need to act?*
3. **Cloudflare Artifacts is the canonical Git substrate.** Keep **one Artifacts repository per Flight**
   (a fork of the canonical repo). Do not collapse Flights into branches of one repository.
4. **Deterministic scheduling before AI judgment.** The decision order is: conflict matrix → static
   analysis → dependency graph → scheduling policy → bounded judgment → deep model → human. Never ask a
   model a question an algorithm answers (e.g. WRITE × WRITE on one symbol, cycle detection).
5. **Partial clearance beats whole-task blocking.** Hold only the contested airspace.
6. **Flight Plans are living documents.** Amendments re-run traffic analysis; landings mark intersecting
   Flights stale; stale Flights re-plan.
7. **Optimize safe throughput.** Independent work is cleared immediately; humans are interrupted only for
   consequential ambiguity.
8. **Every meaningful decision is explainable** — right-of-way carries its rule and reasons, clearance
   carries why, landings carry Git notes.
9. Do not build GitHub features unrelated to coordination (issues, PR dashboards, org admin, chat, …).
10. Do not replace proven Git or parser technology: Git (isomorphic-git / git) is the integration truth;
    the structural index uses a real parser (`@babel/parser`), not hand-written parsing.
11. Keep the UI calm, operational, developer-native: dark, quiet surfaces, color only for traffic state,
    no AI gradients, no vanity metrics, no marketing copy inside the product.
12. **Never expose credentials.** No tokens in Git remotes, config, commits, notes, logs, screenshots, or
    frontend code. Agents never hold write tokens; Cruce mints 60-second tokens per push and revokes them.
13. Check the current Cloudflare docs before changing platform integration
    (https://developers.cloudflare.com/artifacts/llms.txt, https://developers.cloudflare.com/cf/llms.txt).
    Artifacts, `cf`, and the Sandbox SDK are new and change quickly.
14. "Cruce" is a working name; keep naming easy to change.

## Layout

```
src/core/            pure controller (no I/O): domain, airspace, conflict matrix, dependency graph,
                     right-of-way, leases, clearance engine (traffic.ts), publish gate, controller
src/intelligence/    structural index (Babel, TypeScript)
src/demo/            deterministic demo scenario (plans + scripted work in demo/scenario)
src/shared/          wire types shared by Worker, UI, and runners
src/worker/          Cloudflare: Worker router, ControlTower Durable Object, Tower runtime,
                     project Git (isomorphic-git on DO SQLite; Artifacts as remotes), events, protocol
src/worker/agents/   live agents: FlightSandbox (container DO), Outbound egress policy, FlightWorkflow
src/ui/              React radar (React Flow + ELK)
runner/              external runner: Claude Code on a developer machine over the agent protocol
sandbox/             container image + the in-sandbox `cruce` CLI
demo/                the demo repository (auth-service) and scripted Flight work
tools/               Artifacts bootstrap + independent verification scripts
test/                vitest: controller, Git, full demo end to end
```

## Working rules

- `src/core` stays pure and deterministic. Time is injected. Add a test for every controller behaviour.
- The controller is authoritative. The UI only renders derived state; never re-decide in the UI.
- Commit timestamps in the demo come from a fixed clock: demo commit ids must stay reproducible.
- Do not run `wrangler` project commands; the project uses `cf` with `cloudflare.config.ts`.
- `demo/auth-service` is "user code": no repo-wide formatting of it, and overlays in `demo/scenario`
  must stay consistent with it (`bash demo/scripts/verify-scenario.sh` proves it).
- Before committing: `pnpm typecheck && pnpm lint && pnpm test`.
- Log progress in `docs/PROGRESS.md` (short dated entries).
