# Progress log

Short, dated entries so another agent can continue. Newest last.

## 2026-10-04

- Read Artifacts + cf llms.txt indexes and the docs they link (binding, git protocol, auth, events,
  limits, pricing, sandbox + Claude Code runner, Workflows waitForEvent, Queues event subscriptions).
- Installed `cf` 1.0.0-beta.12, signed in, single account. Account upgraded to Workers Paid by the owner.
- Phase 0 verified with `tools/artifacts-smoke` (`scripts/verify.sh`): create → push (header auth) →
  read-token clone in a separate dir → SHA match → fetch → notes round trip → read token cannot push →
  binding info/log/readFile → revoke. Fork verified. Push event delivered to queue `cruce-artifact-events`
  (subscriptions: account `artifacts` + repo `cruce-dev/cruce-bootstrap`). A temporary `http_pull` consumer
  exists on that queue for verification; remove it before the Worker consumer is attached.
- Built `src/core` (domain, airspace, conflict matrix, dependency graph, right-of-way, leases, clearance
  engine, publish gate, controller) and the Babel structural indexer.
- Demo repo `demo/auth-service` + scripted Flight work `demo/scenario/*`; `demo/scripts/verify-scenario.sh`
  replays the story with real git: all steps merge cleanly and tests pass; F-021's final step fails on the
  old baseline (proves the sequencing).
- 45 unit tests (`pnpm test`) including the full demo story through the controller.
- Control plane: `ControlTower` Durable Object (SQLite state + audit log, WebSocket hibernation, alarms)
  hosting a runtime-agnostic `Tower` (controller + Git). Git runs in the Worker with isomorphic-git on a
  bare workspace persisted in DO SQLite (`SqlFs`); Artifacts repos are remotes; Cruce is the only writer
  (agents submit files → Cruce rebuilds the commit → publish gate → 60s write token → push → revoke).
- Demo director (18 deterministic steps) ran end to end on real Artifacts: 3 forks, gated pushes,
  rejected publish, amendment, merges into canonical with Git notes, stale → refresh → re-plan → land.
  `tools/verify-repo.sh` re-verifies with `cf` + plain git: history, notes, and 15/15 tests on the clone.
- `isomorphic-git` pinned to 1.42.6 (pnpm 12 minimum-release-age policy rejects 1.43.0, published <24h).
- Radar UI (React Flow + ELK) with realtime WebSocket state; verified in the browser through the full story.
- Separate namespaces: local dev `cruce-dev`, production `cruce` (queue consumer ignores other namespaces).
- API token `cruce-event-subscriptions` (account-owned, Queues Write only, expires 2026-12-31) creates per-repo
  push subscriptions; stored only in `.dev.vars` / `.secrets.prod.json` (both gitignored) and as a Worker secret.
- Removed the temporary `http_pull` consumer and the bootstrap repo's subscription.
- Deployed: https://cruce.acltabontabon.workers.dev (Durable Object + queue consumer). Demo runs in ~30 s at 2×
  on production Artifacts; push/token events arrive through the queue (token.created → push → token.revoked per publish).
- Live agents: external runner (`runner/cruce-runner.ts`, local Claude Code over the agent protocol) and
  Sandbox runtime (`FlightSandbox` + `Outbound` + `FlightWorkflow`, gated by `CRUCE_SANDBOX=on`).
- Real runs on `project=live` (dev): F-031 landed after a gate rejection → the agent requested airspace;
  F-032/033/034 ran concurrently: real congestion on TokenValidator.validate, partial clearance (the agent
  left held code alone), a deadlock between mutual contract changes (fixed: the break now re-orients landing
  order and is labelled `deadlock-break`), F-033 landed, F-032 went stale → refresh → re-plan → landed.
  Canonical `cruce-dev/auth-service-live`: 27/27 tests on a plain-git clone.
- Production lessons: forks are asynchronous (wait until ready), deletes are eventually consistent (Flight
  repo names carry a reset epoch `-rN`), token revocation right after creation can 404 (retry; Flights'
  remaining tokens are revoked when they land/fail/cancel).
- Bounded judgment: `DecisionJudge` (rule-based; optional model judge on live with a key). Jev (TypeSafe AI,
  released 2026-09-15) fits the interface; not integrated (no verified API access).
- Cruce source mirrored to `cruce/cruce-platform` (Workers Builds connection is a dashboard step).
- BLOCKED (needs the owner): Sandbox Flights need Docker running + `ANTHROPIC_API_KEY` in `.dev.vars`.

### Refinement — familiar work, visible coordination

- Replaced the permanent radar layout with Work and optional Traffic. Added readable task/decision
  details, contextual overrides, typed activity, URL/Back navigation, masked in-memory controller
  access, responsive layouts, and on-demand Git changes/history. Screenshots are in `docs/img/`.
- Fresh demos idempotently prepare the real first seven steps and pause at partial clearance;
  existing sessions remain intact. Continue, reset-to-overlap and complete replay preserve the story.
- Added accepted-head/merge-base and integration/first-parent Changes API; snapshots and realtime
  updates include controller-derived integration blockers. Obsolete sockets and reads are disposed,
  and semantic command errors surface without discarding task input.
- Validation attaches only to exact approved commits; only the latest approved publish can satisfy
  integration. Test failures/timeouts retain exit status and missing tests cannot pass validation.
  Reroute instructions persist with receipt acknowledgements and ordinary plan amendments. Healthy
  waiting agents heartbeat without consuming rounds; alarm lifecycle, silent held-run expiry,
  initialization races and failed launch cleanup have focused regressions.
- Typecheck now checks Worker, UI and test projects; favicon accessibility lint fixed. Browser checks
  cover Work → detail → decision → Traffic → diff/history, Back, repository switching, reconnects,
  keyboard dialogs and 1440/1024/768/390 widths. A disposable protocol fixture verified launch-error
  input retention. Full demo ended at unchanged canonical `801583e`; independent scenario passed.
- Isolated real Artifacts verification passed fork/push/clone/notes, read-token push rejection,
  write/read revocation and push-event queue delivery. A real external Claude Code run completed
  plan → clearance → publish → 11 passing tests → integration; independent clone/tests/notes matched.
  All disposable repositories, queue/subscription and test processes were cleaned up.
- Sandbox execution remains unverified: no configured Workflow/container or Anthropic API key.
  Production was not deployed. README, architecture and demo walkthrough updated.
- Final verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (156 tests across 20 files),
  `pnpm exec cf build --mode offline`, and the independent scenario verifier all pass. Remaining
  tooling notices are Biome's existing configuration deprecation and large graph bundle warnings.
