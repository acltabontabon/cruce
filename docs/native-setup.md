# Git and bridge setup

[Documentation map](../README.md#documentation-map) · [MCP participation](mcp.md) · [Cloudflare setup](cloudflare-setup.md)

This is the workflow supported by the current implementation. Real-provider convergence and some deployed setup/authentication boundaries have evidence, but authenticated deployed publication/promotion and multi-tool, multi-session participation remain pending; check [verification status](local-verification.md). The [architecture audit](architecture.md#architecture-contradictions-and-correctness-gaps) records the remaining gaps. For a no-cloud tour, use the [local fixture](../CONTRIBUTING.md#set-up-and-explore).

Use Git and Node 22.18+ (including npm). Install the local Cruce client from the same website you use for the console; no Cruce source checkout is needed. Once the administrator has configured installation storage, sign in through Access and create a repository. No developer Cloudflare account or API token is required. Cruce initializes its configured default branch. Repository creation and writer attachment consume Artifacts resources. CI, releases and deployments remain external.

Explicit console sign-in or OAuth authorization initializes your Cruce identity and personal namespace. Coordination reads never create identity, repository metadata or source storage. If canonical setup was interrupted, inspect the registered repository and use its maintainer-only setup retry; reading it consumes no Artifacts operation. An unknown identity must sign in again. See the [read boundary](architecture.md#coordination-read-boundary).

## Authenticate and clone with Git

The repository's Clone control shows the canonical remote with stable IDs:

```text
https://YOUR_HOST/mcp/git/NAMESPACE_ID/REPOSITORY_ID/canonical.git
```

Install the client once on each machine. The website serves an npm package containing the bridge and Git credential helper, matching its build. npm installs its declared runtime dependencies; this does not require a separately published npm registry package:

```sh
npm install --global https://YOUR_HOST/downloads/cruce-client.tgz
```

Replace `YOUR_HOST` and the IDs below with the values shown by the repository's Clone control. Authorize Git, select this repository on the consent page, then clone:

```sh
cruce auth --server https://YOUR_HOST --namespace NAMESPACE_ID --repository REPOSITORY_ID
git clone https://YOUR_HOST/mcp/git/NAMESPACE_ID/REPOSITORY_ID/canonical.git
```

`auth` signs in through OAuth and configures the installed credential helper in your global Git configuration, scoped to this repository's exact canonical URL. Clone and subsequent fetches use ordinary Git without extra credential options. Existing helpers for other destinations remain unchanged. Helper configuration contains installation paths/server addresses, never tokens. OAuth credentials are stored privately outside tracked source. Cloudflare repository tokens remain server-side. Never embed a password in a remote URL.

Canonical is readable by authorized participants; its accepted branch advances through reviewed human promotion. Writers push to their own forks with normal Git. `get_git_access` returns canonical and fork paths relative to the Cruce server.

## Connect and start isolated work

From the cloned repository, or an existing checkout containing the known canonical base:

```sh
cruce connect --server https://YOUR_HOST --namespace NAMESPACE_ID --repository REPOSITORY_ID --client codex
cruce start --title "Improve retries"
```

`auth` and `connect` carry the selected namespace/repository into browser consent. Confirm access to that one repository; there is no second repository picker. The updated client keeps OAuth credentials per repository, so authorize each repository once after updating the installed client. Existing grant records are not rewritten.

`connect` authorizes the client, saves local connection state and, as a convenience for `codex`, `claude` or `cursor`, writes client MCP configuration and a participation block. Any MCP-capable tool can connect without it. Choose either the CLI `start` above or let a connected agent call `start_workspace` through MCP. Move the agent to the returned dedicated directory before editing; Cruce does not launch or relocate its process.

The bridge creates a worktree at the exact starting commit and attaches one hosted fork to the workspace. A unique `cruce-WORKSPACE_ID` remote and branch-specific push destination keep other worktrees' destinations and existing `origin` unchanged. Attaching by repository ID is not an import: it never identifies a repository from a matching remote URL or silently uploads unrelated history.

For parallel work through one MCP connection, call `start_workspace` for each workstream. Keep each returned `id` and `directory`, and pass `workspaceId` to workspace operations such as `report_change`, `publish_revision`, `publish_artifact`, `get_workspace_updates` and `detach_workspace`, and to change operations such as `create_proposal` and `record_verification` (their artifact/proposal IDs still identify the reviewed record). Previous workspaces remain attached to their own worktrees. `attach_workspace` with a workspace ID creates or reuses that workspace's local execution without a CLI handoff. `cruce publish --workspace ID` can also select a locally registered workspace from the repository root. CLI and MCP reload the same workspace state, including pending retry identity.

The MCP bridge renews presence and reports local changes for the workspaces it starts, attaches or uses locally while it runs. For standalone CLI participation, run this in a separate terminal using the returned worktree directory:

```sh
cruce watch
```

`start` alone is not a background monitor. Heartbeats run every 30 seconds; presence shows disconnected after 90 seconds without activity, but the attachment and checkout ownership remain. `resume` reattaches a prepared workspace after an interrupted first attachment. A display label is not an authority boundary; the workspace belongs to its owner, whichever tool connects.

## Commit, push and publish

Inside the returned worktree, stage the intended files and use Git:

```sh
git diff
git add path/to/changed-file
git commit -m "Improve retries"
git push
cruce publish --title "Bound retries"
```

Publication seals the exact pushed branch revision into retained source storage. It validates ancestry/protected paths and pins a review base; it neither commits nor pushes local files. Through MCP, create a proposal from the returned artifact, record exact-revision evidence and request human promotion. The console supports review and the human decision. See [MCP command families](mcp.md#command-families).

When a maintainer enables observation, push events trigger bounded, identity-checked fork inspection. Reported local heads, observed fork refs, published revisions and accepted canonical source remain different facts. Observation health and published ancestry are available through `get_reconciliation`. Do not treat heartbeat presence as proof that change reports are current.

When source advances, inspect `get_workspace_updates`, fetch canonical with Git and merge explicitly. The configured canonical helper authenticates fetches; the worktree also has a helper scoped to its fork. Resolve conflicts, run relevant checks, then push/publish and propose the reconciled revision for fresh review. Published ancestry must remain reachable: rebasing away previously published commits will fail publication checks. The original workspace base and earlier artifacts never change.

`git branch`, `git diff`, `git log`, `git fetch`, `git pull` and other normal Git operations keep their meaning. Cruce supplies no clone, checkout, fetch, pull, push or commit replacements. Git operations against existing non-Cruce remotes such as `origin` remain the developer's responsibility.

## Continue a workspace elsewhere

A workspace is not tied to an agent session, a process or a machine. A new agent session pointed at the workspace's worktree (`cruce mcp --cwd WORKTREE`) continues the same workspace. To move it to another checkout or machine, first release the current execution attachment from the old checkout:

```sh
cruce detach
```

`detach` keeps the worktree, the fork and all history. It only releases the local writer lock and the server attachment. If the old machine is unavailable, the owner can release the attachment from the console. Then, in any clone of the repository on the new machine:

```sh
cruce connect --server https://YOUR_HOST --namespace NAMESPACE_ID --repository REPOSITORY_ID
cruce resume --workspace WORKSPACE_ID
```

`resume --workspace` creates a Cruce-owned worktree at the workspace baseline, configures the workspace fork remote and fast-forwards to the branch head you last pushed. Only pushed work travels; Git is the transport. Unpushed commits and uncommitted files stay where they were made. If the pushed history does not fast-forward from the baseline, `resume` stops and leaves the worktree for you to reconcile with Git.

## End and clean up deliberately

`cruce end` completes participation without merging. `end --cleanup` also attempts to remove a Cruce-owned, clean local worktree whose head is published or still at its retained base. Stop a separate `watch` process when done. Human-owned checkouts are preserved.

Hosted fork cleanup is a separate `cleanup_workspace` operation or console action. End the workspace first. Every remote ref must be retained by canonical or an immutable artifact; unretained commits, annotated tags and other non-commit refs block removal. A response may be `deleting`; repeat the same operation until `deleted`. Workspace metadata, reviews and artifacts remain; hosted cleanup does not remove local files.

## Human terminals

`cruce human --server URL --namespace ID --repository ID` requests browser-approved terminal participation. Then use `start` from the existing checkout. Human terminals can attach that checkout but cannot approve canonical source promotion.

The credential helper can use `--human-file /absolute/path/to/git-metadata/cruce/connection.json` with `credential.useHttpPath=true`, scoped to that repository. Use the fork URL from `get_git_access` for explicit `git push FORK_URL HEAD:BRANCH`; existing remotes remain unchanged. Renew terminal authorization from its checkout when it expires. Agent MCP must use its own OAuth connection, never human terminal credentials.

## Troubleshooting boundaries

If `cruce` is not found, check that npm’s global executable directory is on your `PATH`. If global installation is denied, use a user-owned npm prefix rather than installing with administrator privileges. Reinstall from the same site to update the client.

| Symptom | Check |
| --- | --- |
| Git redirects to browser sign-in | Current Worker and narrow Access `/mcp/git/*` transport configuration must be applied |
| Authentication or scope denied | Reauthorize the connection and check current membership, repository selection and scopes; retry cannot bypass revocation |
| Workspace remains preparing | Retry `resume` with the original workspace after resolving attachment/provisioning failure |
| Attach refused: attached elsewhere | `detach` on the old checkout, or release the attachment from the console, then `resume --workspace ID` |
| Publication rejects a revision | Push the exact branch head first; preserve base/previous-publication ancestry and satisfy protected-path policy |
| Checkout or cleanup is refused | Inspect persistent ownership, dirty/unpublished files and unretained remote refs; a stale heartbeat is not permission to delete |
| Transfer exceeds bounds | Git request/response bodies are capped at 32 MiB, including chunked transfers; the gateway returns 413 rather than forwarding a partial pack. See [supported bounds](architecture.md#bounded-coordination-state-and-retention-recovery) |
| Fork deletion is pending or blocked | Inspect retention in the workspace console or `get_retention`. Authorized pending cleanup recovers automatically; blocked cleanup needs the original actor to retry its recorded operation after restoring authority, policy, provider identity or retention. Expiry never authorizes deletion |
| Coordination capacity is reached | Inspect Repository Settings and the supported state/record envelope. Ending finished workspaces and cleaning up their forks moves them to Earlier work and frees live capacity; nothing is deleted. See [operations](operations.md) |

Early-development state from retired models is not migrated. Missing live verification remains visible in [verification status](local-verification.md), separate from these operating instructions.
