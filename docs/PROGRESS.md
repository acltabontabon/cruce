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
