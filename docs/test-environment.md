# Configured test environment

[Documentation map](README.md) · [Cloudflare setup](cloudflare-setup.md) · [Verification](local-verification.md)

The configured control-plane test Worker is [cruce.acltabontabon.com](https://cruce.acltabontabon.com). The repository records one hosted environment; local fixtures are isolated from it. This page records configuration and last-known evidence, not a fresh live inspection.

## Last recorded deployment

As recorded on **2026-10-09**, the latest direct test deployment was Worker **`12219de2-7580-4767-8582-246ad55c5f85`**, from clean commit **`919400e`**, deployed with `pnpm deploy:test` after a production dry run with unchanged bindings. This is a recorded result, not a query of current traffic.

The build passed typecheck, lint, **427 unit/integration tests**, **98 browser journeys**, scenario verification and the offline build in a clean worktree. Anonymous HTTPS returned homepage/session/discovery 200, private namespace API Access challenge 302 and MCP 401. Hosted document, entry script, App chunk and stylesheet matched the build. The public splash rendered and disappeared without console errors; signed-in splash/progress was not exercised.

The latest recorded tagged deployment was [0.1.0-alpha.3](https://github.com/acltabontabon/cruce/releases/tag/v0.1.0-alpha.3), Worker **`ddd14ac5-b249-4bb0-9b54-f74e669a2888`**, from **`2df8243ea3f21bd1a79b48edf9eedea3bb9ad860`**, on 2026-10-07 at 18:23 Philippine time. Later direct test deployments did not change that release tag or package version.

Behavioral acceptance is summarized in [verification](local-verification.md#current-evidence-at-a-glance). Important hosted results include:

- [Current binding publication, agent replies and human review-note resolution](local-verification.md#review-notes-and-the-calmer-change-review), Worker `04eaa58a`.
- [Fork deletion and retained-source recovery](local-verification.md#retained-source-proof-on-cloudflare-artifacts), Worker `afb692eb` from `5f8a7fe`.
- Repository deletion removing four Artifacts repositories, followed by two autonomous deletions, Worker `78a29a43` from `1f4d5ca` on 2026-10-08.
- Empty shared-namespace deletion from the signed-in console, Worker `a4587056`; this consumed no repository deletion resources.
- [Push-observation subscription setup](local-verification.md#coordination-observation-and-reconciliation-c1c3), with subsequent explicit disable/removal; real push and gap recovery remain unverified.

Earlier single-writer gateway and two-tool promotions used connected-account storage. They retain that scope and do not verify current binding promotion recovery. Detailed deployment chronology remains in Git history.

## Authentication boundary

The 2026-10-06 [deployed gateway check](local-verification.md#deployed-gateway-verification) exercised owner sign-in, isolated namespace/account configuration, canonical provisioning, one real OAuth grant and native Git/publication through the Worker. It found and repaired the consent content type and native fetch receiver. Authenticated console review/attestation/promotion, completed-response replay, token downscoping and whole-grant revocation passed. The independent provider audit verified retained refs after fork cleanup and rejection of explicitly revoked Git tokens before expiry. This single-writer run did not establish a second coding-tool connection or membership/in-flight revocation. The later [D2 run](local-verification.md#deployed-multi-tool-participation-d2) covered two coding tools on one machine.

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

## Access sign-in branding

On **2026-10-06**, the existing Access team and browser application's display names were set to **Cruce**, and the [branding payload](../tools/access-login-branding.json) applied the public ink symbol, paper background, forest text, sign-in header and email-code guidance. Organization readback preserved all non-appearance settings. Application readback preserved its ID, audience, routes, session settings, identity providers and admission rules; Cloudflare refreshed the policy update timestamps when saving. Public logo HTTPS and the anonymous branded email form returned 200. A local rendering of that hosted HTML was visually inspected. OTP delivery/submission was not repeated. Backups/readbacks and the non-secret verification receipt are in ignored `dist/access-branding/`.

Branding affects all applications in this Access team and is independent of Worker releases. The GitHub release environment was corrected to the existing custom domain and supplied the installation account, Worker name and stable Artifacts namespace required by alpha.2. No source transition, rebinding or cleanup was performed. See [setup](cloudflare-setup.md#access-login-branding) and [release verification](local-verification.md#current-evidence-at-a-glance).

## Public homepage Access configuration

The [reviewable configuration](../tools/access-public-homepage.json) is a handoff containing one new application payload and one partial update to the **existing** browser Access application. It is not an executable deployment script. Its protected destinations and public Bypass policy were applied to the hosted custom domain on 2026-10-05 after explicit approval. The `type: "public"` destinations describe Internet-facing hostnames, not a Bypass policy for protected data.

Apply the protected application patch to the existing application ID first, preserving its audience, admission policies, session settings and identity provider. Its destinations cover `/api`, `/api/*`, `/auth/login`, `/auth/logout`, `/authorize`, `/bridge`, `/bridge/*`, `/invite` and `/invite/*`. Do not replace that application or regenerate `CRUCE_ACCESS_AUD`. Then create the public base application using the provided Bypass policy. More-specific protected paths take precedence over the public base; see [Cloudflare application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/). Preserve the machine transport admission policy; its destinations now use the custom domain and include the native Git path.

The public base serves `/`, query-based console documents, static assets and `/auth/session`. That exact Worker session route accepts only GET, returns a no-store boolean, trusts only the sealed Cruce cookie and rechecks the underlying Access identity. It never reads directory/repository state. The owner observed automatic re-entry under the former Cruce-only sign-out and explicitly requested full logout. The updated handler expires Cruce's cookie and redirects to `/cdn-cgi/access/logout` on the same origin. Cloudflare's [full user logout](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#log-out-as-a-user) clears the application cookie and revokes the user's Access session across all applications in the team. Previously issued tokens can remain accepted for 20–30 seconds. The browser lands on the provider logout page; returning to Cruce shows the public homepage. Historical deployment evidence is in [verification](local-verification.md#deployed-gateway-verification). Other application paths remain subject to their Worker routing/authentication, and the protected API retains its identity and membership enforcement even if edge configuration is incorrect.

After a separately authorized hosted rollout, verify signed-out document/asset/session requests, login and full Access logout, valid sessions and repository deep links, and expired/tampered cookies. Confirm unauthenticated API, consent, pairing-approval and invitation requests still challenge at Access, while MCP/Git require their existing credentials. Check browser history and private API failures, preserve the original application settings for rollback, and record hosted evidence before claiming this homepage is publicly live. The recorded anonymous checks verify the applied edge boundary, and the owner confirmed signed-in entry after the Directory repair. The later single-writer check passed repository deep links and authenticated review/attestation/promotion. The earlier provider-backed two-writer convergence run uses in-process authority; the later [D2 run](local-verification.md#deployed-multi-tool-participation-d2) records actual coding-tool participation on one machine.

## Repeat deployment

`.env.test` holds the configured origin, installation account ID and Access issuer/audience; runtime storage access comes from the Artifacts binding. Keep `CRUCE_SECRET` on the Worker and do not rotate it incidentally. Review configuration and run [contributor checks](../CONTRIBUTING.md#verify) before a deployment.

```sh
node --env-file=.env.test node_modules/cf/bin/cf deploy --dry-run
pnpm deploy:test
```

The second command publishes to the configured test Worker. A dry run validates a build, not hosted behavior. Cloudflare's build mode named `production` and the GitHub environment named `production` do not themselves establish a second deployed Cruce service. Normal release-tag deployment is described in [releases](releases.md).

New deployment-managed installations use the explicit Artifacts binding in the deployment account. Legacy connected-account namespaces retain their original storage and block resource operations; they must not be rebound implicitly. The real-provider script and its costs are documented in [verification](local-verification.md#opt-in-real-provider-check). Repository deployment, runtime observation and rollback are outside Cruce’s product boundary.
