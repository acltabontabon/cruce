# Native project setup

Cruce uses Git, Cloudflare Artifacts and native membership. GitHub/GitLab credentials are unnecessary.

## Infrastructure and identity

Use `cf` and `cloudflare.config.ts` (never `wrangler`). Non-offline mode binds Artifacts and Workers AI. `ProjectDirectory` and `ControlTower` are SQLite Durable Objects; `DeploymentWorkflow` orchestrates deployments; OAuth tokens use the configured KV binding.

Configure a Cloudflare Access application for the Cruce hostname with your identity provider. Protect the console, `/auth/*` and `/authorize`. Allow the OAuth endpoints (`/oauth/*`, `/.well-known/*`) and `/mcp` to reach Cruce without an Access browser redirect; Cruce protects MCP with OAuth and revalidates the Access identity behind it. The public demo and `/api/demo/*` may be excluded from Access deliberately.

```text
CRUCE_PUBLIC_ORIGIN=https://YOUR_CRUCE_HOST
CRUCE_ACCESS_ISSUER=https://YOUR_TEAM.cloudflareaccess.com
CRUCE_ACCESS_AUD=YOUR_ACCESS_APPLICATION_AUDIENCE
CRUCE_SECRET=<server-only random secret: identity cookies and connected-account credentials>
```

Cruce verifies JWT signature, audience, issuer, expiry and native membership on every request. No shared admin token authorizes native projects.

## Projects and their repositories

Sign in and create a project. Creation assigns an immutable project ID, makes the creator maintainer and provisions the canonical Artifacts repository `project-<id>` with an initial revision on `main`. That is the only time the canonical repository is created; reading a project never creates resources (an older project without a repository shows a "Create Artifacts repository" action for maintainers, `POST /api/projects/provision`).

Governance: `POST /api/projects/access?projectId=…` supports versioned membership, display name and active state. Contributors propose; observers read; human maintainers promote, decide resource requests, configure environments and change policy.

## Existing agents

```sh
node /ABSOLUTE/PATH/cruce/runner/cruce.ts checkout --server https://YOUR_CRUCE_HOST --project PROJECT_ID --directory ./payments
node /ABSOLUTE/PATH/cruce/runner/cruce.ts connect --server https://YOUR_CRUCE_HOST --project PROJECT_ID --client claude --cwd ./payments
```

Checkout creates a new directory from accepted source (real Git objects at the canonical revision); it never replaces an existing checkout. Connect configures Codex (`.codex/config.toml` + `AGENTS.md`), Claude (`.mcp.json` + `CLAUDE.md`) or Cursor (`.cursor/mcp.json` + rule) without touching other MCP servers, opens browser authorization with PKCE, and stores credentials in `~/.config/cruce` (mode 0600). `.cruce/` holds non-secret local associations and is ignored by Git.

At consent the human chooses the agent's **scopes**:

| Scope | Allows |
| --- | --- |
| `cruce:read` | Missions, policy, source, diffs, history and lineage (always granted) |
| `workspace:write` | `start_mission`, `publish_revision`, `publish_artifact`, plan updates, coordination responses, `complete_mission` |
| `proposal:write` | `create_mission`, `create_proposal`, `attach_evidence`, `request_verification`, `review_proposal` |
| `preview:request` | `request_preview` (metered; subject to policy and budgets) |
| `promotion:request` | `request_promotion` (asks a human; never promotes) |

The developer prompts their agent locally; there is no console intake or mission form. The agent’s typical loop: `get_project` / `get_active_work` → `create_mission` (objective, scope and plan) → `get_context` → `start_mission` (Cruce pins the base to an accepted revision and creates the workspace fork) → work and commit locally → `publish_revision` → `publish_artifact` (test reports, analyses) → `create_proposal` → `request_verification` / `request_preview` → `request_promotion`. `cruce publish` publishes committed work from a terminal; `cruce refresh` (or the bridge's `refresh_source` tool) fetches accepted objects into `refs/cruce/accepted` without touching the working tree; `cruce check` reports the publication decision.

`node runner/cruce.ts mcp --cwd ./payments` is the stdio bridge for clients that need a local process; remote clients use Streamable HTTP `/mcp` directly. Durable state belongs to the project authority, not the transport session. Mutations require idempotency keys and expected versions; a retry returns the original receipt.

## Revisions, evidence and policy

`publish_revision` accepts a base64 Git pack (bounded to 4 MiB of pack) with the exact `base` (workspace head) and `revision`. The recorded revision is the agent's commit; it must descend from the workspace head and contain the latest plan baseline, otherwise the agent merges locally first. A bounded files mode remains for clients without a checkout.

`publish_artifact` stores typed evidence against an exact revision, recording where it executed. `attach_evidence` cites artifacts of the proposal's exact revision; agent results remain *reported*. Human attestation and Cruce's own runtime checks are labeled differently. `set_policy` (human maintainer, reason, current version) sets approvals, required trusted evidence, resource rules and budgets.

## Cloudflare account and environments

Infrastructure Cruce triggers belongs to the project's Cloudflare account. In **Environments** a maintainer connects an account ID and an API token with Workers Builds read, Workers Scripts read and Artifacts edit permissions (`POST /api/projects/account`). The token is verified, sealed with `CRUCE_SECRET` and never returned. If the account is the one Cruce is deployed in, deploy repositories use the Artifacts binding (operator mode); otherwise Artifacts' REST API (connected mode).

Enable deployment with a Worker name (detected from `wrangler.jsonc/json/toml` or `cloudflare.config.ts` when present) and smoke check paths. Cruce creates `project-<id>--deploy` and records Worker Preview and Production environments. Then, in the Cloudflare dashboard, connect Workers Builds for that Worker to the deploy repository (production branch `main`, preview builds enabled); Cruce never edits Worker settings. Applications deployed elsewhere can record an external production environment; every other lifecycle feature still applies.

## Platform references

[Artifacts](https://developers.cloudflare.com/artifacts/), [Workers Builds Artifacts integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/), [Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/), [Workflows](https://developers.cloudflare.com/workflows/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [MCP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/), [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude MCP](https://code.claude.com/docs/en/mcp), [Cursor MCP](https://cursor.com/docs/mcp).
