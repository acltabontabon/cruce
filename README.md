# Cruce

Cruce is Git-native collaboration for developers and agents. A **workspace** owns repositories and access. A **repository** connects local Git or Cloudflare Artifacts hosting. A **session** records a human or agent's isolated work from an exact starting commit.

Git remains normal Git: real commits, branches, history, diffs, merges and rollback. Cruce adds shared presence, advisory overlap, revision-bound reviews, immutable artifacts and deployment provenance. Agents run locally with their own tools; Cruce does not launch them.

## Start locally

```sh
pnpm install
pnpm dev:fixture
```

The fixture console is a loopback-only, fixed-clock demonstration with human and agent sessions, overlapping work, exact Git commits, a source artifact and a proposed change. It uses the real controllers and cannot access live workspaces. For the actual Worker, run `pnpm exec cf dev --mode offline`; authenticated work requires configured Cloudflare Access.

## Connect a repository

Sign in with Access. Your first verified login creates a personal workspace. Create a shared workspace if needed, invite verified emails by copyable links, and assign repository access directly or through teams.

Choose **Open local repository**, name its configured default branch, and copy the workspace/repository IDs into the bridge command from Repository Settings:

```sh
node /path/to/cruce/runner/cruce.mjs connect --server https://YOUR_HOST --workspace WORKSPACE_ID --repository REPOSITORY_ID --client codex
node /path/to/cruce/runner/cruce.mjs start --title "Improve retries"
```

Agent writers receive a dedicated working directory. Use that directory for all work. Commits use ordinary Git. Registration preserves remotes and uploads no source. `publish` explicitly uploads the committed revision and creates a source artifact, requiring the workspace's connected Cloudflare account and policy allowance. Other checkouts attach by the same stable repository ID.

For human participation, use `human` instead of `connect` and approve the terminal connection in the browser. Human bridge credentials are restricted to one session; production decisions remain in the console. See [bridge setup](docs/native-setup.md).

## Resources and deployment

Local coordination works without Cloudflare account configuration. Hosted repositories, artifact publication and deployments consume resources in the **workspace's explicitly connected account**. Owners manage sealed credentials; shared budgets are reserved atomically across repositories. Repository policy may narrow those permissions.

Deployments name an immutable source artifact. Workers Builds consumes its exact revision from a separate deployment repository. Reviews/source acceptance and deployment remain separate records. Source snapshots and evidence are labelled distinctly; Cruce does not claim that a source snapshot is a downloadable compiled build. See [Cloudflare setup](docs/cloudflare-setup.md).

## Verify

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:browser
pnpm verify:scenario
pnpm exec cf build --mode offline
```

[Architecture](docs/architecture.md) · [Access and test environment](docs/test-environment.md) · [Demo](docs/demo.md) · [Progress](docs/PROGRESS.md) · [Releases](docs/releases.md)

Private workspaces/repositories and Access-based sign-in are the defaults. GitHub/GitLab integrations, public signup and automated external pushes are outside this foundation. Cruce is experimental; no compatibility or data-conversion layer is provided for the replaced project/mission architecture.
