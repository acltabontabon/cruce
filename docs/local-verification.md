# Verification and evidence

[Documentation map](README.md) · [Contributor checks](../CONTRIBUTING.md#verify) · [Test environment](test-environment.md)

This page records what checks establish, the evidence retained for current capabilities, and the acceptance work still outstanding. It is not a chronological implementation log. Detailed earlier runs remain in Git history and their named receipt directories.

**Implemented** means code exists. **Locally verified** means local checks passed. **Provider-tested** means real storage was used under the stated harness authority. **Deployed** means a build was published; it does not imply authenticated behavior passed. A **live-verified** claim must name its environment, revision and authority. These labels are separate from the domain's `reported` and `human_attested` evidence trust.

## Local checks

Run from the repository root:

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm test:browser
pnpm verify:scenario
pnpm exec cf build --mode offline
```

| Check | What it establishes | Limits |
| --- | --- | --- |
| Typecheck and lint | Worker, UI, runner and test contracts; repository formatting and static rules | No runtime or hosted proof |
| Unit/integration suite | Controller decisions, authority, recovery, adapters, local bridge and native Git fixtures | Provider effects and identity are simulated unless explicitly stated |
| Browser suite | Real console/controllers in an isolated fixed-clock fixture, navigation, permissions, review, retries and responsive layouts | Authentication, Artifacts and promotion are simulated; no live namespace access |
| Scenario verification | Reproducible Git history, concurrent work, failed evidence, reconciliation and fresh review | Deterministic local source fixtures |
| Offline cf build | Build/package/configuration viability without cloud provisioning | No hosted binding or authentication proof |
| `pnpm verify:limits` | Local SQLite byte/query behavior, archive paging and bounded Git transfer handling | No Worker peak memory/CPU or provider throughput proof |
| `pnpm release:check` | Package version, changelog and optional exact release tag | No deployment or acceptance proof |

The most recent recorded full local run for the retention fix on 2026-10-09 passed typecheck, lint, **428 unit/integration tests**, browser journeys, scenario verification and the offline build. The loading-state run at `700d17c` separately passed **427 unit/integration tests and 98 browser journeys** in a clean worktree. Counts belong to their tested revisions and do not describe every later working tree. Successful builds reported unavailable Docker; lint reported its existing Biome deprecation notice.

Documentation audit on **2026-10-09**, based on `caeb4a6`: **381 local links/anchors**, typecheck, **429 unit/integration tests**, **98 browser journeys**, scenario verification, the offline build and tracked-file Biome checks passed. Initial sandboxed runs were denied local socket/IPC access; reruns with that access passed. Full `pnpm lint` remains blocked by formatting in the pre-existing untracked `.bridge-lib.ts`, which was preserved and excluded from the commit. No provider operation or deployment was performed.

Hosted sign-in on **2026-10-09** moved to GitHub through Access: the browser application admits only the GitHub provider with Instant Auth, its audience and single-email admission policy read back unchanged, and a signed-out `/auth/login` redirected to GitHub's authorization page with the updated login footer. One-time PIN stays configured but unselected. No Worker deployment was involved, and a completed GitHub sign-in into an existing account was not exercised by this check.

Browser captures are written to ignored `dist/ui-checks/`. See the [walkthrough](local-demo.md#refresh-these-screenshots) for publishing refreshed sample images. Browser replay-history coverage remains incomplete; long-gap lane spacing has unit coverage.

## Current evidence at a glance

| Capability | Recorded result | Remaining acceptance |
| --- | --- | --- |
| Exact-base approval/promotion and durable journals | Controller/runtime/native Git coverage; earlier authenticated single-writer and two-tool hosted promotions | Current installation binding's promotion race, interrupted remote outcome and settlement recovery |
| Current binding publication and review notes | Hosted Codex publication, republishing, cited replies and human note resolution on 2026-10-09 | Installed-client execution of the `address_review_notes` prompt; publication fault windows |
| Retained source and fork cleanup | Hosted fork deletion followed by source recovery without the fork on 2026-10-09 | Cross-actor console continuation of an agent-started deletion; broader authority/failure cases |
| Repository deletion | Local lifecycle/recovery coverage; hosted removal of four Artifacts repositories and subsequent autonomous deletions on 2026-10-08 | Full failure, authority-change and identity-replacement matrix |
| Shared namespace deletion | Local multi-repository coverage; hosted signed-in deletion of an empty shared namespace | Namespace-to-repository cleanup with nonempty hosted storage and interrupted effects |
| Cache-only coordination reads | Actual SQL/HTTP/MCP/terminal local tests reject writes and provider calls, including cold starts | Hosted read-purity audit |
| Push observation | Local ordering, deduplication, identity and gap-recovery coverage; hosted subscription setup/current-ref inspection | Real push delivery timing, delivery-gap recovery and authenticated approval/promotion in that run |
| Account-level setup and connections | Local OAuth consent, checkout resolver, user-level client setup, concurrent refresh and packaging coverage; hosted reauthorization used for review notes | Two-repository cloning after one login, each installed client's launch context and physical cross-machine continuation |
| Console and loading states | Local browser coverage; anonymous hosted assets and public splash inspected | Signed-in hosted splash/progress and complete responsive/authority journeys |

## Retained-source proof on Cloudflare Artifacts

On 2026-10-09 the test environment could not prove any fork ref retained: `inspect_source` and `recover_source` returned “Retained source ref differs from the recorded revision.” Read-only provider inspection showed that Artifacts source reads resolved `main` but not `refs/heads/main`. Binding and REST readers now use the resolving branch name, and retention search continues past a moved ref to another retained ref.

Regression coverage lives in [Artifacts](../test/worker/artifacts.test.ts), [binding](../test/worker/deployment-storage.test.ts), [source inspection](../test/worker/source-inspection.test.ts) and [cleanup continuation](../test/runner/cleanup-resume.test.ts) tests; the new cases failed before their fixes.

Hosted Worker **`afb692eb-2ca8-4ce4-9b33-d28ff5e0b97f`**, from **`3a60b07`**, proved all four refs retained for workspace `3ec1f6d4…-0`. Resuming its recorded cleanup through the bridge reached confirmed deletion on the third attempt; the provider independently reported the fork absent. `recover_source` then recovered workspace head **`e3e597ee`** and canonical **`a7f2b36c`** from retained storage without the fork. The Repository DO served the prior version for about six minutes after deployment.

[ADR 0015](decisions/0015-resuming-a-recorded-fork-deletion.md) continuation by another eligible actor has controller/runtime tests: wrong authority or a new key is refused, the owner resumes the recorded command, and both drivers' reservations settle with deletion. That cross-actor console flow is not yet hosted-verified.

## Review notes and the calmer change review

On 2026-10-09, the implementation passed the full local checks with **425 unit/integration tests and 97 browser journeys**. [Review-note tests](../test/core/review-notes.test.ts) cover exact revisions/anchors, blocking concerns, nonblocking comments, human-only reasoned resolution, inherited notes across superseding changes and record limits. [Prompt tests](../test/worker/mcp-prompts.test.ts), [bridge tests](../test/runner/coordination.test.ts), [diff tests](../test/ui/diff-model.test.ts) and browser journeys cover tool scopes, caller-specific guidance, exact-line presentation and review through promotion.

On hosted Worker **`04eaa58a-830b-43e9-9ace-5563865a7528`**, from **`558dc17`**, a reauthorized Codex connection used the bridge in `coordination-signals`, namespace `c123-verification-20261007`: publish/propose #1, receive a line concern, read the `Cruce:` lead and prompt hint, fix the code, republish/propose #2 and reply citing it. The concern carried forward as answered and still blocked readiness. Wrong revisions, outside anchors and unpublished citations were refused. The owner resolved it in the signed-in console; subsequent reads recorded human resolution and zero remaining concerns. Hosted MCP listed `address_review_notes`; a client running that prompt was not exercised.

## Exact-base promotion verification

[Convergence](../test/worker/convergence.test.ts), [runtime](../test/worker/repository-runtime.test.ts) and native Git tests cover advertised expected-base guards and a non-forced ref update, including a moved base, an attempted-but-unsent update, loss of response/persistence/settlement and recovery after later evidence or policy changes. Recovery observes attempted updates instead of pushing them again. These tests do not establish current binding behavior under hosted faults.

## Durable provider identity verification (F2)

[Identity-journal tests](../test/worker/provider-identity.test.ts), [binding tests](../test/worker/deployment-storage.test.ts) and runtime tests cover canonical, direct fork and retention IDs, creation reply loss, mismatching state/journal identities and recreated names. Unknown or unrecorded identity fails closed. Name-addressed Git transfers and identity checks are not atomic. Current binding identity-replacement/restoration acceptance remains pending.

## Pure coordination read verification (F3)

[Read-purity tests](../test/worker/read-purity.test.ts) use actual SQLite adapters through HTTP, MCP and terminal routes, including cold/empty objects, missing source and restarts. They reject schema creation, metadata/counter/alarm writes and provider calls for catalog coordination reads. Explicit sign-in owns identity initialization; explicit setup/retry owns repository initialization. Authentication certificate refresh and ordinary Git transport are separate I/O boundaries. Hosted read-purity acceptance has not been run.

## Bounded source inspection and cache recovery (F4)

[Source-inspection tests](../test/worker/source-inspection.test.ts) cover complete/partial cache loss, corrupt objects, second-parent ancestry, exact diff/pack recovery, shallow/incomplete graph refusal, moved retained refs, identity mismatch, byte/entry limits and whole-generation eviction. Runtime tests cover current scope/policy and one reservation per retry, promotion/publication recovery and evidence reconstruction. Native provider fixtures cover bounded file/tree/evidence reads and labelled first-parent history without cache initialization.

The hosted retained-source result above closes the specific recovery-after-fork-deletion gap. Current binding native file/history acceptance, second-parent/evidence recovery and an attempted promotion across cache loss remain separate checks. Local limits are in [architecture](architecture.md#bounded-source-inspection-and-recovery); peak decompression memory/CPU is unmeasured.

## Bounded state and authorized retention recovery (F6)

[State-storage](../test/worker/state-storage.test.ts), runtime, read-purity and lifecycle tests cover indexed records/cursors, transaction rollback, byte/count admission, archive reads, reserved recovery capacity, exact retries, complete ref inventories and deletion fault windows. Cleanup alarms recheck current authority, policy and identity; elapsed time never starts deletion. Current observations replace earlier ones; finished work moves to readable archive bundles ([ADR 0009](decisions/0009-replaceable-observations-and-archived-finished-work.md)).

`pnpm verify:limits` writes `dist/state-verification/measurements.json`. Its supported workload models ten attached workspaces at 30-second reporting, then archives 1,000 finished workspaces and pages them back. Earlier measurements based on accumulating observation receipts were superseded by the replaceable-record design. Local measurements do not establish hosted alarm redelivery, KV propagation, provider throughput or Worker memory/CPU at the [capacity limits](architecture.md#bounded-coordination-state-and-retention-recovery).

## Diagnosable operations and safe errors (F5)

[Diagnostics tests](../test/worker/diagnostics.test.ts) and public-error/route/MCP tests cover the message allowlist, sanitized validation, provider failures, concurrent correlation and retry/settlement phases. Typed identifiers are unkeyed SHA-256 digests: they support pseudonymous correlation, and someone with log access can confirm a guessed ID. No credential, source, provider body or OAuth payload belongs in public errors/logs. Hosted induced failures, log/trace acceptance and secret rotation remain unverified.

## Coordination observation and reconciliation (C1–C3)

Local tests cover duplicate/reordered pushes, rewind/deletion, four-target recovery batches, incomplete inventories, policy denial, authority loss, uncertain subscription creation and settlement. Reconciliation covers all-parent ancestry, unpublished baselines, missing/corrupt objects, traversal bounds and independent report freshness.

On 2026-10-07, the deployed test Worker installed both Queue consumers. After a native fetch receiver repair, subscription **`1e798aa64d48440f99c4a1c4718595f8`** was created at **13:49:04 UTC** for repository **`eef6af647a0b823620c63e50435fc315`**, namespace **`064758358943726a14e947d573ef91ea`**. The console showed healthy current-ref inspection. Receipts are in ignored `dist/c123-verification/`. Observation was then explicitly disabled and subscription removal independently confirmed.

No real fork push, publication or promotion was performed in that observation run. The 60-second ordinary-visibility and 15-minute gap-recovery targets have no measured hosted result. Acceptance must record exact pushed/published/accepted revisions, delivery times, gap recovery, authenticated human approval and independent Git checks. Operational value, false alarms and missed interactions remain unmeasured; C4 needs two independently reviewed real misses before analyzer work.

## Deployed gateway verification

On 2026-10-06, Worker **`43a25e51-a168-4bb2-bfd2-bf40fe36ec74`** (`c006ce5f…` plus consent/Git repairs) passed one real OAuth writer through Access-approved setup, native Git, exact source/evidence publication, completed-operation response-loss replay, authenticated human approval/attestation/promotion and fork deletion with independent retained-ref retrieval. Tests also exercised token downscoping, whole-grant revocation and explicitly revoked provider tokens before expiry. Receipts are in ignored `dist/deployed-verification/`.

This run used the earlier connected-account storage model. It does not verify current binding promotion/recovery, a second client, membership changes or revocation of an already-running provider operation. See [the staged verifier](../tools/verify-deployed.ts); its browser decisions remain outside agent authority.

## Deployed multi-tool participation (D2)

On 2026-10-06, Worker **`9e63bfe6-e5b4-4f6d-8089-6194fab838a8`** (`243dd28` plus credential/OAuth fixes) coordinated real Claude Code and Codex sessions in **`d2-proof`**, repository **`e0ea9d54fab24610914af0c7f349a7da`**, namespace **`22b5c94f4b1908e6263fb68948edfeee`**. They used independent forks at baseline **`c1bef890`**, showed advisory overlap, and continued one workspace across tools/connections/checkouts with its baseline unchanged. Human approval/attestation promoted **`26aedbb7`**; the other proposal became stale, Codex explicitly merged and verified, and fresh human review promoted **`4e07c4d3`**. Independent Git reads matched both promotions. The read-only auditor's eight invariants passed; receipts are in ignored `dist/d2-participation/`.

Both checkouts were on one Mac. This proves cross-checkout/tool continuation, not physical cross-machine continuation. Cleanup, response loss and membership/grant changes were not exercised. It predates installation-managed storage and current account-level client setup; the run's temporary Codex launch override is not today's setup procedure.

## Opt-in real provider check

`pnpm verify:cloud` requires explicit `CRUCE_TEST_ACCOUNT_ID` and `CRUCE_TEST_TOKEN`. It has no operator-credential fallback. Read [the harness](../tools/verify-cloud.ts) first: it consumes real resources and retains canonical/source/evidence. If credentials are in ignored `.env.test`, load them explicitly with `node --env-file=.env.test --import tsx tools/verify-cloud.ts`; never print them.

The two-writer scenario declares a **20-reservation maximum per isolated run** and at most **six provider repositories**: provisioning, three forks, five source/evidence pairs, three promotions and three cleanups. Successful cleanup leaves canonical/source/evidence. This is a harness resource envelope, not a product daily budget or dollar estimate; provider requests/tokens are not one-to-one with reservations. Review provider pricing before running.

The harness uses real Artifacts through the REST adapter with in-process fixture human authority. It verifies Git, retention and promotion under that authority; it does not verify the deployed binding, browser approval, OAuth gateway or actual agent interoperability. Results go to ignored `dist/live-verification/result.json`; failures preserve non-secret state and uncertain resources in `failure.json`. Earlier real-provider two-writer receipts apply to their recorded revision and connected-account model.

## Record a claim precisely

Record the date, tested commit/build and dirty flag, environment, authority/storage model, exact source revisions, checks and limitations. Keep tokens and source out of diagnostic output. Do not turn a previous success into a current acceptance claim, or a deployment into behavioral evidence. Update this summary when its evidence changes; keep implementation chronology in Git and user-facing changes in the changelog. Storage transitions, retained-resource cleanup and charged uncertainty require explicit reconciliation.
