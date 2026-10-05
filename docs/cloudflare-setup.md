# Cloudflare setup

Cruce uses `cf` with `cloudflare.config.ts`. The control plane requires a Worker, Directory/NamespaceRuntime/ControlTower SQLite Durable Objects, OAuth KV, DeploymentWorkflow and the `CRUCE_SECRET` server secret. Access issuer, audience and public origin are ordinary configuration. Use the configured single test environment in [test-environment.md](test-environment.md).

Canonical repositories and writer workspace forks require a connected namespace Cloudflare account with Artifacts access. Workers Builds permission is optional for Git hosting and required only for deployment.

See the [Cloudflare strategy](cloudflare-strategy.md) for the product-driven capability roadmap. Push-event reconciliation, native source-read optimization, Git-note mirroring and ArtifactFS are planned evaluations, not additional setup steps or currently deployed features.

## Namespace resource account

In Namespace Settings, an Owner connects an account ID and an account-scoped API token. The token must allow Artifacts reads/edits. Deployment additionally needs Workers Builds and Workers Scripts reads to observe builds and runtime versions. Workers Builds deployments also require a separately configured build token in Cloudflare. Cruce verifies Artifacts access, detects optional Builds access, seals the credential with `CRUCE_SECRET`, and returns only account metadata. It does not borrow the account running the control plane.

Stable namespace IDs provide Artifacts namespaces. Repository IDs, immutable revisions and workspace IDs determine storage names, so renames cannot move ownership. Resource policy and operation budgets belong to the namespace and apply across repositories. Limits count resource operations, not an estimated dollar bill. Uncertain operations keep reservations; retry the same operation identity to reconcile rather than spending again.

Artifacts REST creates canonical, workspace fork, immutable source-artifact, evidence and deploy repositories as needed. Cruce immediately revokes creation/fork tokens and mints 60-second tokens for server-side Git operations, revoking them afterwards. Native Git authenticates to Cruce; Cloudflare repository credentials never reach the client.

## Workers Builds integration

Configure the target Worker and connect its Cruce deployment repository using Cloudflare's [Artifacts–Workers Builds integration](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/). The deploy repository name is recorded on the Cruce environment. Its production ref is `main`; preview refs are `cruce/<environment-id>`. This is independent of the source repository's configured default branch.

Set the build/deploy commands and build token in Cloudflare. Cruce does not invent a build configuration or administer unrelated Cloudflare products. Choose an immutable source artifact in Deployments. Cruce pushes that exact revision to the deployment ref, then observes the matching build by commit and branch. Production requires a human console decision and exact-revision review/verification. Failure, timeout, supersession, smoke results and rollback remain visible. A source artifact is a retained source snapshot, not a compiled downloadable output.

Consult current [Artifacts REST](https://developers.cloudflare.com/artifacts/api/rest-api/), [Workers Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/) and [cf](https://developers.cloudflare.com/cf/llms.txt) documentation before changing these adapters. Mocked provider tests and an offline build are not live publication/deployment verification.

Native Git requires the narrow `/mcp/git/*` transport exception in `tools/access-agent-transport.json`; all requests still require Cruce authentication and current repository grants. This local configuration change has not been applied to the live Access application. The renamed NamespaceRuntime Durable Object uses fresh early-development state; existing ownership records are not migrated.
