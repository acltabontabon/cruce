# Cloudflare setup

[Documentation map](../README.md#documentation-map) · [Architecture](architecture.md) · [Test environment](test-environment.md)

Cruce uses Cloudflare Workers, Durable Objects and Artifacts for durable Git coordination. Configure infrastructure once per installation. Namespace users and agents authenticate to Cruce; they do not need Cloudflare accounts or provider API tokens. Execution stays in their existing environments.

## Installation configuration

Use the installed `cf` CLI and [cloudflare.config.ts](../cloudflare.config.ts). Terraform and Wrangler project commands are not required. See [ADR 0003](decisions/0003-deployment-managed-storage.md) for storage authority and the replacement of namespace account connections.

1. Install dependencies with `pnpm install --frozen-lockfile`. Authorize `cf` in the installation account using `cf login`, or supply a deployment API token privately in CI. This is administrator setup, once for the installation.
2. Copy [.env.example](../.env.example) to an ignored installation environment file. Set `CLOUDFLARE_ACCOUNT_ID`, `CRUCE_PUBLIC_ORIGIN`, `CRUCE_ACCESS_ISSUER` and `CRUCE_ACCESS_AUD`. Choose a stable `CRUCE_ARTIFACTS_NAMESPACE` (default `cruce`) and `CRUCE_WORKER_NAME` (default `cruce`). No account ID or personal hostname is built into the configuration.
3. Validate with `node --env-file=.env.test tools/installation-config.mjs`. This validates configuration only; it creates no resources and prints no credentials. Live builds and deployments require a public HTTPS origin and Access configuration.
4. For a fresh Worker, provide a strong `CRUCE_SECRET` through `cf deploy --secrets-file` using an ignored secrets file. Preserve that secret for existing installations; setup never rotates it automatically. Configure Access for the installation's origin as described in the [test environment guide](test-environment.md#public-homepage-access-configuration), adapting the reviewed paths to your own hostname.
5. Run `node --env-file=.env.test node_modules/cf/bin/cf deploy --mode production --dry-run`, then the authorized deployment through `pnpm deploy:test` or the [release pipeline](releases.md). For exported environment variables, `pnpm deploy` validates before deploying. These commands deploy Cruce itself, not repositories coordinated by Cruce.

Configuration declares the Worker, assets, Directory/Namespace/Repository SQLite Durable Objects, OAuth KV and an `ARTIFACTS` binding. Re-running deployment reuses the configured infrastructure. Artifacts documents automatic creation of a missing physical namespace when the first repository is created; setup does not need a separate namespace creation request. Runtime resource creation still requires an explicit authorized repository or workspace operation.

Workers binding calls use configured runtime authority without a provider API token. Git transport uses repository-scoped 60-second tokens, revoked after use; creation/fork tokens are reconciled and revoked. Provider tokens stay server-side. See [Artifacts authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/) and [cf configuration](https://developers.cloudflare.com/cf/projects/config-explorer/).

## Namespace storage

Namespace account connection and verification endpoints and the token form are removed. Every application namespace inherits the installation binding. Membership, repository grants, capability scopes and atomic namespace reservations still gate all resource operations; repository policy only narrows namespace policy.

The physical Artifacts namespace is installation infrastructure, distinct from a Cruce application namespace. Stable application namespace IDs prefix physical repository names (`ns-<namespace-id>-<logical-repository-name>`). Display names, handles and local paths do not determine storage identity.

First resource use durably records the installation account ID and physical namespace. Changing either later fails closed before provider access. Restoring the recorded configuration restores access. Existing connected-account records also block resource access; this change does not migrate, delete or silently redirect retained source. An administrator must plan an explicit transition for an existing deployment. Test deployments must preserve their retained canonical/source storage and reconcile charged uncertainty before any cleanup.

Repository resource operations also validate durable provider repository IDs. Canonical, workspace forks and source/evidence retention IDs are recorded before token cleanup or Git access, and remain recorded after cleanup. Recreating a physical name with a different ID blocks access even if its description and URL match. Missing recorded repositories are not automatically recreated. A lost creation response before its ID was saved, or existing retention with no recorded ID, requires administrator reconciliation; Cruce does not adopt the current name as proof. Restoring the recorded binding and original repository identities permits the original operation to retry with its charged reservation and provenance intact. No automatic storage transition or repair tool is provided.

Cloudflare usage is billed to the installation account. Namespace operation budgets are application policy limits, not dollar estimates. The operator manages account-wide cost and capacity; no per-customer billing or automatic cleanup is introduced. Uncertain operations remain charged until reconciled with their original identity.

## Control plane

Access protects browser sign-in, consent, pairing approval, invitations and namespace APIs. The public document/assets and cookie-verified `/auth/session` let the homepage render before sign-in. Native Git uses the narrow `/mcp/git/*` browser-challenge exception while Cruce authenticates each request. Review [public homepage paths](../tools/access-public-homepage.json) and [Git transport paths](../tools/access-agent-transport.json) for your own Access application. Deployment configuration does not provision Access policies automatically.

Sign out expires the Cruce cookie and redirects to `/cdn-cgi/access/logout`, ending Access sessions across applications in the same team. It does not revoke Cruce OAuth connections or alter namespace membership.

### Access login branding

The existing Access email-and-one-time-code screen can use Cruce's identity without changing authentication. In **Zero Trust → Reusable components → Custom pages → Access login page → Manage**, set the organization name to **Cruce**, use the publicly accessible `/brand/symbol-ink.svg` at your installation's HTTPS origin as the logo, and use the paper background (`#F5F5EF`) and forest text (`#17251F`). Set the header to **Sign in to Cruce** and the footer to **Use your email to receive a one-time sign-in code.** The [reviewable payload](../tools/access-login-branding.json) contains the hosted installation's values; replace its logo origin for your own installation.

These settings apply to every Access application in the same team. Cloudflare retains its own login layout and provider branding. See [Access login customization](https://developers.cloudflare.com/cloudflare-one/reusable-components/custom-pages/access-login-page/) and the [organization update API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/update/).

For CLI administration, read and back up the organization with `cf zero-trust organization get` first. Apply the payload with `cf zero-trust organization update --body`, including the **existing** `auth_domain` in the JSON body; the API requires it even for this appearance change. Keep issuer, audience, admission policies, identity providers and session settings unchanged, then independently read back the organization. Set the existing browser application's display name to **Cruce** if desired, preserving its ID and all authentication configuration. Verify the logo loads anonymously and the hosted sign-in still presents its email form. Branding is separate from Worker deployment and does not provision Access policies.

For local UI/controller checks use `pnpm dev:fixture`; for an offline Worker build use `pnpm exec cf build --mode offline`. Offline mode omits the Artifacts binding and permits no cloud storage provisioning. [.dev.vars.example](../.dev.vars.example) describes local identity settings.

## Limits and costs

Artifacts documents limits of 1 GB per repository, 32 MB per file/blob and 1 TB per account as reviewed on 2026-10-06. See [current limits](https://developers.cloudflare.com/artifacts/platform/limits/) and [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) before estimating capacity or cost. Cruce also bounds each Git gateway request/response to 32 MiB. Git cache growth and reachable-pack export still need representative measurement.

## Source inspection, observation and import

Cache-only coordination inspection uses the bounded derived Git cache in the Repository DO. Explicit `inspect_source` uses identity-checked binding commit/tree/file/history APIs for equivalent views; `recover_source` restores retained exact Git source after cache loss. Both pass the namespace `source.read` policy/budget gate. Provider history is labelled first-parent and never substitutes for complete ancestry. Cache generations are bounded and evictable without deleting remote retention or metadata; see [limits and recovery](architecture.md#bounded-source-inspection-and-recovery) and [F4 local evidence](local-verification.md#bounded-source-inspection-and-cache-recovery-f4). Hosted binding recovery and peak-memory acceptance remain unverified.

[Artifacts events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) deliver repository push subscriptions to installation-owned Queues. `cloudflare.config.ts` configures `<worker>-artifact-events` and its `-dead` queue, with bounded consumer retries. `CRUCE_OBSERVATION_QUEUE` can explicitly select an existing installation queue; set `CRUCE_OBSERVATION_QUEUE_ID` to that queue's exact ID. Configure `CF_EVENTS_API_TOKEN` as a Worker secret with Queues Write in this installation account, exclusively for subscription management. It is never an Artifacts credential fallback. Use `cf` resource commands and configuration, not Wrangler project commands.

A human repository maintainer enables observation in repository Settings. It is off for existing and new repositories until explicitly enabled. The console discloses approximately 96 idle operations/day per canonical/fork target, plus push checks and setup/removal; the namespace's default 100/day is not raised automatically. Adjust namespace `observation.read` policy and budget explicitly. Repository policy may only narrow it. The enabling maintainer's current authority is checked on background retries; loss of authority stops cloud work.

Disabling stops ingestion immediately and schedules bounded subscription removal. A fork's explicit deletion removes its subscription; presence expiry never does. The installation administrator owns dead-letter inspection/replay and restoration of missing credentials or subscription identities. Replay through the configured queue; do not add a public ingestion URL. If observation fails, retain journals and identities and show degraded health. Rollback by disabling observation and confirming subscription removal before removing queue consumers; retain source, provenance and pending reservations. See [ADR 0007](decisions/0007-observed-refs-and-reconciliation.md) and [hosted acceptance](local-verification.md#coordination-observation-and-reconciliation-c1c3). Events never approve/promote source or start agents.

Creating a Cruce repository initializes new source; checkout attachment is not import. [Native import](https://developers.cloudflare.com/artifacts/guides/import-repositories/) documents public HTTPS sources. Private import and upstream publication remain roadmap work; no silent synchronization or second canonical authority is introduced.

Coordination records have separate [byte/count and cardinality bounds](architecture.md#bounded-coordination-state-and-retention-recovery). Indexed receipts/activity/reservations remain retained, with reserved recovery headroom. `pnpm verify:limits` measures local SQLite and the 32 MiB buffered gateway; it does not establish Worker peak memory. DO alarms recover explicitly authorized fork cleanup and enabled observation with resumable reservations and current authority/policy. Queues carry observation signals; no scheduled expiry cleanup or Workflow binding is configured. Hosted alarm delivery, OAuth KV revocation propagation and provider deletion/Worker memory acceptance remain unverified.

## Platform references

Read the current [Artifacts index](https://developers.cloudflare.com/artifacts/llms.txt) and [cf index](https://developers.cloudflare.com/cf/llms.txt) before platform changes. Use `cf` and `cloudflare.config.ts`. Hosted binding publication/promotion is not live-verified by the local checks for this change; previous REST-provider/deployed receipts retain their original scope.
