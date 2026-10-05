# Configured test environment

[Documentation map](../README.md#documentation-map) · [Cloudflare setup](cloudflare-setup.md) · [Verification](local-verification.md)

The configured control-plane test Worker is [cruce.acltabontabon.workers.dev](https://cruce.acltabontabon.workers.dev). The repository records one hosted environment; local fixtures are isolated from it. This page records configuration and last-known evidence, not a fresh live inspection.

## Deployment status — 2026-10-05

Last recorded foundation deployment: `2d7cbe7d-bdcd-48f1-b21e-4cd7324d9314`. That deployment used the superseded Workspace → Repository → Session naming. Its signed-in owner browser verified personal ownership provisioning and the empty repository console. OAuth discovery returned 200, unauthenticated MCP and forged terminal credentials returned 401, and signed-out ownership APIs redirected to Access.

The current checkout uses Namespace → Repository → Workspace, mandatory canonical Artifacts storage, `NamespaceRuntime` and a native Git gateway. Those changes and the required `/mcp/git/*` Access exception are **not recorded as deployed or live-verified**. Earlier deployment/provider successes do not establish their behavior. Old state is disposable; there is no migration adapter. The obsolete artifact-event consumer was detached, and current configuration has no event trigger.

## Authentication boundary

The recorded Access application admits the owner's email. Additional users need both Access admission and Cruce membership/repository grants. An invitation does not bypass Access. Current authentication and authority rules are in [architecture](architecture.md#identity-and-authorization).

The checked-in [transport configuration](../tools/access-agent-transport.json) declares six exact machine endpoints plus the pending Git path:

- `/mcp`
- `/oauth/token`
- `/oauth/register`
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/mcp/git/*` — required for current native Git; application to live Access remains pending.

These bypass Access's browser challenge, not Cruce authentication. Discovery/registration are protocol endpoints; MCP requires OAuth and current grants. `/authorize`, `/bridge/approve`, the console and `/api/namespaces` stay behind Access. Human pairing uses `/mcp?terminal=start|poll|command`, browser approval and a proof-bound token. Do not widen the exception to the console, all APIs or consent pages.

## Repeat deployment

`.env.test` holds the configured origin and Access issuer/audience; it is not the namespace resource-account credential. Keep `CRUCE_SECRET` on the Worker and do not rotate it incidentally. Review configuration and run [contributor checks](../CONTRIBUTING.md#verify) before a deployment.

```sh
node --env-file=.env.test node_modules/cf/bin/cf deploy --dry-run
pnpm deploy:test
```

The second command publishes to the configured test Worker. A dry run validates a build, not hosted behavior. Cloudflare's build mode named `production` and the GitHub environment named `production` do not themselves establish a second deployed Cruce service. Normal release-tag deployment is described in [releases](releases.md).

Namespace resources use their explicitly connected account, even when the CLI is logged into the control-plane account. The real-provider script and its costs are documented in [verification](local-verification.md#opt-in-real-provider-check). Repository deployment, runtime observation and rollback are outside Cruce’s product boundary.
