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
  bare namespace persisted in DO SQLite (`SqlFs`); Artifacts repos are remotes; Cruce is the only writer
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
  existing workspaces remain intact. Continue, reset-to-overlap and complete replay preserve the story.
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

- Superseded the GitHub-first implementation with native Systems, Cloudflare Access/MCP identity, Artifacts accepted source, isolated mission namespaces and immutable evidence outputs. Removed newly introduced GitHub authority code; preserved pre-existing cleanup changes and deterministic demo history.
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

### 2026-10-05 — local native-console verification and usability

- Added an isolated loopback native-console fixture with real controller decisions and deterministic local Git commits; identity, repository transport and deployment remain explicitly simulated. Added pinned Playwright and repeatable browser checks with screenshots at 1440/1024/768/390 widths.
- Fixed creation errors hiding input, authentication/connection error confusion, project identity missing from deep links, stale snapshot/diff/source/lineage results, malformed route crashes, duplicate mutations and lost-response retries (including original expected versions).
- Refined the native UI after visual feedback: aligned environment state cards and account metadata, progressively disclosed credential/deployment/policy settings, visible mission records and next steps, readable lineage before its optional graph, and consistent detail spacing.
- Local checks passed: 248 tests plus 18 browser scenarios; full typecheck, lint, offline build and independent demo scenario. Real Git native lifecycle, two-mission adaptation and crash recovery are exercised by runtime tests. See local-verification.md for commands and boundaries. No cloud provisioning or production deployment.

### 2026-10-05 — single live MVP environment setup

- Confirmed the existing account has Workers Paid ($5/month) and Zero Trust Free; reused the `cruce` Worker URL, Artifacts namespace, queue, event subscription and sealing/event secrets. No second production environment was created.
- Configured owner-only Access email-code login and deployed version `021cd3c4-b1dc-48c2-8b49-221166ec32cb`, adding native ProjectDirectory, OAuth KV and DeploymentWorkflow while retaining the original ControlTower storage. Added repeatable `deploy:test` configuration and disabled optional cloud AI by default.
- Applied the exact six machine endpoint exceptions after explicit user approval. Live missing/forged MCP and export tokens return 401, fabricated exchanges return 401, malformed registration returns 400, and discovery returns correct metadata; console/API/consent remain behind email login. Added three OAuth boundary regressions.
- Owner completed login; the live console created Cruce MVP test and Artifacts independently confirmed initial revision `ac941a64532c5c177c7e85ea42c9d7b697935d9c`. Found and fixed a missing bare-Git fetch refspec; direct live fetches and a real smart-HTTP regression verify repeated fetches, notes, credential-free config and unchanged accepted source. Added bounded retry of stale source checks for idle projects and accurate unavailable-source feedback, with sanitized error-type diagnostics.
- Fixed local bridge startup on the installed Node with a pinned loader and `.mjs` entry point; replaced obsolete OAuth scopes and added optional narrower scopes. Verified startup from an unrelated checkout. Live client registration succeeded, but browser navigation to consent was blocked; no agent grant was issued, and the temporary callback listener was stopped.
- The deployed build passed typecheck, lint and 254 tests across 32 files. Native agent publication/review/promotion, Workers Builds and connected-account gates remain pending; see test-environment.md. No successful live preview or runtime verification claimed.

### 2026-10-05 — first-project welcome

- Replaced the bare creation screen with a dark inline welcome: product purpose, three first steps, a demo link and a distinct project form with storage disclosure and the next action. Existing projects continue directly to their console.
- Verified welcome layouts at 1440/768/390px without horizontal overflow and confirmed creation removes the welcome and opens the project. Typecheck, lint, 251 unit/runtime tests and 18 existing browser scenarios passed. Local fixture screenshots only; no deployment or cloud provisioning.

### 2026-10-05 — live setup verification checkpoint

- Deployed final setup version `dd9a36a3-aa85-4c59-9395-60ef1a35d38a`; the live console cleared the stale source warning, saved a historical intake record (the intake flow has since been removed), opened its record and returned to the overview. Screenshot: `dist/ui-checks/live-test-console.png`.
- Concurrent edits arrived in the shared checkout during verification and were preserved. The current tree passes typecheck and 254 unit/runtime tests; its latest browser run passes 13/17 with four responsive checks timing out on proposal file controls, and lint reports formatting/import errors. No further deployment of those changing files was attempted.
- The first concurrent browser run was also disrupted by development-server reloads. Agent consent remains blocked in the in-app browser; documented a reproducible read-only checkout command for the owner’s regular browser.

## 2026-10-05

- Removed standalone intent records, creation tools, console intake, routes and lineage links. Local agents now register missions directly through MCP with a plan objective and optional context; human prompting stays local.
- Updated coordination operation/capability names, evidence metadata, rollback explanations, onboarding and product documentation. Existing stored context moves onto missions; stored plans migrate without rewriting Git revisions or evidence contents.
- Validation: typecheck and lint passed; all 260 unit tests, 17 browser checks (including responsive pages and agent-created mission navigation), and the demo scenario verifier passed.

### 2026-10-05 — version control for agents positioning

- Updated the README, product thesis, architecture, delivery plan and agent instructions to lead with version control built for agents, powered by Git and Cloudflare Artifacts. Removed the README's repository-host comparison; kept real Git history and revision-linked coordination, verification and deployment explicit.
- Documentation-only change; preserved existing working-tree edits and historical implementation records. Checked the updated wording and patch formatting; runtime checks were not rerun.
- Isolated commit snapshot also passed TypeScript checks, lint and 247 unit tests; unrelated console/environment work remains outside the commit.

### 2026-10-05 — welcome aligned with direct missions

- Refined welcome copy to lead with version control built for agents and explain project creation → local agent connection and prompting → revision review and promotion. The next-step note now directs users to their first agent-created mission; production remains a separate human decision.
- Preserved the dark layout and existing creation behavior. UI TypeScript checks and focused formatting/lint passed; local browser checks at 1440/768/390px confirmed no horizontal overflow and successful creation. Copy-only change, no deployment.

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

## 2026-10-05 — Namespace → Repository → Workspace foundation

- Replaced project/mission/workstream ownership with stable namespace/repository IDs, Access-based personal provisioning, shared membership, teams, email-bound invitations, repository grants and OAuth repository scopes. Namespace policy and atomic reservations govern explicit connected-account resources.
- Added local Git registration, isolated agent worktrees, persistent writer locks plus server reservations, human terminal pairing, 30-second presence, advisory overlap and pinned instruction/structural context. Preserved real commits and explicit Git-pack publication.
- Rebuilt revision-bound changes/reviews/evidence, immutable artifacts, reverse lineage, hosted non-forced promotion and artifact-derived deployments. Added lost-response recovery, token reconciliation, build/runtime correlation, failure/timeout/supersession and rollback validation.
- Replaced the console and fixed-clock demo; removed Flight/radar routes, compatibility controllers, graph dependencies and obsolete token-exporting tools. Preserved reusable source overlays and pre-existing work in `/private/tmp/cruce-before-foundation-20261005.tgz` before the pivot.
- Typecheck, lint, 69 unit/integration tests, eight browser journeys, scenario verification and offline/live builds passed. A concurrent native Git worktree race was found and fixed with a separate cross-process registry lock.
- Deployed the foundation test Worker (`efdce200-c1de-4d68-a8a6-6b98c3850ba5`), retired ProjectDirectory and detached the obsolete queue consumer. Verified Access personal provisioning in the live console. Real Artifacts publication/fork/fetch/retention passed in `cruce-check-muuga1hc`, exact commit `3e72f788d0e6a8f4b1851277e6ae296c7fbbab78`. Successful Workers Builds deployment remains unverified pending a test Worker/build connection; no production deployment was performed.

- Final test deployment: `2d7cbe7d-bdcd-48f1-b21e-4cd7324d9314`. Final suite: 69 unit/integration tests, eight browser journeys, typecheck/lint and deterministic scenario passed. Live discovery/authentication checks confirm public metadata and denial of unsigned MCP/forged human bridge requests. Removed the completed namespace-retirement marker; changes remain uncommitted.

### 2026-10-05 — agent-native console redesign

- Reimagined the console with a dark navigation rail, warm canvas, lime accents, a Git branch motif, and a consistent responsive component vocabulary. Added a separate all-namespaces home with search, repository shortcuts and reported activity across namespaces, plus a dedicated account page.
- Brought agent workspaces, isolated work and exact-revision human decisions forward. Repository overview now includes controller-derived review readiness and distinguishes agent actors; global activity refreshes with cancellation and late-response protection.
- Replaced the namespace/source dropdowns and persistent sidebar creation forms with a namespace chooser and focused, keyboard-accessible dialogs. Retained cloud setup/cost disclosure, controller permissions, repository tabs, deep links and Back navigation. Previews use fictional Fernloop and Alex Morgan identities.
- Validation passed: typecheck, lint, 69 unit/integration tests, 11 browser journeys, deterministic scenario verification and offline production build. Visually checked desktop/mobile home, repository, account and creation flows. Existing working changes preserved; no cloud deployment or commit performed.

### 2026-10-05 — repository finder close-button fix

- Removed an obsolete finder selector that applied full-width result-row styling to the dialog's close button. Result styles remain scoped to the finder fieldset; the close control renders at 38 × 38 px beside the title.
- Verified the visible dialog in the browser; formatting/lint, diff checks and all 11 browser journeys passed. No deployment or commit performed.

### 2026-10-05 — console redesign commit verification

- Isolated the console redesign and finder fix from concurrent workspace-update work, including overlapping UI edits. Prepared only the six console, fixture and progress files against the committed foundation.
- Typecheck, lint, 69 unit/integration tests, 11 browser journeys, deterministic scenario verification and offline build passed for the isolated snapshot.

### 2026-10-05 — persistent Workspace forks and upstream reconciliation

- Built on dedicated hosted writer forks: one fork is reused throughout each Workspace, owned by its namespace. Local-only work stays local until explicit publication; unknown hosted baselines fail before resource provisioning.
- Added controller-derived upstream awareness, read-only Git/path comparison, console inspection and explicit bridge fetching into a Workspace ref. Fetching preserves HEAD, index, dirty/untracked files and remotes; integration remains an explicit Git decision.
- Source artifacts now pin their validated review base independently of the immutable Workspace starting revision. Reconciled proposals use current source without rewriting older artifacts/reviews; uncertain publication retries retain the same base as upstream advances. Agent reports use the last published integration baseline.
- Typecheck/lint, 78 unit/integration tests, 12 browser journeys, deterministic scenario verification and offline Cloudflare build passed. Preserved concurrent console work. No commit/deployment performed; this update has not been live-verified against Artifacts or Workers Builds.

### 2026-10-05 — focused product thesis and validation plan

- Set the initial use case to one developer coordinating several agents on one repository, with less manual relaying, stale/duplicated work and review effort as the outcomes to prove. Retained personal/shared namespaces and the Namespace → Repository → Workspace model.
- Updated the README, product thesis, plan and architecture/artifact documentation. Distinguished existing worktree/review capabilities, implemented Cruce signals and unproven semantic coordination or market-adoption claims. Clarified one reusable hosted fork per writer Workspace.
- Defined a matched-workflow pilot against ordinary worktrees and Git review, including human effort, rework, verification, delivery and setup/resource costs. No application code, infrastructure, deployment or commit changed in this documentation pass.
- Reviewed current Artifacts docs and added a Cloudflare strategy mapping forks, Git transport, scoped access, source inspection, events, Git notes and ArtifactFS to the thesis. Prioritized live reconciliation and measured update awareness; documented connected-account boundaries, pricing/size constraints and which capabilities remain planned.
- Documentation validation: lint and patch whitespace checks passed; all 23 local Markdown link targets across the nine updated documents exist. Application tests were not rerun for this documentation-only pass.

### 2026-10-05 — implementation plan for multi-agent coordination

- Expanded PLAN into sequenced implementation milestones: stabilize upstream reconciliation, add bounded checkpoint context, surface human attention, recover retained source into a new participant's Workspace, verify two independent hosted/OAuth participants and measure the developer workflow.
- Identified concrete code areas and acceptance evidence, preserved immutable source/identity/lock/resource boundaries, and separated real provider checks from browser OAuth participation. Cloudflare events and focused retrieval remain conditional on measured pilot problems.
- Planning-only update; existing implementation and unrelated working changes preserved. No platform resources, deployment or commit created.
- Validation: lint and patch whitespace checks passed; all six local Markdown links in the plan/progress documents resolve. Runtime tests were not rerun for this planning-only change.

### 2026-10-05 — canonical Git foundation and durable workspaces

- Applied the requested Repository → Workspace → agent/task/fork identity. Renamed ownership to Namespace, replaced Session throughout contracts/routes/MCP/UI, and removed optional local-only repository hosting. Existing local execution and upstream-review work was carried forward without compatibility aliases.
- Direct canonical Artifacts forks replace extra baseline repositories. Local worktrees/clones are separate execution contexts. Native HTTPS Git uses current grants, isolated fork write authority and server-only 60-second tokens; canonical writes require reviewed human promotion. Added a standard OAuth credential helper and independent worktree push destinations. Removed custom checkout/refresh and pack-transfer MCP operations.
- Publication seals exact pushed fork revisions into separate immutable artifact storage. Explicit ended-workspace cleanup checks all remote refs, preserves source/provenance and reconciles asynchronous deletion. Artifacts-only account credentials no longer require Workers Builds permission. Added clone/fork controls and updated setup/architecture documentation.
- Validation: typecheck, lint, 88 unit/integration tests (including native Git clone/push/fetch and canonical isolation), 13 browser journeys, reproducible scenario verification and offline cf build passed. Demo source fixtures and commit IDs remain unchanged.
- Not deployed or live-provider-verified: explicit CRUCE_TEST_ACCOUNT_ID/CRUCE_TEST_TOKEN are absent. The updated live verifier is ready for an authorized test account. The narrow Access Git transport exception and renamed Durable Object configuration are unapplied. Gateway transfers are bounded to 32 MiB; Artifacts has no exact-commit fork selector, so base pinning is explicit.
