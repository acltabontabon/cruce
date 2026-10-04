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

### 2026-10-04 — implementation plan refresh

- Updated `PLAN.md` phase statuses against the implementation and recorded verification; corrected
  Sandbox read-token/publish-gate handling and documented remaining Sandbox verification, Builds/
  previews and refinement deployment. Platform observations and verification results are historical;
  this documentation refresh did not recheck live infrastructure.

### 2026-10-05 — durable Flight resource cleanup

- Added terminal timestamps, immediate landed-repository cleanup after canonical commit/note checks,
  24-hour retention for unsuccessful Flights, and authenticated keep/release controls in Flight details.
- Persisted ownership before forks/Workflow creation. Independent cleanup steps survive restarts and
  reset epochs, retry with bounded alarms, report repeated failures, and reconcile owned repos daily.
  Paginated subscription removal and identity checks protect canonical and replacement repositories.
- Terminal agents cannot obtain fresh credentials or continue protocol work. Workflow and sandbox
  resources release immediately; delayed token minting, fork completion, and sandbox callbacks cannot
  revive a Flight. Landed history remains readable; expired unsuccessful review returns HTTP 410.
- `pnpm typecheck && pnpm lint && pnpm test` passed (187 tests across 24 files). The independent scenario
  passed with signing disabled only for its disposable commits; reproducible demo history is unchanged.
  Cloudflare type generation required a temporary localhost listener outside the filesystem sandbox.
- No production deployment or live resource deletion performed. Unreachable durable Git objects remain
  a separate maintenance concern; legacy resources without proven ownership are reported, not deleted.

## 2026-10-05 — native platform direction

- Superseded the GitHub-first implementation with native Systems, Cloudflare Access/MCP identity, Artifacts accepted source, isolated mission workspaces and immutable evidence outputs. Removed newly introduced GitHub authority code; preserved pre-existing cleanup changes and deterministic demo history.
- Added mission/proposal/verification/review/promotion/lineage controllers and shared adapters. Source publication verifies actual Git scope; human policy governs accepted-source promotion. Fixed unresolved-symbol fallback widening publication permissions.
- Added native activity console, read-only evidence/source/diff inspection, human attestations, agent disagreement resolution and lineage. Legacy demo remains `/demo`; old live runner/Sandbox APIs are opt-in compatibility.
- Native live Access/client adaptation, Artifacts/Jev smoke and labeled judgment-corpus gates remain outstanding. Automatic semantic constraints stay disabled; environment/release promotion and independently executed native verification are not represented as completed.

- Final native checks: `pnpm typecheck`, `pnpm lint`, 245 Vitest tests, offline `cf` build and independent scenario verifier passed. The scenario was run with commit signing/hooks disabled only in the disposable fixture to avoid user-global GPG settings. Existing controller demo revisions remain reproducible in its tests.
- Added a real-Git two-mission offline scenario: independent API publication, implementation promotion, required refresh/amendment, preservation of both histories and drafts, second promotion, exactly one Artifacts fork per workstream. Publication and promotion crash-recovery tests pass.
- Browser inspected native sign-in at desktop/mobile widths and keyboard skip-link focus; the isolated legacy demo opens successfully. Authenticated native overview/lineage still needs live Access inspection. Cloudflare CLI reports not signed in; requested a non-production environment/Access hostname for live gates.
- Hardened native governance: maintainers can re-enable a disabled system without enabling source access during suspension; removed members cannot retrieve system details through a replayed creation request. Tenant and role checks still apply.

## 2026-10-05 — Git + Artifacts foundation

- Re-anchored Cruce on Git, Cloudflare Artifacts, Cruce MCP and the Control Tower. Renamed System → Project across domain, API (`/api/projects`), MCP, UI and docs; earlier repository descriptions remain accepted for ownership checks. The legacy demo API moved to `/api/demo/*`.
- Removed cloud agent execution (FlightSandbox container, FlightWorkflow, Outbound egress, sandbox image, legacy runner, launch form, live/protocol paths). The deterministic demo and its reproducible revisions are unchanged.
- Projects provision their canonical Artifacts repository explicitly; reads never create resources. Missions start from an accepted revision; `publish_revision` imports a local Git pack and records the agent's exact commit; source artifacts carry commits, parent and file counts.
- Cruce MCP catalog (`src/shared/tools.ts`) with per-tool schemas, scopes, control/resource class and cost; OAuth consent grants explicit scopes; human decisions are unreachable by agents.
- Resource policy and budgets (`src/core/capabilities.ts`), resource requests with human approval, cloud AI gated by policy. Proposals gain numbers, repository, commits/files, supersede, reject and request changes; verification requests; promotion requests.
- Environments, deployments and the resource boundary: Worker detection, operator/connected Cloudflare account with sealed token, Artifacts REST host, Workers Builds client, per-project deploy repository, DeploymentWorkflow, Cruce smoke checks as runtime-verified evidence, promote-and-deploy, rollback explanation and redeploy, lineage tracing both ways.
- Native console rebuilt into overview, proposal, mission, artifact, lineage and environments views with hash routes; no raw JSON by default.
- Checks: typecheck, lint, 242 tests, offline `cf build`, independent scenario verifier. Live Access, Artifacts, Workers Builds and connected-account gates remain open (see PLAN).

## 2026-10-05

- Removed standalone intent records, creation tools, console intake, routes and lineage links. Local agents now register missions directly through MCP with a plan objective and optional context; human prompting stays local.
- Updated coordination operation/capability names, evidence metadata, rollback explanations, onboarding and product documentation. Existing stored context moves onto missions; stored plans migrate without rewriting Git revisions or evidence contents.
- Validation: typecheck and lint passed; all 260 unit tests, 17 browser checks (including responsive pages and agent-created mission navigation), and the demo scenario verifier passed.
- Isolated commit snapshot also passed TypeScript checks, lint and 247 unit tests; unrelated console/environment work remains outside the commit.

### 2026-10-05 — first-project welcome

- Added a dark welcome explaining version control built for agents and the first steps: project creation, local agent connection and prompting, revision review and promotion. Includes a demo link, storage disclosure and a next-step note; no standalone intent form.
- Desktop/mobile fixture checks confirmed no horizontal overflow and successful creation. UI TypeScript and focused lint checks passed.

### 2026-10-05 — first alpha and release-tag deployments

- Drafted `0.1.0-alpha.1`, aligned package and MCP versions, and added a concise changelog with SemVer/release instructions.
- Added GitHub checks for main/PRs and deployment only for matching `v*` tags contained in main, with changelog validation, serialized deployments and tagged Worker version metadata. Existing working-tree changes were preserved.
- Created the GitHub production environment and saved existing non-secret Access settings. `CLOUDFLARE_API_TOKEN` still needs to be supplied; no release tag, push or deployment was performed.
- Validation passed: typecheck, lint, 274 tests, demo scenario, workflow YAML, offline build and production/prebuilt deployment dry runs. Local network checks ran outside the sandbox; the scenario verifier disabled inherited commit signing for its temporary repositories.

### 2026-10-05 — GitHub release activation

- Prepared an isolated release-setup commit and verified the GitHub production environment and Access settings. Ordinary pushes only run checks; no release tag was created.
- Cloudflare deployment-token creation was rejected by automatic approval review; account-scoped Worker/KV/Queues write access, Account Settings read access and export to GitHub require explicit approval. Token creation did not run.
- Isolated release snapshot passed typecheck, lint, 261 tests, offline build and the demo verifier before commit.

### 2026-10-05 — first alpha released

- After explicit approval, created the account-scoped GitHub release token (expires 2027-10-05) and stored its value directly in the production environment secret without logging it or writing it to disk.
- Pushed `v0.1.0-alpha.1` at `2e855cc31cb35783f05f7c4203885270441df272` and published concise GitHub prerelease notes. Checks and deployment succeeded in Actions run `37239987345`.
- Cloudflare version `14e9d014-f887-435b-b3e8-f0ef34df8d37` serves 100% of traffic with the matching tag and commit. Live checks confirmed console sign-in redirect (302), OAuth discovery (200) and unauthenticated MCP rejection (401). Marked the changelog as released; unrelated local work stays uncommitted.
