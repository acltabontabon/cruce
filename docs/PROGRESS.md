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
