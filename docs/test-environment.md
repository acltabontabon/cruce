# Configured test environment

[Documentation map](../README.md#documentation-map) · [Cloudflare setup](cloudflare-setup.md) · [Verification](local-verification.md)

The configured control-plane test Worker is [cruce.acltabontabon.com](https://cruce.acltabontabon.com). The repository records one hosted environment; local fixtures are isolated from it. This page records configuration and last-known evidence, not a fresh live inspection.

## Deployment status — 2026-10-05

Current direct deployment: `c50aee32-5705-4a59-8f2b-a470a5d505f5`, serving 100% traffic since 23:33 Philippine time. It was built from `b85ab37cd72611bed62bff33a4db19b03041dded` plus the uncommitted full Access logout and Directory-address fixes. Worker bundle SHA-256 is `14fd4bd0ec278f07f3b17522689cca26edf6706379bb3ec26d1dac3c1f67cb0c`. No package version or release tag changed.

The owner explicitly requested full logout after confirming successful sign-in. Typecheck, lint, all 107 unit/integration tests, all 48 browser journeys, deterministic scenario replay, offline build, release metadata and deployment dry run passed. The deployment command uploaded the Worker but exited with a 504 while refreshing the existing custom-domain binding. Independent deployment metadata confirmed the new version at 100%; cf's authenticated read-only API confirmed `cruce.acltabontabon.com` still targets `cruce`. Homepage/session HTTPS returned 200, unauthenticated logout still challenged at Access and MCP still returned 401. The server-secret binding and Durable Object namespace IDs were preserved. No second deployment or domain replacement was necessary. A non-secret receipt is saved in ignored `dist/deployment-verification/full-sign-out.json`. Full provider logout and a subsequent fresh email/PIN challenge await owner browser confirmation; the fixture establishes only the handoff and cleared Cruce state. The later [provider-backed convergence check](local-verification.md#hosted-two-writer-convergence) passed at clean Cruce commit `5ac7ad977ca5fd09fb077ace8953b88eb2812f17` in an isolated Artifacts namespace. It used in-process grants and did not exercise this deployed Worker or authenticated review.

Prior Directory-address repair: `d83856e6-98ce-4aa6-86b0-f30fac6529ce`, deployed at 15:16 UTC with 100% traffic. It was built from `b85ab37cd72611bed62bff33a4db19b03041dded` plus the uncommitted Directory-address repair; Worker bundle SHA-256 is `1fa2a8d8e48932db4eba387124d7feabfdfefcb887da57223241e695a3e501de`. Package version remains `0.1.0-alpha.1`; no new release tag was created. The Worker uses `cruce.acltabontabon.com`, with its workers.dev route and preview URLs disabled. The previous homepage deployment was `321db4ea-7789-41a2-950d-0c2f7a33d07e`.

The owner reported a generic error after sign-in. Hosted telemetry showed successful `/auth/login` and `/auth/session`, then `/api/me` returning 500 after Directory login/namespace calls. The existing Directory namespace had one stored object, while the current NamespaceRuntime namespace had no objects. Git history showed incompatible retired Directory records still using the same `directory` object address. The repair routes API, OAuth consent and pairing through the stable `namespace-directory` object for the current model, preserving the retired object untouched. There is no migration or deletion. The owner had previously approved retiring the obsolete `WorkspaceRuntime` namespace; this repair performs no further retirement.

Before this repair deployment, typecheck, lint, all 106 unit/integration tests, 48 browser journeys, deterministic scenario replay, offline build, release metadata and production deployment dry run passed. Afterward, independent deployment metadata confirmed 100% traffic on the new version. Anonymous HTTPS checks passed for the homepage, missing/tampered-cookie session responses, protected API/login/consent/pairing/invitation challenges, unauthenticated MCP/Git rejection and OAuth discovery. A non-secret receipt is saved in ignored `dist/deployment-verification/sign-in-repair.json`. Existing secrets, Access audience and admission policy were preserved. The owner subsequently confirmed successful signed-in entry in their browser; direct browser automation remained unavailable because computer-control permission was not granted. Hosted source verification was not part of that repair; the later provider-backed convergence evidence is recorded in the [verification guide](local-verification.md#hosted-two-writer-convergence).

For the earlier homepage rollout, anonymous HTTPS checks returned 200 for the homepage, JavaScript, CSS and wordmark. `/auth/session` returned a no-store `{"authenticated":false}` for both missing and tampered cookies. Login, namespace APIs, consent, pairing approval and invitation paths redirected to Access. Unauthenticated MCP and Git returned 401 without a browser challenge; OAuth discovery returned 200. The signed-out homepage was also inspected in the browser. Signed-in login/logout, repository deep links, real source publication/promotion and heterogeneous clients were not exercised in that rollout.

Historical foundation deployment `2d7cbe7d-bdcd-48f1-b21e-4cd7324d9314` used the superseded Workspace → Repository → Session naming. Its owner browser verified personal provisioning and the empty console. Those older provider/owner results do not establish current source reconciliation behavior. There is no migration adapter; the obsolete artifact-event consumer remains detached.

## Authentication boundary

The recorded Access application admits the owner's email. Additional users need both Access admission and Cruce membership/repository grants. An invitation does not bypass Access. Current authentication and authority rules are in [architecture](architecture.md#identity-and-authorization).

The checked-in [transport configuration](../tools/access-agent-transport.json) declares six exact machine endpoints plus the Git path:

- `/mcp`
- `/oauth/token`
- `/oauth/register`
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/mcp/git/*` — applied to live Access; Cruce authentication remains required.

These bypass Access's browser challenge, not Cruce authentication. Discovery/registration are protocol endpoints; MCP requires OAuth and current grants. `/authorize`, `/bridge/approve` and `/api/namespaces` stay behind Access. Human pairing uses `/mcp?terminal=start|poll|command`, browser approval and a proof-bound token. Machine exceptions must not bypass browser sign-in, private APIs or consent pages. The public console document is separately addressed below; its data remains authenticated.

## Public homepage Access configuration

The [reviewable configuration](../tools/access-public-homepage.json) is a handoff containing one new application payload and one partial update to the **existing** browser Access application. It is not an executable deployment script. Its protected destinations and public Bypass policy were applied to the hosted custom domain on 2026-10-05 after explicit approval. The `type: "public"` destinations describe Internet-facing hostnames, not a Bypass policy for protected data.

Apply the protected application patch to the existing application ID first, preserving its audience, admission policies, session settings and identity provider. Its destinations cover `/api`, `/api/*`, `/auth/login`, `/auth/logout`, `/authorize`, `/bridge`, `/bridge/*`, `/invite` and `/invite/*`. Do not replace that application or regenerate `CRUCE_ACCESS_AUD`. Then create the public base application using the provided Bypass policy. More-specific protected paths take precedence over the public base; see [Cloudflare application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/). Preserve the machine transport admission policy; its destinations now use the custom domain and include the native Git path.

The public base serves `/`, query-based console documents, static assets and `/auth/session`. That exact Worker session route accepts only GET, returns a no-store boolean, trusts only the sealed Cruce cookie and rechecks the underlying Access identity. It never reads directory/repository state. The owner observed automatic re-entry under the former Cruce-only sign-out and explicitly requested full logout. The updated handler expires Cruce's cookie and redirects to `/cdn-cgi/access/logout` on the same origin. Cloudflare's [full user logout](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#log-out-as-a-user) clears the application cookie and revokes the user's Access session across all applications in the team. Previously issued tokens can remain accepted for 20–30 seconds. The browser lands on the provider logout page; returning to Cruce shows the public homepage. Deployment evidence for this change is recorded above. Other application paths remain subject to their Worker routing/authentication, and the protected API retains its identity and membership enforcement even if edge configuration is incorrect.

After a separately authorized hosted rollout, verify signed-out document/asset/session requests, login and full Access logout, valid sessions and repository deep links, and expired/tampered cookies. Confirm unauthenticated API, consent, pairing-approval and invitation requests still challenge at Access, while MCP/Git require their existing credentials. Check browser history and private API failures, preserve the original application settings for rollback, and record hosted evidence before claiming this homepage is publicly live. The anonymous checks above verify the applied edge boundary, and the owner confirmed signed-in entry after the Directory repair. Repository deep links and authenticated review/promotion remain pending. The separate provider-backed convergence run verifies source retention and promotion with in-process authority, not those deployed authentication paths.

## Repeat deployment

`.env.test` holds the configured origin and Access issuer/audience; it is not the namespace resource-account credential. Keep `CRUCE_SECRET` on the Worker and do not rotate it incidentally. Review configuration and run [contributor checks](../CONTRIBUTING.md#verify) before a deployment.

```sh
node --env-file=.env.test node_modules/cf/bin/cf deploy --dry-run
pnpm deploy:test
```

The second command publishes to the configured test Worker. A dry run validates a build, not hosted behavior. Cloudflare's build mode named `production` and the GitHub environment named `production` do not themselves establish a second deployed Cruce service. Normal release-tag deployment is described in [releases](releases.md).

Namespace resources use their explicitly connected account, even when the CLI is logged into the control-plane account. The real-provider script and its costs are documented in [verification](local-verification.md#opt-in-real-provider-check). Repository deployment, runtime observation and rollback are outside Cruce’s product boundary.
