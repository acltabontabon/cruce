# AGENTS.md — working on Cruce

Instructions for coding agents (Claude Code, Codex, …) changing this repository. Read this first.

## What Cruce is (do not dilute it)

1. Cruce is an **agent-native software development platform**: humans define intent, agents perform bounded work, Artifacts preserve outputs and evidence, and review/policy govern promotion. It has no GitHub/GitLab product dependency.
2. Preserve **isolation plus coordination**. Existing coding tools participate through MCP. Human workflows center supervision, risk, evidence and consequential decisions.
3. **Cloudflare Artifacts owns native accepted source.** One Artifacts repository per durable mission workstream, forked from an immutable baseline snapshot. Never collapse workspaces into branches of a shared repository. Never reinterpret legacy Flight records as native missions.
4. **Deterministic scheduling before AI judgment**: conflict matrix → static analysis → dependency graph → scheduling policy → bounded Jev → independently enabled deep model → human. Models never grant permission against deterministic conflicts.
5. **Partial clearance beats whole-mission blocking.** Working, publication and integration decisions are separate. Managed publication verifies actual source; local observations are cooperative.
6. Plans evolve. Amendments re-evaluate coordination. Promotions invalidate intersecting assumptions and issue durable refresh instructions. Preserve working changes during adaptation.
7. Agents produce immutable Artifacts and Proposals. Completion never promotes accepted state. Verification pins exact source revisions; reported agent evidence never masquerades as independently verified execution.
8. Intent → mission → execution → artifacts → proposal → verification/review → promotion must remain auditable and navigable. Keep agent disagreement and reasoned human resolution.
9. Product vocabulary: system, intent, mission, workspace, artifact, proposal, verification, promotion, lineage. Git is an implementation/export mechanism. Keep useful terms such as diff, history, revision and rollback.
10. Keep `src/core` pure and deterministic with injected time. Controller decisions are authoritative. Use real Git and Babel; unresolved symbol fallbacks must never grant broader permission.
11. Keep the UI calm, compact and technical. No coding chat, editor, agent-launch form, vanity metrics or raw reasoning dump. Artifacts and evidence are progressively disclosed.
12. Never expose credentials in remotes, config, source, logs or frontend. Agents never hold Artifacts write tokens. Server-issued 60-second push tokens are revoked. Human membership and machine provenance are different concepts.
13. Check current [Artifacts](https://developers.cloudflare.com/artifacts/llms.txt) and [cf](https://developers.cloudflare.com/cf/llms.txt) documentation before platform changes. Use `cf`, never `wrangler`.
14. Preserve reproducible demo revisions, pre-existing working-tree changes and ownership-safe cleanup. Native source artifacts require retention even after workspace execution ends.
15. “Cruce” is a working name; keep naming easy to change.

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
src/ui/              native development console and lineage (React Flow + ELK); legacy demo radar
runner/              native OAuth/MCP/local Git bridge; legacy Claude runner compatibility
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
