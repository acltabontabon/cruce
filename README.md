# Cruce

**An agent-native development platform built on Git and Cloudflare Artifacts.** Developers prompt their agents locally. Agents register missions through MCP and work with their own tools and Git. Cruce coordinates the lifecycle around that work: missions, exact revisions, evidence, proposals, verification, policy, environments, promotion and lineage.

Cruce does not replace Git. It replaces the collaboration model above it.

```text
Traditional:  Git → GitHub/GitLab → branches → pull request → human review → CI → merge
Cruce:        Git → Cloudflare Artifacts → Mission → Workspace → Git revision
                  → Artifacts + evidence → Proposal → Verification → Promotion → Deployment
```

## Four foundations

1. **Git** — the mechanics of software evolution: revisions, history, diffs, forks, merges, conflicts, rollback. Agents commit real Git history; Cruce never invents a weaker replacement.
2. **Cloudflare Artifacts** — the canonical home of every project's repository. One canonical repository per project (`main` is accepted source), one fork per mission workspace, an evidence repository, and a deploy repository Workers Builds reads from. No GitHub or GitLab is required.
3. **Cruce MCP** — the intentional machine interface. Tools express Cruce concepts (`get_context`, `start_mission`, `publish_revision`, `attach_evidence`, `request_preview`, `request_promotion`…), never generic Cloudflare administration. Resource-consuming tools are governed by scopes, policy and budgets.
4. **Cruce Control Tower** — the Cloudflare-native control plane (Workers, one Durable Object per project, a Workflow for deployment orchestration). It decides; agents request.

```text
 Claude Code / Codex / Cursor / IDE / terminal / git   (local execution)
                         │ MCP (remote, or the tiny local bridge)
                         ▼
                    Cruce MCP ──► Cruce Control Tower (Workers + Durable Objects + Workflows)
                                   missions · policy · proposals · verification · lineage · environments
                                         │ Git + Artifacts
                                         ▼
                                Cloudflare Artifacts (canonical software state)
                                         │
                       local build/test/dev      Workers Builds → Worker Preview → Production
```

## What Cruce connects

| Question | Answered by |
| --- | --- |
| Why did it change? | Mission objective and context |
| What work? | Mission (with a concrete base revision) |
| Who or what? | Agent identity and session |
| What changed? | Exact Git revision, commits and diff |
| What was produced? | Immutable artifacts anchored to that revision |
| Why trust it? | Verification of that exact revision: reported, human attested, or verified by Cruce |
| Where did it run? | Environment and deployment |
| What is live? | The deployed revision, traceable back to the mission |

## Run locally

Current version: **0.1.0-alpha.1** (first alpha). See the [changelog](CHANGELOG.md) and [release instructions](docs/releases.md). Live deployments run only for matching release tags after checks pass.

```sh
pnpm install
pnpm exec cf dev --mode offline
```

The native console is `/` (sign-in uses Cloudflare Access). The deterministic coordination demo is `/demo` and works offline. For an Artifacts-backed environment, `pnpm exec cf auth login`, configure Access as in [native setup](docs/native-setup.md), then `pnpm exec cf dev`.

## Work with your existing agent

```sh
node runner/cruce.ts checkout --server https://YOUR_CRUCE_HOST --project PROJECT_ID --directory ./payments
node runner/cruce.ts connect --server https://YOUR_CRUCE_HOST --project PROJECT_ID --client claude --cwd ./payments
```

The agent keeps running on your machine. Through MCP it reads context, creates a mission with its plan, starts that mission (Cruce pins an accepted base revision and creates the workspace fork), commits with normal Git, and publishes with `publish_revision`: the bridge sends a Git pack of your commits and Cruce pushes that exact revision with a 60-second server-side credential. Agents never hold Artifacts write tokens. `cruce publish` does the same from a terminal.

## Safe autonomy

- **Scopes**: agent connections receive explicit scopes at consent (`cruce:read`, `workspace:write`, `proposal:write`, `preview:request`, `promotion:request`). Promotion and production deployment are never agent scopes.
- **Control vs resource actions**: reading context is cheap; creating workspaces, publishing to Artifacts, Worker previews, cloud AI and production deployment are resource actions with a cost class.
- **Policy and budgets**: per project, each resource action is allowed, needs human approval, or is denied; preview and workspace budgets turn into approvals instead of silent spend. Production always needs a human.
- **Billing boundary**: deployments use the project's Cloudflare account (the account Cruce is deployed in, or a connected account). Its API token is sealed and never shown.

## Cloudflare Workers golden path

Cruce detects Workers (`wrangler.jsonc/json/toml`, `cloudflare.config.ts`). Enabling deployment creates an Artifacts deploy repository for Workers Builds: Cruce pushes a proposal's exact revision to a preview branch, a Workflow waits for the build, Cruce runs its own smoke checks against the preview URL and records them as runtime-verified evidence. A human promotes, optionally deploying production in the same decision. Rollback is explained as the proposals it removes. Non-Cloudflare applications keep every other capability.

## Verification

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm exec cf build --mode offline
bash demo/scripts/verify-scenario.sh
```

Live gates still outstanding are listed in the [plan](docs/PLAN.md). See [architecture](docs/architecture.md), [Artifacts model](docs/artifacts-model.md), [native setup](docs/native-setup.md), [product thesis](docs/product-thesis.md), [demo](docs/demo.md) and [progress](docs/PROGRESS.md).
