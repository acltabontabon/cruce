# Verification and evidence

[Documentation map](../README.md#documentation-map) · [Contributor checks](../CONTRIBUTING.md#verify) · [Test environment](test-environment.md)

Use separate evidence for pure decisions, local integration, real provider behavior and real participant behavior. Passing one layer does not establish another.

## Local checks

| Command | What it checks |
| --- | --- |
| `pnpm typecheck` | Generated Worker types and Worker/UI/test TypeScript projects |
| `pnpm lint` | Repository Biome checks |
| `pnpm test` | Controller decisions, identity/grants, resource retries, Git transport, bridge isolation and Artifacts adapter behavior |
| `pnpm test:browser` | Isolated console journeys, permissions, navigation and responsive layouts with Playwright |
| `pnpm verify:scenario` | Reproducible scenario commit IDs plus reusable auth-service overlays verified by ordinary Git and Node tests |
| `pnpm exec cf build --mode offline` | Worker/console build without configured cloud provisioning |
| `pnpm release:check` | Version and changelog consistency |

The loopback fixture (`pnpm dev:fixture`) uses the real console and controllers, fixed time and deterministic Git objects. Authentication and provider behavior are simulated. The actual Worker (`cf dev --mode offline`) still requires Access for authenticated work; no deployed demo route or authentication bypass exists.

The scenario scripts fix commit timestamps and isolate signing/hooks for their disposable repositories. Preserve fixture source and reproducible IDs. Browser screenshots go to ignored `dist/ui-checks/`.

## Recorded status — 2026-10-05

After removing the deployment domain on 2026-10-05, typecheck, lint, all 95 unit/integration tests, 14 browser journeys, deterministic scenario verification, the offline build and release metadata checks passed. The five local walkthrough screenshots were refreshed. Cloudflare type generation, Git protocol tests and browser/build checks ran with local socket access after the sandbox blocked type generation. Lint reports an existing Biome configuration deprecation notice; it passes. No live verification was rerun.

Earlier local evidence recorded 88 unit/integration tests and 13 browser journeys before this removal. Provider results below are preserved from repository history at the canonical Git foundation (`8c1dfdd`); they do not verify this change.

| Layer | Latest recorded evidence | Remaining boundary |
| --- | --- | --- |
| Current coordination boundary, local | Typecheck/lint, 95 unit/integration tests, 14 browser journeys, deterministic scenario, offline build and release metadata checks passed | No live Worker/provider conclusion |
| Native Git, local protocol fixture | Clone canonical, push/fetch isolated fork, reject canonical push | Does not prove live Access routing or deployed OAuth |
| Earlier real Artifacts adapter | Revision `3e72f788d0e6a8f4b1851277e6ae296c7fbbab78`, namespace `cruce-check-muuga1hc`; isolated fork, exact publication, independent fetch and retention | Preceded current namespace/native-Git refactor; does not verify the current gateway or reconciliation flow |
| Earlier live control plane | Version `2d7cbe7d-bdcd-48f1-b21e-4cd7324d9314`; owner sign-in/provisioning and authentication rejection checks | Older model; current code and Git transport exception not recorded as deployed |
| Heterogeneous-agent participation | Pending | Two real authorized tool connections and context consumption need verification |

The current foundation's live check was not run because explicit test-account credentials were absent. Historical counts describe their tested revision, not a promise about every future checkout.

## Opt-in real provider check

`pnpm verify:cloud` requires explicit `CRUCE_TEST_ACCOUNT_ID` and `CRUCE_TEST_TOKEN` for an authorized test account. It never falls back to an operator credential. Inspect [tools/verify-cloud.ts](../tools/verify-cloud.ts) before running: it consumes real resources, uses in-memory control state/grants and a real sealed resource adapter, and retains hosted source.

The current successful single-writer path reserves four logical operations: canonical provisioning, fork attachment, source publication and fork cleanup. Its configured policy ceiling is ten. Native Git goes directly through the provider adapter in this script; token creation, Git requests and other provider calls are **not** a one-to-one match for Cruce reservations or a dollar estimate. An expanded two-writer or live-gateway test must declare its own budget.

The script checks a `trunk` repository, native clone/push/fetch on a workspace fork, exact publication, unchanged canonical head, independent artifact fetch, retention after workspace end and explicit fork deletion. It writes non-secret results to ignored `dist/live-verification/result.json`. Retained canonical/artifact source remains for provenance; failure leaves resources for diagnosis. It does not exercise the deployed OAuth/Git gateway, browser consent or human promotion.

## Record a claim precisely

For live work, record the date, tested commit/build, environment, provider namespace, exact source revisions, checks performed and remaining failures. Keep credentials out of results/logs. Verify current namespace access, isolation and token revocation; do not infer them from a client label. A two-agent reconciliation trial needs actual participants and fresh review after upstream integration. A deployed control-plane Worker proves nothing about external CI, release or runtime systems; those are outside Cruce’s boundary.

Update this status table when the verified implementation changes. Keep detailed check output and limitations with the review; user-facing changes belong in the changelog. This boundary change does not provision, deploy or rerun live verification. Before a later hosted rollout, explicitly retire the former deployment workflow and discard obsolete development state; no compatibility reader or migration is provided. Preserve retained canonical/source artifacts and reconcile any charged reservations before deleting cloud resources.
