# Cloudflare setup

[Documentation map](../README.md#documentation-map) · [Architecture](architecture.md) · [Test environment](test-environment.md)

Cruce uses Cloudflare Artifacts for canonical Git, workspace forks and retained source. Cloudflare hosts storage and the coordination control plane; agent execution stays in participants' existing environments. Cruce’s responsibility ends when isolated concurrent work is safely reviewed and reconciled into the canonical Git repository. CI, build/release orchestration, deployment, environment management, rollback and runtime operation belong to external systems.

## Control plane

Use the installed `cf` CLI and [cloudflare.config.ts](../cloudflare.config.ts). The configuration declares the Worker and assets, SQLite Durable Objects (`Directory`, `NamespaceRuntime`, `ControlTower`), and OAuth KV. There is no current event-subscription trigger.

Workers observability is enabled, but domain-level correlation/redaction still needs work. No Artifacts binding, Queue, Workflow, D1 database, Analytics Engine or WebSocket delivery path is configured. The [architecture fit table](architecture.md#cloudflare-capability-fit) separates necessary foundations from proposed additions; do not provision them from this guide.

Configure `CRUCE_PUBLIC_ORIGIN`, `CRUCE_ACCESS_ISSUER` and `CRUCE_ACCESS_AUD` as ordinary values, and `CRUCE_SECRET` as a server secret for sealed credentials and identity operations. Example configuration is in [.env.example](../.env.example) and [.dev.vars.example](../.dev.vars.example). Retain the existing secret when updating a Worker; replacing it is not routine setup. Use the recorded [test environment](test-environment.md) for current deployment procedures and pending changes.

Access protects browser sign-in, consent, pairing approval, invitations and namespace APIs. The public document, bundled assets and cookie-verified `/auth/session` allow the homepage to render before sign-in; private console data still requires the authenticated API. The applied custom-domain path configuration is in [tools/access-public-homepage.json](../tools/access-public-homepage.json), with an application/update order in the [test environment guide](test-environment.md#public-homepage-access-configuration). Native Git requires the narrow `/mcp/git/*` browser-challenge exception in [tools/access-agent-transport.json](../tools/access-agent-transport.json); Cruce still authenticates and authorizes each Git request. The public-homepage policy and Git exception were applied on the custom domain on 2026-10-05; anonymous edge checks are recorded in the test environment guide.

Sign out expires the Cruce cookie, then redirects the browser to the application's `/cdn-cgi/access/logout` endpoint. This ends the user's Access session across all applications in the same team. Cloudflare immediately clears the application cookie and documents 20–30 seconds for previously issued tokens to stop being accepted. The browser lands on Cloudflare's logout page; returning to Cruce shows the public homepage. A fresh sign-in then uses the configured Access authentication method. See [Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#log-out-as-a-user). This does not change namespace membership or revoke stored OAuth/terminal connections.

## Namespace resource account

In namespace Settings, an Owner connects an account ID and account-scoped API token with Artifacts read/edit permission. Cruce checks access, seals the credential and exposes account metadata only. It never borrows the account running the control plane. The namespace credential needs no Builds or Workers Scripts permissions.

The namespace ID maps storage ownership to a Cloudflare Artifacts namespace. Stable repository and workspace IDs determine storage names, so display-name changes do not move ownership. Canonical storage, direct workspace forks, source-artifact and evidence repositories are created as needed. Workspace forks persist across publications. Retained source has separate refs so a mutable writer fork cannot rewrite a review artifact.

The [audit](architecture.md#architecture-contradictions-and-correctness-gaps) found incomplete provider-ID validation and resource-account rebinding after credential disconnect. Disconnect is not an implemented account-migration mechanism. The correction must preserve storage ownership separately from the sealed credential; names and descriptions alone cannot prove identity.

Resource operations pass namespace policy and atomic operation reservations across repositories; repository policy can narrow them. Uncertain outcomes retain their reservation and must be reconciled with the original operation identity. These budgets are policy limits, not a dollar estimator. Git reads and provider token requests can incur costs beyond the logical reservation count.

Creation/fork tokens are revoked. Server-side Git operations use repository-scoped 60-second tokens and revoke them after use. Native Git clients authenticate to Cruce with OAuth or restricted terminal credentials, never the namespace's Cloudflare token. [Artifacts REST documentation](https://developers.cloudflare.com/artifacts/api/rest-api/) defines provider token and fork behavior.

## Limits and costs

As reviewed on 2026-10-06, Artifacts documents a maximum of 1 GB per repository, 32 MB per file/blob and 1 TB per account, with separate Git and namespace request-rate limits. See [current limits](https://developers.cloudflare.com/artifacts/platform/limits/). Cruce additionally bounds each gateway request and response to **32 MiB**; this aggregate transfer limit is separate from the per-blob limit. Larger transfers need a gateway change, and larger repositories may not fit the current hosted model. Cache growth and full reachable-pack export also need representative measurement.

Consult [current pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) before estimating costs or changing setup disclosures. Account plan, operations, retained storage and other Cloudflare services all matter. Do not copy an old price table into product policy or suggest local-only canonical hosting as an available fallback.

## Proposed inspection, observations and import

Current source inspection uses a persistent derived Git cache in the Repository DO. [REST](https://developers.cloudflare.com/artifacts/api/rest-api/) and the [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) offer exact commit/tree/blob/file/history reads. Evaluate REST inspection for the explicitly connected account first; a static namespace binding does not establish access to arbitrary connected accounts. First-parent history APIs cannot replace merge ancestry checks.

[Artifacts events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) use account event subscriptions delivering to Queues. This is a proposed observation path, not an existing Cruce setup step or generic webhook endpoint. Subscription-management and queue producer/consumer permissions are additional to today's Artifacts token; their exact connected-account scope, consumer location and credential model need validation. Do not broaden permissions or silently use the operator account. Delivery must tolerate duplicates, reordering, truncation and missed events, with schema validation, bounded ref reconciliation and dead-letter handling. Events cannot supply human approval or prove promotion.

Repository creation initializes new canonical source; checkout attachment is not an import. [Native Artifacts import](https://developers.cloudflare.com/artifacts/guides/import-repositories/) documents public HTTPS sources and asynchronous availability. Private import is not established by that guide. Cruce has no import or external synchronization flow. A future private GitHub path requires validated [GitHub App installation authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), Contents permission and normal authenticated Git transport without persistent token-bearing remotes. GitHub remains an explicit external provider; Artifacts stays canonical within Cruce.

## Platform references

Before platform changes, read the current [Artifacts index](https://developers.cloudflare.com/artifacts/llms.txt) and [cf index](https://developers.cloudflare.com/cf/llms.txt), then the relevant primary documentation:

- [Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) and [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/) for storage and token operations.
- [cf configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/) for Worker configuration; use `cf`, not wrangler project commands.
- [Events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) for the P0 observation proposal; [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) remains exploratory in the [roadmap](../ROADMAP.md). Neither is a current setup step.
