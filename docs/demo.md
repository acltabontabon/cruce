# Demonstrations

The native console is `/`. The deterministic coordination demo is isolated at `/demo`; its auth-service revisions and scenario verifier are unchanged. It demonstrates the retained scheduling engine, not native missions, proposals, verification or deployment.

## Native lifecycle (offline tests)

`test/worker/project-runtime.test.ts` runs the native lifecycle against real Git objects with a mocked Artifacts transport:

- a project is provisioned explicitly; reading an unprovisioned project creates nothing;
- a mission starts from an accepted revision and gets one workspace fork;
- a local commit is published as a Git pack and recorded as the exact revision the agent produced;
- evidence, a proposal (#1, exact base and revision), human attestation and review lead to a non-forced promotion;
- a Worker preview of the exact revision is built (Workers Builds mocked) and Cruce's smoke checks become runtime-verified evidence;
- metered previews require human approval when policy says so;
- one human decision promotes and deploys production; lineage traces the deployment back to the mission and agent; rollback is explained as the proposals it removes and redeploys an earlier accepted revision;
- two missions refresh after a promotion while preserving both histories.

## Native narrative (live)

A developer asks their local Claude Code agent to add rate limiting to Customer API. The agent reads `get_project` and `get_active_work`, registers its plan with `create_mission`, reads `get_context`, and calls `start_mission` (base pinned to the canonical revision, workspace fork created), changes code, runs `npm test` and `cf dev` locally, commits, and calls `publish_revision`. It publishes the test report with `publish_artifact`, creates proposal #1 and calls `request_preview`. Cruce checks policy and budgets, pushes the exact revision to the deploy repository, waits for Workers Builds and runs smoke checks. A security agent attaches evidence for the same revision. The human sees proposal #1 with its revision, files, verification per revision and resource impact, approves, and chooses **Promote and deploy to production**. Production runs that revision, and lineage leads from production back to the mission. A live release demo must label reported, human-attested and runtime-verified results and never substitute scripted messages for real execution.

## Deterministic coordination demo

Three scripted agents, one deterministic story, using Artifacts or the offline local Git backend. Every
decision is the controller's; the script only says what each agent *attempts*. Commit ids are reproducible
across runs.

The controls below describe the current checkout. The hosted MVP may be an earlier version until
this refinement is deployed; use the local preview for this walkthrough.

## Driving the demo

Open [Cruce](https://cruce.acltabontabon.workers.dev) (or `pnpm exec cf dev` →
[localhost:5173](http://localhost:5173); use `--mode offline` for local Git without credentials).

A fresh demo prepares the first seven steps and pauses at the useful overlap: three tasks are working,
JWT library migration goes first on `TokenValidator`, and refresh-token rotation continues elsewhere.
Work is the default view. Existing shared demo progress is preserved when another browser opens it.

| Control | |
|---|---|
| Continue demo / Pause | continue from the current state / pause automatic advancement |
| Demo options → Next step | advance once, then stay paused |
| Demo options → Reset to overlap | reset canonical and run repositories, then prepare the paused overlap again |
| Demo options → Replay from beginning | reset and automatically replay all 18 steps |
| Demo options → Playback speed | 0.5×, 1×, 2× or 3× |
| `main` and commit reference | repository history and coordination notes |
| Task in Work | plan, scope, coordination, activity, changes and advanced run details |
| Overlap / Why? | controller evidence, sequencing and contextual overrides |
| Traffic | optional active-scope graph; select tasks, crossings or code areas for details |

Reset/replay recreate run repositories and are limited to one reset every 45 seconds. Demo commands
and alarm advancement are serialized. Overrides affect real controller decisions, so later scripted
attempts may be rejected or fail; errors remain visible. Use Reset to overlap to restore the story.

The agents and their progress/test reports are scripted. Plans, clearances, publish gates, Git diffs
and merges are real. A displayed demo test report is not a test command executed by the browser; use
the scenario verification below to check the actual code.

## The story (18 steps)

| # | Step | What Cruce does |
|---|---|---|
| 1 | Three Missions are delegated | F-021 refresh-token rotation, F-022 JWT library migration, F-023 session cleanup |
| 2 | Each Flight gets its own Artifacts fork | `auth-service--f021/22/23` forked from canonical; fork tokens revoked |
| 3 | Discovery | agents read; no airspace claimed yet |
| 4 | F-023 files its plan | independent → **CLEAR** automatically |
| 5 | F-022 files its plan | contract change on `TokenValidator.validate` → **CLEAR** |
| 6 | F-021 files its plan | wants to modify `TokenValidator.validate` and assumes its contract is stable → congestion (L1 structural + L3 contract, critical). **F-022 has right-of-way (contract owner).** F-021 → **PARTIAL CLEARANCE**: ✓ `AuthService.refreshToken`, ✓ `RefreshTokenRepository`, × `TokenValidator.validate` |
| 7 | Flights execute | F-021 keeps working on the cleared parts |
| 8 | F-023 publishes | publish gate approves; 60 s token → push → revoke; tests reported |
| 9 | F-021 tries to publish beyond its clearance | gate **rejects**: `AuthService.logout` is outside the cleared route |
| 10 | F-021 requests airspace | plan amended (+ `AuthService.logout`) → re-evaluated → cleared |
| 11 | F-021 publishes its cleared work | approved (still PARTIAL: validate on hold) |
| 12 | F-022 publishes | approved |
| 13 | **F-022 lands** | preflight clean → real merge into canonical + note → **F-021 STALE**: "TokenValidator.validate contract changed", "assumption no longer holds" |
| 14 | F-023 lands | independent; F-021 unaffected |
| 15 | Cruce refreshes F-021 | canonical merged into `auth-service--f021` (its published work preserved) |
| 16 | F-021 amends its plan (v3) | `TokenValidator.validate` is now a **read** (F-022's ValidationResult carries the token id) → **CLEAR** |
| 17 | F-021 publishes the rotation | approved |
| 18 | F-021 lands | canonical has all three Flights; history + notes show every decision |

Why the sequencing mattered: F-021's final code uses F-022's new `ValidationResult`. Run
`bash demo/scripts/verify-scenario.sh` — F-021's last step **fails its tests on the old baseline** and
passes after F-022 lands. Cruce avoided that rework before any code collided.

## Walkthrough (5–7 min)

1. **Recognize the work.** Open Work at the paused overlap. Point out `auth-service`, the three tasks,
   the automatically coordinated overlap and no required human decision.
2. **Explain the decision.** Open refresh-token rotation: it can continue on its independent scope
   while `TokenValidator` waits. Open Why? to show the contract-owner rule and evidence.
3. **See the crossing.** Open Traffic. Show the two authentication routes crossing and the independent
   session task. Keep infrastructure and raw access sets in advanced details.
4. **Continue the story.** Step through publishes and the rejected `logout` change (steps 8–12).
   The agent amends its plan; the publish gate approves only work inside clearance.
5. **Show adaptation.** Steps 13–18: JWT work integrates, rotation's baseline becomes stale, Cruce
   refreshes it, the agent files plan v3 and completes. Completed tasks move to Recent.
6. **Inspect the result.** Open a completed task's Changes and repository history. The diff, commit and
   Git notes tie the code to the coordination decisions. Run `bash demo/scripts/verify-scenario.sh` for
   the actual tests, or `tools/verify-repo.sh auth-service cruce` to clone and verify the Artifacts result.

Use Replay from beginning if the audience also needs to see task creation and initial discovery.
