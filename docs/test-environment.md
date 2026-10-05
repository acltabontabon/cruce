# Single live MVP test environment

Cruce's configured test Worker is [cruce.acltabontabon.workers.dev](https://cruce.acltabontabon.workers.dev). There is no second production deployment. Local fixtures are explicitly isolated from this service.

## Foundation deployment — 2026-10-05

The Workspace → Repository → Session replacement deploys Directory and WorkspaceRuntime SQLite Durable Objects alongside the repository ControlTower, OAuth KV and DeploymentWorkflow. The sealing secret is preserved. ProjectDirectory was retired through a temporary Cloudflare export tombstone, now removed; disposable old records are not converted. The obsolete artifact-event queue consumer was detached so no legacy event handler is retained. Old hosted source is not deleted or treated as native sessions.

The current foundation deployment version is `2d7cbe7d-bdcd-48f1-b21e-4cd7324d9314`. The signed-in owner browser verified personal-workspace provisioning and the new console's empty repository state.

## Authentication boundary

Access verifies issuer, audience, signature and expiry. Workspace membership and repository grants separately authorize access. The configured Access application currently admits the owner's email. Other shared-workspace users need admission to this Access application as well as a Cruce invitation/grant; an invitation alone cannot bypass Access.

The existing user-approved [transport configuration](../tools/access-agent-transport.json) has six exact public paths: `/mcp`, `/oauth/token`, `/oauth/register`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`. Preserve those narrow exceptions. `/authorize`, `/bridge/approve`, the console and `/api/workspaces` remain behind Access. Agent MCP requires OAuth. Human terminal pairing uses `/mcp?terminal=start|poll|command`, with separate browser approval and a proof-bound token; it requires no additional Access bypass.

Registration identifies an OAuth client, not a human or repository member. Agent consent selects repositories and capabilities. Revoked membership invalidates access on subsequent requests. Production remains a console decision.

Live post-deployment checks returned 200 for OAuth discovery, 401 for unauthenticated MCP, an Access redirect for signed-out workspace APIs, and 401 for a forged human-bridge token.

## Repeat deployment

`.env.test` contains the configured public origin and Access issuer/audience, not resource credentials. `pnpm deploy:test` uses `cf` and preserves server secrets. Run the documented checks first. `node --env-file=.env.test node_modules/cf/bin/cf deploy --dry-run` validates the live build without publishing. Do not rotate the sealing secret incidentally.

Cloudflare's compiler calls its optimized mode `production`; that label does not create another environment. Workspace resource accounts are explicitly connected by their owners. The operator CLI account is never an application fallback.

## Provider verification

The real Artifacts adapter passed a separate opt-in integration run in namespace `cruce-check-muuga1hc`: `trunk` default branch, isolated hosted fork, exact Git-pack publication, independent fetch and retention after session completion. Details are in [verification](local-verification.md).

The prior project-based test environment had no preview or production environment configured. A test Worker and Workers Builds connection are still required to verify successful artifact deployment, runtime version observation, smoke checks and rollback end to end. Those results are not implied by an uploaded control-plane Worker or by the fixed-clock demo.

## Local Git foundation refactor — 2026-10-05

The current working tree replaces ownership Workspace with Namespace and Session with durable Workspace. All repositories now use canonical Artifacts storage. The new native Git gateway requires `/mcp/git/*` in the transport configuration, still protected by Cruce authentication. These code/configuration changes have not been deployed; the earlier version and provider checks above do not verify them. No existing records are migrated.
