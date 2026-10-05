# Native Git and coordination setup

Use Node 22.18+ and install Cruce's dependencies. Create a namespace, connect its Cloudflare account with Artifacts Read/Edit permission, then create a repository. Cruce initializes its configured default branch. GitHub/GitLab and Workers Builds are not required.

## Authenticate normal Git

The repository's Clone control shows its canonical Git URL. The gateway uses stable IDs:

```text
https://YOUR_HOST/mcp/git/NAMESPACE_ID/REPOSITORY_ID/canonical.git
```

Authorize a standard Git credential helper once. This is authentication setup; it does not clone or modify your repository:

```sh
node /absolute/path/to/cruce/runner/git-credential.mjs login --server https://YOUR_HOST --client git

git -c credential.useHttpPath=true \
  -c 'credential.helper=!node /absolute/path/to/cruce/runner/git-credential.mjs --server https://YOUR_HOST --client git' \
  clone https://YOUR_HOST/mcp/git/NAMESPACE_ID/REPOSITORY_ID/canonical.git
```

For subsequent commands, use the same `-c` options or install that helper in your own Git configuration, scoped to this host. Helper configuration contains paths and a server address, never tokens. OAuth credentials are stored privately outside Git. Cloudflare repository tokens remain on the server, expire after 60 seconds and are revoked after each request. Git passwords must not be embedded in remote URLs.

Canonical is readable by authorized users and agents. Its default branch advances only through reviewed human promotion. Each writer workspace has a separate writable fork; `get_git_access` returns its path. Git clone/fetch/pull/push work on those remotes normally.

## Coordinate local agents

From a clone or an existing checkout containing the canonical base commit:

```sh
node /absolute/path/to/cruce/runner/cruce.mjs connect --server https://YOUR_HOST --namespace NAMESPACE_ID --repository REPOSITORY_ID --client codex
node /absolute/path/to/cruce/runner/cruce.mjs start --title "Improve retries"
```

MCP exposes the same coordination capabilities. Starting work through the bridge creates a dedicated local worktree and attaches the durable workspace to a direct canonical Artifacts fork. Move to the returned directory before editing. Cruce never launches your agent. Isolated clones are also a supported execution-context kind for other adapters.

Each owned worktree gets a unique `cruce-WORKSPACE_ID` remote and branch-specific push destination. Other worktrees' destinations and the developer's existing origin remain unchanged. The fork inherits provider refs at fork time; the local checkout and workspace metadata pin the requested starting commit, also retained at the fork's `cruce-base` branch.

```sh
git add .
git commit -m "Improve retries"
git push
node /absolute/path/to/cruce/runner/cruce.mjs publish --title "Bound retries"
```

Publishing seals the exact pushed branch revision into separate immutable source-artifact storage, validates ancestry and protected paths, and records a review base. It neither commits nor pushes your local work. Create a proposal, inspect the exact revision, record evidence and request human promotion through Cruce.

Inspect `get_workspace_updates` for changed paths and advisory overlap. Fetch canonical with Git, merge explicitly, resolve conflicts and verify before pushing and publishing a reconciled revision. A worktree credential helper is scoped to its fork; use the canonical connection's helper options when fetching canonical by URL. The original workspace base and previous artifacts stay unchanged. There are no Cruce clone, checkout, fetch, pull, push or commit replacements.

The bridge renews presence every 30 seconds; disconnected presence after 90 seconds does not release persistent checkout ownership. `resume` reattaches prepared work after an interruption. `end` completes participation without merging. `end --cleanup` additionally removes only an owned, clean local worktree whose head is published or still at its retained base.

Hosted cleanup is a separate explicit `cleanup_workspace` operation or console action. End the workspace first. Every remote ref must be retained by canonical or an immutable artifact; annotated tags and other unretained refs block removal. The first call may return `deleting`; repeat the same operation until `deleted`. Metadata, reviews and artifacts remain available. Local files are unaffected by hosted cleanup.

## Human terminals

`cruce.mjs human --server URL --namespace ID --repository ID` requests a browser-approved terminal connection. It may attach an existing checkout but cannot approve source promotion or production. Its credential helper can use `--human-file /absolute/path/to/git-metadata/cruce/connection.json` instead of OAuth tokens, scoped to the same repository. Use the fork URL from `get_git_access` for explicit `git push FORK_URL HEAD:BRANCH`; existing remotes are preserved. Renew the terminal authorization from its checkout when it expires.

## Deployment boundary and limits

The checked-in Access transport configuration adds only `/mcp/git/*` to machine transport exceptions; OAuth or the separately approved terminal credential still authorizes every request. Apply this configuration and deploy the new Worker before treating displayed URLs as live. These changes are locally verified, not live-verified in this task.

The gateway bounds each request and response to 32 MiB and rejects redirects. This is a Cruce transport limit, distinct from Artifacts repository/blob limits. Repositories requiring larger single transfers need a streaming gateway enhancement. Fork-at-exact-commit and automatic semantic conflict detection are not claimed capabilities. Existing pre-refactor state is not migrated.
