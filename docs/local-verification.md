# Verification

The loopback fixture (`pnpm dev:fixture`) uses the real console and pure controllers with fixed-clock Git objects. It is isolated from live workspaces. `cf dev --mode offline` runs the actual Worker but does not bypass Access authentication. There is no deployed demo/radar route.

## Executed foundation checks — 2026-10-05

- Type generation and Worker/UI/test TypeScript checks pass.
- Lint passes with the existing Biome configuration deprecation notice.
- 69 unit/integration tests pass: stable ownership, grants/invitations/revocation, session exclusivity/presence, exact-revision review, budgets and uncertain retries, real native Git packs, isolated worktrees, sealed credentials, signed Access/OAuth identity, deployment failure/timeout/supersession, hosted token recovery and runtime-version correlation.
- Eight browser journeys pass: personal workspace/empty local registration, concurrent sessions and overlap, keyboard switching/Back, session provenance, review/attestation, artifact lineage, teams/invitations and mobile layout. Fixture identity/provider behavior is explicitly simulated.
- `pnpm verify:scenario` reproduces new fixture commit IDs and verifies the retained auth-service overlays using ordinary Git and Node tests. The script fixes author/committer timestamps, disables signing/hooks only for the disposable process and uses stable merge messages.
- Offline and configured live builds/dry runs pass.

Browser screenshots are in ignored `dist/ui-checks/`. Live integration metadata is in ignored `dist/live-verification/result.json`; it contains no credentials. Source snapshots created during live checks are retained for provenance.

## Live resource check

`pnpm verify:cloud` is opt-in. It requires explicit `CRUCE_TEST_ACCOUNT_ID` and `CRUCE_TEST_TOKEN`, consumes up to three resource reservations, and creates an isolated namespace in that account. The script uses the real workspace controller, sealed ResourceBoundary, repository runtime, REST adapter and Git transport. It provisions a `trunk` repository, creates a hosted session fork, publishes an exact commit pack, fetches the artifact independently and verifies retention after session completion. It never deploys production or falls back to a control-plane credential.

Executed successfully against the configured test account. The exact revision was `3e72f788d0e6a8f4b1851277e6ae296c7fbbab78` in isolated namespace `cruce-check-muuga1hc`. This verifies real Artifacts behavior through the adapter. It is separate from an agent's browser OAuth consent journey and from Workers Builds deployment verification.

The new test Worker was deployed and its signed-in console verified to create a personal workspace with an honest empty repository state. A successful Workers Builds deployment, runtime smoke check and production rollback remain unverified live until a test Worker/build connection is supplied. Passing mocked failure/rollback tests does not establish that configuration.
