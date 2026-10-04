For native projects (Access identity, scopes, Cruce MCP, Artifacts source, connected accounts and environments) follow [native setup](native-setup.md). This page covers the Cloudflare resources and the deterministic demo.

# Cloudflare setup

Everything here was set up with the `cf` CLI (1.0.0-beta.12) and `cloudflare.config.ts`. Wrangler is not
used for the project (only its docs were consulted for event-subscription body shapes).

## Requirements

- A Cloudflare account on **Workers Paid** (Artifacts requires it; Durable Objects, Workflows and Queues are
  included).
- Node 22.18+ (the local bridge and demo-repo tests need Node 23.6+ for TypeScript type stripping), pnpm, git.

```sh
npm install --global cf@latest
cf auth login            # browser approval
cf auth whoami
```

## Resources

| Resource | Name / id | Created by | Purpose |
|---|---|---|---|
| Worker | `cruce` → https://cruce.acltabontabon.workers.dev | `cf deploy` | console, Cruce MCP, API, queue consumer |
| Durable Object | `ControlTower` (SQLite) | `cf deploy` | one Control Tower per project (and the demo) |
| Durable Object | `ProjectDirectory` (SQLite) | `cf deploy` | project membership and identity |
| Workflow | `cruce-deployment` (`DeploymentWorkflow`) | `cf deploy` | await Workers Builds, run smoke checks, record evidence |
| KV | `OAUTH_KV` | `cf deploy` | MCP OAuth grants |
| Artifacts namespaces | `cruce` (prod), `cruce-dev` (dev) | implicitly on first repo | project, workspace, evidence and deploy repositories; demo repos |
| Artifacts repos | `project-<id>`, `project-<id>--w-<n>`, `project-<id>--evidence`, `project-<id>--deploy`; demo `auth-service`, `auth-service--fNNN` | Cruce | |
| Queue | `cruce-artifact-events` (`f86ac1b9…`) | `cf queues create` | Artifacts event delivery; consumer = Worker |
| Event subscription | `cruce artifacts account` (source `artifacts`) | `cf queues subscriptions create` | repo.created / forked / deleted / imported |
| Event subscriptions | `cruce repo <ns>/<repo>` (source `artifacts.repo`) | Cruce at runtime | pushed / token.created / token.revoked per repo |
| API token | `cruce-event-subscriptions` (account-owned, Queues Write, expires 2026-12-31) | `cf accounts tokens create` | lets Cruce manage per-repo subscriptions |

## Secrets

| Secret | Used for | Where |
|---|---|---|
| `CRUCE_SECRET` | sealing identity cookies and connected-account credentials | `.dev.vars`, `.secrets.prod.json` |
| `CF_EVENTS_API_TOKEN` | event-subscription management | same |

Connected-account API tokens are entered by project maintainers in the console and stored sealed per project; they are not deployment secrets.

`.dev.vars` and `.secrets*` are gitignored. Never commit them; never put tokens in Git remotes.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars          # fill CRUCE_SECRET and Access settings
pnpm exec cf dev                        # Artifacts (remote binding, namespace cruce-dev)
pnpm exec cf dev --mode offline         # no account needed: local Git backend
```

The Artifacts binding has no local simulator; `bindings.artifacts({ dev: { remote: true } })` makes local
dev use the real service in the `cruce-dev` namespace. The queue consumer only receives real events in
production; locally Cruce records its own gated pushes.

## Deploy

```sh
pnpm exec cf deploy --dry-run
pnpm exec cf deploy --secrets-file .secrets.prod.json
```

## Workers Builds / previews (Cruce's own source)

Cruce's source is mirrored into Artifacts with `tools/mirror-to-artifacts.sh` (→ `cruce/cruce-platform`;
2-minute write token per push, every token revoked afterwards). To build and deploy Cruce from it:

1. Dashboard → **Workers & Pages** → `cruce` → **Settings → Builds → Connect** → namespace `cruce`,
   repository `cruce-platform`.
2. Build command: `pnpm install`. Deploy command: `npx cf deploy`. Preview command: `npx cf previews deploy`
   (the project uses `cf` + `cloudflare.config.ts`, not Wrangler's default commands).
3. Turn on **Builds for Preview branches**: pushes to non-`main` branches of `cruce-platform` produce
   Worker Previews; `main` deploys production. Secrets stay configured on the Worker.

This is optional and separate from the product's own Worker Preview path for projects (see
[native setup](native-setup.md#cloudflare-account-and-environments)), which uses a per-project deploy repository.

## Verifying Artifacts from scratch

`tools/artifacts-smoke` is a minimal Worker with only the Artifacts binding:

```sh
cd tools/artifacts-smoke && pnpm install && pnpm exec cf dev &      # http://localhost:8790
bash scripts/verify.sh cruce-bootstrap
```

It creates a repo through the binding, pushes a commit with a standard git client (token in a transient
`http.extraHeader`), clones it into a separate directory with a READ token, checks the SHA, fetches,
round-trips Git notes, proves a read token cannot push, reads the repo through the binding, and revokes
both tokens. `scripts/probe-push-event.sh` pushes once so a `pushed` event can be observed on the queue.

`tools/verify-repo.sh <repo> <namespace>` independently checks what Cruce produced (plain git + `cf`).

## Notes and gotchas (as of Oct 2026)

- `create()` returns a token valid for about a year and `fork()` a 24-hour write token; Cruce revokes both.
- `repo.info().lastPushAt` may stay `null` after pushes; Cruce does not rely on it.
- Per-repo events need a subscription per repository (`source.namespace` + `source.repo_name` required).
- Account-level event names are `repo.created` etc. (without the `cf.artifacts.` prefix used in payloads).
- A queue can have one consumer: remove any `http_pull` consumer before attaching the Worker.
- `cf queues consumers delete`, `subscriptions delete`, and `artifacts namespaces tokens revoke` need `--force`
  in non-interactive shells — and exit 0 when they abort without it, so always pass it in scripts.
- pnpm 12 enforces a minimum release age; `isomorphic-git` is pinned to 1.42.6 for that reason.
- Workers Builds builds Artifacts repositories directly (production branch must be `main`; other branches
  produce Worker Previews). The Builds API lists builds with commit hash, branch, outcome and `preview_url`;
  connecting a repository to a Worker is a dashboard step for Artifacts today.
