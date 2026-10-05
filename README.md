# Cruce

Cruce helps one developer keep several agents working coherently on the same repository, with clear human control over what lands. It is Git-native collaboration for developers and agents, starting with the developer who already runs concurrent agent workspaces and spends time relaying updates, reconciling work and reviewing results.

A **namespace** owns repositories and access. A **repository** owns canonical Git history in Cloudflare Artifacts. A **workspace** records a human or agent's isolated work from an exact starting commit. Personal and shared namespaces remain supported; the initial product focus is one developer and one repository.

Git remains normal Git: real commits, branches, history, diffs, merges and rollback. Cruce adds shared presence across connected participants, advisory path overlap, upstream revision awareness, revision-bound reviews, immutable artifacts and deployment provenance. Agents run locally with their own tools; Cruce does not launch them. Worktree isolation is an existing Git capability; Cruce's value must come from reducing coordination work around it.

Hosted writer Workspaces reuse one dedicated Artifacts fork across publications. A Workspace can inspect upstream changes, fetch exact uploaded objects without changing its working files, then merge explicitly and publish a reconciled artifact for fresh review. The original starting revision stays fixed. Forks are the durable isolation boundary; semantic dependency detection and automatic conflict resolution are not current capabilities.

The product hypothesis is less manual relaying, less duplicated or stale work and less effort deciding what to accept. See the [product thesis](docs/product-thesis.md) and [validation plan](docs/PLAN.md) for how we will test that against ordinary worktrees and Git review. Parallel-agent adoption and a measurable advantage for Cruce remain hypotheses.

The [implementation plan](docs/git-foundation-plan.md) records the architecture, changes and verification boundaries.

The [Cloudflare strategy](docs/cloudflare-strategy.md) maps Artifacts forks, Git transport, event subscriptions and source inspection to those outcomes, with clear implementation status and platform costs/limits.

## Start locally

```sh
pnpm install
pnpm dev:fixture
```

The fixture console is a loopback-only, fixed-clock demonstration with human and agent workspaces, overlapping work, exact Git commits, a source artifact and a proposed change. It uses the real controllers and cannot access live namespaces. For the actual Worker, run `pnpm exec cf dev --mode offline`; authenticated work requires configured Cloudflare Access.

## Connect a repository

Sign in with Access. Your first verified login creates a personal namespace. Create a shared namespace if needed, invite verified emails by copyable links, and assign repository access directly or through teams.

Connect your namespace’s Cloudflare account and choose **New repository**. Clone its canonical remote with ordinary Git using the [OAuth credential helper](docs/native-setup.md). In that checkout, connect optional coordination tooling:

```sh
node /path/to/cruce/runner/cruce.mjs connect --server https://YOUR_HOST --namespace NAMESPACE_ID --repository REPOSITORY_ID --client codex
node /path/to/cruce/runner/cruce.mjs start --title "Improve retries"
```

Agent writers receive a dedicated working directory. Use that directory for all work. Commits use ordinary Git. Run `git push` to your workspace fork before `publish`, which seals the exact pushed revision into a retained source artifact for review. Existing remotes are preserved. Other checkouts attach by the same stable repository ID.

For human participation, use `human` instead of `connect` and approve the terminal connection in the browser. Human bridge credentials are restricted to one workspace; production decisions remain in the console. See [bridge setup](docs/native-setup.md).

## Resources and deployment

Repositories, workspace forks, artifact publication and deployments consume resources in the **namespace's explicitly connected account**. Owners manage sealed credentials; shared budgets are reserved atomically across repositories. Repository policy may narrow those permissions.

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

Private namespaces/repositories and Access-based sign-in are the defaults. GitHub/GitLab integrations, public signup and automated external pushes are outside this foundation. Cruce is experimental; no compatibility or data-conversion layer is provided for the replaced project/mission architecture.
