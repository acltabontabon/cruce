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

These bypass Access's browser challenge, not Cruce authentication. Discovery/registration are protocol endpoints; MCP requires OAuth and current grants. `/authorize`, `/bridge/approve` and `/api/namespaces` stay behind Access. Human pairing uses `/mcp?terminal=start|poll|command`, browser approval and a proof-bound token. Machine exceptions must not bypass browser sign-in, private APIs or consent pages. The public console document is separately addressed below; its data remains authenticated.

## Public homepage Access configuration

The [reviewable configuration](../tools/access-public-homepage.json) is a handoff containing one new application payload and one partial update to the **existing** browser Access application. It is not an executable deployment script, and it has not been applied to the hosted environment. The `type: "public"` destinations describe Internet-facing hostnames, not a Bypass policy for protected data.

Apply the protected application patch to the existing application ID first, preserving its audience, admission policies, session settings and identity provider. Its destinations cover `/api`, `/api/*`, `/auth/login`, `/auth/logout`, `/authorize`, `/bridge`, `/bridge/*`, `/invite` and `/invite/*`. Do not replace that application or regenerate `CRUCE_ACCESS_AUD`. Then create the public base application using the provided Bypass policy. More-specific protected paths take precedence over the public base; see [Cloudflare application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/). Keep the separately configured machine transport application and its exact endpoints unchanged.

The public base serves `/`, query-based console documents, static assets and `/auth/session`. That exact Worker session route accepts only GET, returns a no-store boolean, trusts only the sealed Cruce cookie and rechecks the underlying Access identity. It never reads directory/repository state. Sign-out clears Cruce's cookie; an active Access session can be reused by an explicit Sign in. Other application paths remain subject to their Worker routing/authentication, and the protected API retains its identity and membership enforcement even if edge configuration is incorrect.

After a separately authorized hosted rollout, verify signed-out document/asset/session requests, login and Cruce-only logout, valid sessions and repository deep links, and expired/tampered cookies. Confirm unauthenticated API, consent, pairing-approval and invitation requests still challenge at Access, while MCP/Git require their existing credentials. Check browser history and private API failures, preserve the original application settings for rollback, and record hosted evidence before claiming this homepage is publicly live. No live Access changes or deployment are part of the local implementation.

## Repeat deployment

`.env.test` holds the configured origin and Access issuer/audience; it is not the namespace resource-account credential. Keep `CRUCE_SECRET` on the Worker and do not rotate it incidentally. Review configuration and run [contributor checks](../CONTRIBUTING.md#verify) before a deployment.

```sh
node --env-file=.env.test node_modules/cf/bin/cf deploy --dry-run
pnpm deploy:test
```

The second command publishes to the configured test Worker. A dry run validates a build, not hosted behavior. Cloudflare's build mode named `production` and the GitHub environment named `production` do not themselves establish a second deployed Cruce service. Normal release-tag deployment is described in [releases](releases.md).

Namespace resources use their explicitly connected account, even when the CLI is logged into the control-plane account. The real-provider script and its costs are documented in [verification](local-verification.md#opt-in-real-provider-check). Repository deployment, runtime observation and rollback are outside Cruce’s product boundary.
