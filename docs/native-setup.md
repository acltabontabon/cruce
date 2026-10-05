# Git and bridge setup

[Documentation map](../README.md#documentation-map) · [MCP participation](mcp.md) · [Cloudflare setup](cloudflare-setup.md)

This is the workflow supported by the current implementation. The current Worker/Access Git configuration still needs live verification; check [environment status](test-environment.md) before using hosted URLs. For a no-cloud tour, use the [local fixture](../CONTRIBUTING.md#set-up-and-explore).

Use Git, Node 22.18+ and installed Cruce dependencies. Sign in through Access, connect the namespace's Cloudflare account with Artifacts access, and create a repository. Cruce initializes its configured default branch. Repository creation and writer attachment consume Artifacts resources. CI, releases and deployments remain external.

## Authenticate and clone with Git

The repository's Clone control shows the canonical remote with stable IDs:

```text
https://YOUR_HOST/mcp/git/NAMESPACE_ID/REPOSITORY_ID/canonical.git
```

Replace the host, IDs and absolute Cruce installation path in these examples. Authorize a standard Git credential helper, then clone:

```sh
node /absolute/path/to/cruce/runner/git-credential.mjs login --server https://YOUR_HOST --client git

git -c credential.useHttpPath=true \
  -c 'credential.helper=!node /absolute/path/to/cruce/runner/git-credential.mjs --server https://YOUR_HOST --client git' \
  clone https://YOUR_HOST/mcp/git/NAMESPACE_ID/REPOSITORY_ID/canonical.git
```

Use the same `-c` options for subsequent canonical operations, or configure the helper yourself scoped to this host. Helper configuration contains paths/server addresses, never tokens. OAuth credentials are stored privately outside tracked source. Cloudflare repository tokens remain server-side. Never embed a password in a remote URL.

Canonical is readable by authorized participants; its accepted branch advances through reviewed human promotion. Writers push to their own forks with normal Git. `get_git_access` returns canonical and fork paths relative to the Cruce server.

## Connect and start isolated work

From the cloned repository, or an existing checkout containing the known canonical base:

```sh
node /absolute/path/to/cruce/runner/cruce.mjs connect --server https://YOUR_HOST --namespace NAMESPACE_ID --repository REPOSITORY_ID --client codex
node /absolute/path/to/cruce/runner/cruce.mjs start --title "Improve retries"
```

`connect` authorizes the client, saves local connection state and, for `codex`, `claude` or `cursor`, writes client MCP configuration and participation instructions. Choose either the CLI `start` above or let the connected agent call `start_workspace` through MCP. Move the agent to the returned dedicated directory before editing; Cruce does not launch or relocate its process.

The bridge creates a worktree at the exact starting commit and attaches one hosted fork to the workspace. A unique `cruce-WORKSPACE_ID` remote and branch-specific push destination keep other worktrees' destinations and existing `origin` unchanged. Attaching by repository ID is not an import: it never identifies a repository from a matching remote URL or silently uploads unrelated history.

The MCP bridge renews presence and reports local changes while it runs. For standalone CLI participation, run this in a separate terminal using the returned worktree directory:

```sh
node /absolute/path/to/cruce/runner/cruce.mjs watch
```

`start` alone is not a background monitor. Heartbeats run every 30 seconds; presence becomes disconnected after 90 seconds without activity, but checkout ownership remains. `resume` reattaches a prepared workspace after interruption. Use separate authorized connections and bridge processes for independent participants; a different display label is not an authority boundary.

## Commit, push and publish

Inside the returned worktree, stage the intended files and use Git:

```sh
git diff
git add path/to/changed-file
git commit -m "Improve retries"
git push
node /absolute/path/to/cruce/runner/cruce.mjs publish --title "Bound retries"
```

Publication seals the exact pushed branch revision into retained source storage. It validates ancestry/protected paths and pins a review base; it neither commits nor pushes local files. Through MCP, create a proposal from the returned artifact, record exact-revision evidence and request human promotion. The console supports review and the human decision. See [MCP command families](mcp.md#current-command-families).

When source advances, inspect `get_workspace_updates`, fetch canonical with Git and merge explicitly. Use the canonical helper options from above when fetching its URL; the worktree's automatic credential helper is scoped to its fork. Resolve conflicts, run relevant checks, then push/publish and propose the reconciled revision for fresh review. Published ancestry must remain reachable: rebasing away previously published commits will fail publication checks. The original workspace base and earlier artifacts never change.

`git branch`, `git diff`, `git log`, `git fetch`, `git pull` and other normal Git operations keep their meaning. Cruce supplies no clone, checkout, fetch, pull, push or commit replacements. Git operations against existing non-Cruce remotes remain the developer's responsibility; a reported local ref is not proof of a successful remote integration.

## End and clean up deliberately

`cruce.mjs end` completes participation without merging. `end --cleanup` also attempts to remove a Cruce-owned, clean local worktree whose head is published or still at its retained base. Stop a separate `watch` process when done. Human-owned checkouts are preserved.

Hosted fork cleanup is a separate `cleanup_workspace` operation or console action. End the workspace first. Every remote ref must be retained by canonical or an immutable artifact; unretained commits, annotated tags and other non-commit refs block removal. A response may be `deleting`; repeat the same operation until `deleted`. Workspace metadata, reviews and artifacts remain; hosted cleanup does not remove local files.

## Human terminals

`cruce.mjs human --server URL --namespace ID --repository ID` requests browser-approved terminal participation. Then use `start` from the existing checkout. Human terminals can attach that checkout but cannot approve canonical source promotion.

The credential helper can use `--human-file /absolute/path/to/git-metadata/cruce/connection.json` with `credential.useHttpPath=true`, scoped to that repository. Use the fork URL from `get_git_access` for explicit `git push FORK_URL HEAD:BRANCH`; existing remotes remain unchanged. Renew terminal authorization from its checkout when it expires. Agent MCP must use its own OAuth connection, never human terminal credentials.

## Troubleshooting boundaries

| Symptom | Check |
| --- | --- |
| Git redirects to browser sign-in | Current Worker and narrow Access `/mcp/git/*` transport configuration must be applied |
| Authentication or scope denied | Reauthorize the connection and check current membership, repository selection and scopes; retry cannot bypass revocation |
| Workspace remains preparing | Retry `resume` with the original workspace after resolving attachment/provisioning failure |
| Publication rejects a revision | Push the exact branch head first; preserve base/previous-publication ancestry and satisfy protected-path policy |
| Checkout or cleanup is refused | Inspect persistent ownership, dirty/unpublished files and unretained remote refs; a stale heartbeat is not permission to delete |
| Transfer exceeds bounds | Current gateway requests/responses are limited to 32 MiB; see [platform limits](cloudflare-setup.md#limits-and-costs) |

Early-development state from retired models is not migrated. Missing live verification remains visible in [verification status](local-verification.md), separate from these operating instructions.
