# Cloudflare setup

[Documentation map](../README.md#documentation-map) · [Architecture](architecture.md) · [Test environment](test-environment.md)

Cruce uses Cloudflare Artifacts for canonical Git, workspace forks and retained source. Cloudflare hosts storage and the coordination control plane; agent execution stays in participants' existing environments. Optional Workers Builds integration records deployment provenance without making Cruce a CI/CD replacement.

## Control plane

Use the installed `cf` CLI and [cloudflare.config.ts](../cloudflare.config.ts). The configuration declares the Worker and assets, SQLite Durable Objects (`Directory`, `NamespaceRuntime`, `ControlTower`), OAuth KV and `DeploymentWorkflow`. There is no current event-subscription trigger.

Configure `CRUCE_PUBLIC_ORIGIN`, `CRUCE_ACCESS_ISSUER` and `CRUCE_ACCESS_AUD` as ordinary values, and `CRUCE_SECRET` as a server secret for sealed credentials and identity operations. Example configuration is in [.env.example](../.env.example) and [.dev.vars.example](../.dev.vars.example). Retain the existing secret when updating a Worker; replacing it is not routine setup. Use the recorded [test environment](test-environment.md) for current deployment procedures and pending changes.

Access protects browser sign-in, consent, the console and namespace APIs. Native Git requires the narrow `/mcp/git/*` browser-challenge exception in [tools/access-agent-transport.json](../tools/access-agent-transport.json); Cruce still authenticates and authorizes each Git request. The checked-in exception is not recorded as applied to live Access. See the test-environment endpoint list before changing transport configuration.

## Namespace resource account

In namespace Settings, an Owner connects an account ID and account-scoped API token with Artifacts read/edit permission. Cruce checks access, seals the credential and exposes account metadata only. It never borrows the account running the control plane. Workers Builds permission is optional for Git hosting and needed only for deployment integration.

The namespace ID maps storage ownership to a Cloudflare Artifacts namespace. Stable repository and workspace IDs determine storage names, so display-name changes do not move ownership. Canonical storage, direct workspace forks, source-artifact and evidence repositories are created as needed; optional deployments use a separate repository. Workspace forks persist across publications. Retained source has separate refs so a mutable writer fork cannot rewrite a review artifact.

Resource operations pass namespace policy and atomic operation reservations across repositories; repository policy can narrow them. Uncertain outcomes retain their reservation and must be reconciled with the original operation identity. These budgets are policy limits, not a dollar estimator. Git reads and provider token requests can incur costs beyond the logical reservation count.

Creation/fork tokens are revoked. Server-side Git operations use repository-scoped 60-second tokens and revoke them after use. Native Git clients authenticate to Cruce with OAuth or restricted terminal credentials, never the namespace's Cloudflare token. [Artifacts REST documentation](https://developers.cloudflare.com/artifacts/api/rest-api/) defines provider token and fork behavior.

## Limits and costs

As reviewed on 2026-10-05, Artifacts documents a maximum of 1 GB per repository and 32 MB per file/blob, with separate Git and namespace request-rate limits. See [current limits](https://developers.cloudflare.com/artifacts/platform/limits/). Cruce additionally bounds each gateway request and response to **32 MiB**; this aggregate transfer limit is separate from the per-blob limit. Larger transfers need a gateway change, and larger repositories may not fit the current hosted model.

Consult [current pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) before estimating costs or changing setup disclosures. Account plan, operations, retained storage and other Cloudflare services all matter. Do not copy an old price table into product policy or suggest local-only canonical hosting as an available fallback.

## Optional Workers Builds integration

Configure a target Worker and connect the Cruce deployment repository using Cloudflare's [Artifacts–Workers Builds integration](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/). Set build/deploy commands and the build token in Cloudflare. The connected namespace token additionally needs Builds access and Workers Scripts reads for build/runtime observation. Cruce does not configure unrelated Cloudflare products or infer a build recipe.

The deployment repository name is recorded on the Cruce environment. Its production ref is `main`; preview refs are `cruce/<environment-id>`, independent of the canonical repository's default branch. Cruce updates the deployment ref to the selected artifact's exact revision and correlates build and runtime observations. The deployment adapter may force these environment refs; canonical source promotion remains non-forced.

Production requires an authenticated human console decision and exact-revision review/evidence. Rollback names a prior successful artifact deployment in the same environment. Source acceptance, source retention and deployment remain separate. A build success does not create a downloadable compiled artifact. End-to-end Workers Builds success remains an open [verification gate](local-verification.md).

## Platform references

Before platform changes, read the current [Artifacts index](https://developers.cloudflare.com/artifacts/llms.txt) and [cf index](https://developers.cloudflare.com/cf/llms.txt), then the relevant primary documentation:

- [Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) and [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/) for storage and token operations.
- [cf configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/) for Worker configuration; use `cf`, not wrangler project commands.
- [Workers Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/) for build observation.
- [Events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) and [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) only for the conditional evaluations in the [roadmap](../ROADMAP.md); neither is a current setup step.
