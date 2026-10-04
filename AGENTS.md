# AGENTS.md — working on Cruce

Instructions for coding agents (Claude Code, Codex, …) changing this repository. Read this first.

## What Cruce is (do not dilute it)

1. Cruce is an **agent-native development platform built on Git + Cloudflare Artifacts**, with four foundations: **Git** (mechanics of software evolution), **Cloudflare Artifacts** (canonical home of every project's repository), **Cruce MCP** (intentional machine interface), **Cruce Control Tower** (Cloudflare-native control plane). Cruce does not replace Git; it replaces the collaboration model above it. No GitHub/GitLab dependency; those are future import/export/mirroring only.
2. **Git is first-class.** Agents commit real history; `publish_revision` carries their exact commits as a Git pack. Never rebuild agent commits, never invent a weaker substitute for revisions, diffs, forks, merges or rollback.
3. **Artifacts owns canonical state.** One canonical repository per project (`main` = accepted source), one fork per mission workspace from an immutable baseline snapshot, an evidence repository, a deploy repository. Never collapse workspaces into branches of a shared repository. Never reinterpret legacy Flight records as native missions.
4. **The revision is the anchor.** Missions start from a concrete accepted revision. Proposals name exact base and proposed revisions. Verification targets the exact revision; reported agent evidence never masquerades as runtime-verified execution. Deployments name the revision they run.
5. **Cruce coordinates agents; it does not execute them.** Agents run locally with their own tools. No cloud agent runtime, no desktop app, no IDE. A tiny local bridge is acceptable.
6. **Cruce MCP exposes Cruce concepts, never generic Cloudflare administration.** If a tool only wraps a Cloudflare API, it does not belong. Express development intent (`request_preview(proposal)`), and let the Control Tower decide which Cloudflare capability runs. The catalog lives in `src/shared/tools.ts`.
7. **Control actions vs resource actions.** Agents get broad read access and explicit scopes. Anything that consumes infrastructure (workspace fork, Artifacts write, preview, cloud AI, production) carries a cost class and passes project resource policy and budgets (`src/core/capabilities.ts`). Production is always a human decision. Reads never provision resources.
8. **The project's Cloudflare account is the resource and billing boundary.** Its credential is sealed and never returned. Cruce must not become a denial-of-wallet machine.
9. **Deterministic scheduling before AI judgment**: conflict matrix → static analysis → dependency graph → scheduling policy → bounded Jev → human. Models never grant permission against deterministic conflicts. Partial clearance beats whole-mission blocking; working, publication and integration decisions are separate.
10. Plans evolve. Amendments re-evaluate coordination. Promotions invalidate intersecting assumptions and issue durable refresh instructions. Preserve working changes during adaptation.
11. Intent → mission → agent → revision → artifacts → proposal → verification → preview → promotion → production must stay auditable and navigable in both directions. Keep agent disagreement and reasoned human resolution. Promotion (accepted source) and deployment are separate decisions, even when one human action does both.
12. Product vocabulary: project, intent, mission, workspace, revision, artifact, proposal, verification, environment, deployment, promotion, lineage. Keep diff, history, commit and rollback. Not CI/CD (pipeline, job, build #) or Git GUI (branches, stashes) as primary navigation.
13. Keep `src/core` pure and deterministic with injected time. Controller decisions are authoritative; the UI renders derived state. Use real Git and Babel; unresolved symbol fallbacks must never grant broader permission.
14. Keep the UI calm, compact and technical. No coding chat, editor, agent-launch form, vanity metrics, sparkles or raw reasoning dump. Evidence and records are progressively disclosed. Cost is visible where an action crosses into resource consumption, without dominating.
15. Never expose credentials in remotes, config, source, logs or frontend. Agents never hold Artifacts write tokens. Server-issued 60-second tokens are revoked. Human membership and machine provenance are different concepts.
16. Check current [Artifacts](https://developers.cloudflare.com/artifacts/llms.txt) and [cf](https://developers.cloudflare.com/cf/llms.txt) documentation before platform changes. Use `cf`, never `wrangler`. Use Cloudflare products because the architecture benefits, not decoratively.
17. Preserve reproducible demo revisions, pre-existing working-tree changes and ownership-safe cleanup. Native source artifacts require retention even after workspace execution ends.
18. “Cruce” is a working name; keep naming easy to change.

## Layout

```
src/core/            pure: platform (intent → promotion, resources, deployments, lineage), capabilities
                     (scopes, cost classes, resource policy), deployment (Worker detection, rollback),
                     workstreams (native coordination); legacy demo controller/airspace/traffic
src/intelligence/    structural index (Babel, TypeScript), bounded Jev adviser
src/demo/            deterministic demo scenario (plans + scripted work in demo/scenario)
src/shared/          wire types: platform (domain), tools (Cruce MCP catalog), coordination, demo api
src/worker/          Worker router, OAuth/Access, Cruce MCP, ControlTower DO, ProjectRuntime,
                     CoordinationRuntime, ProjectDirectory, managed workspaces, deployments (resource
                     boundary, Artifacts REST, Workers Builds), DeploymentWorkflow, Git on DO SQLite;
                     legacy demo tower and project-git
src/ui/              native console (src/ui/console/*) and the legacy demo radar (/demo)
runner/              local bridge: OAuth, MCP stdio, checkout/refresh, Git pack publication
demo/                the demo repositories (auth-service, payment-service) and scripted Flight work
tools/               Artifacts bootstrap + independent verification scripts
test/                vitest: core, worker runtime, MCP, deployments, bridge, UI, demo end to end
```

## Working rules

- `src/core` stays pure and deterministic. Time is injected. Add a test for every controller behaviour.
- The controller is authoritative. The UI only renders derived state; never re-decide in the UI.
- Commit timestamps in the demo come from a fixed clock: demo commit ids must stay reproducible.
- Do not run `wrangler` project commands; the project uses `cf` with `cloudflare.config.ts`.
- New agent-facing operations go in the `src/shared/tools.ts` catalog with a scope, control/resource
  class and cost class. Resource actions must pass `PlatformController.gate` before touching infrastructure.
- `demo/auth-service` is "user code": no repo-wide formatting of it, and overlays in `demo/scenario`
  must stay consistent with it (`bash demo/scripts/verify-scenario.sh` proves it).
- Before committing: `pnpm typecheck && pnpm lint && pnpm test`.
- Log progress in `docs/PROGRESS.md` (short dated entries).
