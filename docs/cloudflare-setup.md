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

Cloudflare usage is billed to the installation account. Namespace operation budgets are application policy limits, not dollar estimates. The operator manages account-wide cost and capacity; no per-customer billing or automatic cleanup is introduced. Uncertain operations remain charged until reconciled with their original identity.

## Control plane

Access protects browser sign-in, consent, pairing approval, invitations and namespace APIs. The public document/assets and cookie-verified `/auth/session` let the homepage render before sign-in. Native Git uses the narrow `/mcp/git/*` browser-challenge exception while Cruce authenticates each request. Review [public homepage paths](../tools/access-public-homepage.json) and [Git transport paths](../tools/access-agent-transport.json) for your own Access application. Deployment configuration does not provision Access policies automatically.

Sign out expires the Cruce cookie and redirects to `/cdn-cgi/access/logout`, ending Access sessions across applications in the same team. It does not revoke Cruce OAuth connections or alter namespace membership.

For local UI/controller checks use `pnpm dev:fixture`; for an offline Worker build use `pnpm exec cf build --mode offline`. Offline mode omits the Artifacts binding and permits no cloud storage provisioning. [.dev.vars.example](../.dev.vars.example) describes local identity settings.

## Limits and costs

Artifacts documents limits of 1 GB per repository, 32 MB per file/blob and 1 TB per account as reviewed on 2026-10-06. See [current limits](https://developers.cloudflare.com/artifacts/platform/limits/) and [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) before estimating capacity or cost. Cruce also bounds each Git gateway request/response to 32 MiB. Git cache growth and reachable-pack export still need representative measurement.

## Proposed inspection, observations and import

Source inspection currently uses the derived Git cache in the Repository DO. The binding offers exact commit/tree/blob/file/history reads; first-parent history cannot replace complete merge ancestry checks. Cache eviction and cold recovery remain roadmap work.

[Artifacts events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) deliver account event subscriptions to Queues. They are proposed, not configured. Subscription permissions, event identity, duplicates, replay, reordering and bounded backfill require separate verification. Events never approve/promote source or start agents.

Creating a Cruce repository initializes new source; checkout attachment is not import. [Native import](https://developers.cloudflare.com/artifacts/guides/import-repositories/) documents public HTTPS sources. Private import and upstream publication remain roadmap work; no silent synchronization or second canonical authority is introduced.

## Platform references

Read the current [Artifacts index](https://developers.cloudflare.com/artifacts/llms.txt) and [cf index](https://developers.cloudflare.com/cf/llms.txt) before platform changes. Use `cf` and `cloudflare.config.ts`. Hosted binding publication/promotion is not live-verified by the local checks for this change; previous REST-provider/deployed receipts retain their original scope.
