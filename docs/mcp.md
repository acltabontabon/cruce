# MCP participation

[Documentation map](../README.md#documentation-map) · [Git and bridge setup](native-setup.md) · [Domain model](domain-model.md) · [Principles](principles.md)

Cruce's MCP interface exposes the Cruce coordination model: repositories, workspaces, baselines, revisions, overlap, divergence, proposals, promotion state and provenance. It is not Git transport, not an agent runtime and not a messaging channel between agents. It does not duplicate generic Git, forge, Cloudflare or agent-framework functionality because that would be easy to expose.

Any MCP client can use it: Claude Code, Codex, Cursor, another agent, an orchestration framework, a relay or a script. Cruce treats them identically. The client name is a label recorded as provenance, never an identity or an authority.

The single executable catalog is [src/shared/tools.ts](../src/shared/tools.ts). Its descriptions, scopes, mutation flags, resource classes and input fields drive both the hosted server and the local bridge. Shared schemas live in [src/shared/platform.ts](../src/shared/platform.ts). Consult those files for exact arguments rather than a copy here.

## Connection paths

| Path | What it does | Client responsibilities |
| --- | --- | --- |
| Local stdio bridge: `node /absolute/path/to/cruce/runner/cruce.mjs mcp --cwd /absolute/path/to/checkout --client NAME` | Connects to hosted `/mcp` with OAuth. Creates isolated worktrees, attaches them and reports local Git state | Work in the returned directory |
| Direct hosted MCP: `https://YOUR_HOST/mcp` | Repository-scoped coordination through OAuth | Provide local isolation, locks, attachment, heartbeats and change reports yourself, naming the attached execution on every report |
| Git smart HTTP | Normal clone/fetch/pull/push with the Cruce credential helper | Use Git, not MCP, to move source |

The bridge supplies namespace, repository, workspace and execution identities, plus mutation idempotency keys, from local connection state. It handles `start_workspace` by creating and attaching a dedicated worktree for agent writers. A direct remote call only registers the workspace; it creates no local files and launches nothing.

`connect --client codex|claude|cursor` writes that client's MCP configuration and a short participation block through [runner/client-config.ts](../runner/client-config.ts): `.codex/config.toml` and `AGENTS.md`, `.mcp.json` and `CLAUDE.md`, or `.cursor/mcp.json` and `.cursor/rules/cruce.mdc`. Surrounding content is preserved. This is a convenience. Any MCP-capable tool can connect without it, and generated instructions do not prove an agent uses the context.

## Command families

| Purpose | Commands | Scope / resource boundary |
| --- | --- | --- |
| Discover | `list_namespaces`, `list_repositories`, `get_repository` | `cruce:read`; recorded state only |
| Inspect workspaces and concurrency | `get_workspace`, `list_active_workspaces`, `get_workspace_updates`, `get_reconciliation`, `inspect_overlap` | `cruce:read`; overlap is advisory; divergence uses available objects only |
| Inspect cached source and provenance | `get_git_access`, `get_source`, `get_history`, `get_diff`, `read_artifact`, `get_lineage` | `cruce:read`; source requires locally available objects; never fetches |
| Inspect or recover stored source explicitly | `inspect_source`, `recover_source` | Read grant / `cruce:read`; `source.read` resource policy and idempotency key |
| Workspace lifecycle | `start_workspace`, `detach_workspace`, `end_workspace` | `workspace:write`; owner only for existing workspaces |
| Execution reports | `heartbeat`, `report_change` | `workspace:write`; must name the attached execution |
| Attach or clean up a fork | `attach_workspace`, `cleanup_workspace` | `workspace:write`; Artifacts resource operations |
| Retain revisions or evidence | `publish_revision`, `publish_artifact` | `revision:publish` / `artifact:publish`; Artifacts resource operations |
| Propose and review | `create_proposal`, `review_proposal`, `record_verification` | `change:write`; agent evidence stays `reported` |
| Ask for a human decision | `request_promotion` | `promotion:request`; not an approval |

Hosted discovery filters tools by granted scope. Scope never replaces current membership, approved repositories, workspace ownership or namespace resource policy. Human concern resolution, rejection, attestation and promotion are absent from the agent catalog. An agent review with outcome `approve` never satisfies human approval.

Every coordination read uses established identity, current Namespace authority and recorded repository/cache state. HTTP, MCP and terminal routing perform no login, metadata save, schema creation or Artifacts call for these reads, including after a restart. Explicit sign-in/authorization creates the identity and personal namespace; human canonical setup or setup retry initializes repository state. MCP discovery does not initialize anything. Authentication still verifies Access identity and may refresh its signing certificates.

`inspect_source` is explicit cloud work: choose files (a listing without content, or one path), history, diff or a stored artifact through `sourceView`. Files, history and evidence use native Artifacts APIs without populating Git objects. History is labelled `first-parent` and reports truncation after 30 commits; it is not complete merge ancestry. Diffs may recover bounded retained Git objects. `recover_source` restores a retained exact revision for cache-only ancestry/diffs/pack export. Both consume one shared namespace reservation per request and recheck current authority/policy on retries. Source responses are not saved in command receipts. Binary/oversized files include an unavailable reason; tree/call/response limits fail explicitly. See [source/cache limits](architecture.md#bounded-source-inspection-and-recovery).

`inspect_retention` is explicit `source.read` work: it checks fork identity and the bounded complete ref inventory, then records exact unretained refs and check time. It never deletes a fork or grants cleanup authority. Cleanup checks again before requesting deletion. `get_activity` returns up to 100 retained events in oldest-first order and a continuation `cursor`; the recent snapshot window is not history deletion. Capacity failures preserve records and refuse new work. See [coordination/transfer bounds](architecture.md#bounded-coordination-state-and-retention-recovery).

There is deliberately no tool to launch, pause, resume, message or schedule an agent. There is no acknowledgement protocol, no ref-claim store, and no `clone`/`fetch`/`push` replacement.

## Participation protocol

1. **Start or continue.** Start a workspace at an exact baseline. Through the bridge, work only in the returned directory. To continue an existing workspace in a new session, point the bridge at that workspace's worktree. To continue from another checkout or machine, run `cruce resume --workspace ID` there first (after `detach` on the old machine).
2. **Stay oriented.** At the start and whenever scope changes, inspect active workspaces, overlap and `get_workspace_updates`. The bridge renews presence and reports changes every 30 s while it runs.
3. **Use Git.** Commit and push to the workspace fork with ordinary Git. `publish_revision` retains the exact pushed revision; it cannot upload uncommitted changes.
4. **Propose an exact revision.** Create a proposal from the published revision, record evidence for that exact revision, and request human promotion when ready.
5. **Reconcile when canonical moves.** Fetch canonical, merge with Git, verify, push, publish and propose the reconciled revision for fresh review. Fetching or receiving an update is not reconciliation.
6. **Detach or end deliberately.** `detach_workspace` frees the workspace for another checkout. `end_workspace` completes it without promoting anything. Fork cleanup is a separate, retention-checked step.

These steps are cooperative guidance, not scheduling gates. Cruce cannot make an agent read context, cannot see unconnected participants, and never reconstructs an agent conversation. In repositories with human-enabled observation, push events trigger identity-checked ref inspection with bounded backfill. `get_reconciliation` exposes its health and published-ancestry relationships; it never fetches or writes. `get_repository` includes an `attention` projection: per current change or reconciliation-needing workspace, its owner, exact revision, structured blockers and the caller's eligible actions. For an agent these are at most owner work (`prepare_revision`, `reconcile_with_git`) on its own user's workspaces; approval, attestation and promotion stay with authenticated human maintainers. It is a reading aid, not an assignment or a queue. `get_workspace` additionally exposes the bounded last observed fork-ref inventory. Publication and acceptance remain separate.

## Failures and retries

Mutations require an idempotency key. Retry with the same key and the exact same request after an uncertain outcome; the bridge keeps pending operation state for this. Changed input needs a new operation once the earlier outcome is known. Access is checked again on every retry, so a stored receipt cannot authorize a revoked connection.

An unknown authenticated identity returns 401 with a sign-in instruction; reading never registers it. A registered repository whose setup was interrupted can be inspected without persisting an empty state; its console offers human maintainers an explicit setup retry. Unavailable cached source requires explicit `inspect_source` / `recover_source`, publication or Git transport, never a coordination read that silently provisions or fetches. A `preparing` workspace can be re-attached after a failed first attachment. Attaching a workspace that is attached elsewhere fails until that execution is detached. A lost heartbeat leaves locks and the attachment intact. Cleanup can return `deleting`; the submitted operation resumes through a bounded DO alarm under its original reservation and current authority/policy. `get_retention` exposes its recorded phase, blockers and last inspection without provider calls. A blocked operation needs an authenticated retry with its original key/input; the console offers that command only to its original actor. Changed or expired OAuth approval stops automatic recovery. Expiry never starts deletion. Report these states honestly.

The [implementation audit](architecture.md#architecture-contradictions-and-correctness-gaps) lists remaining hosted provider-identity, publication-recovery and cache-recovery gaps. [F3 evidence](local-verification.md#pure-coordination-read-verification-f3) records local read-purity verification.

## Extending the surface

A new tool must pass the [boundary test](product.md#the-boundary-test) and express a Cruce concept, not a Git, forge or agent-framework primitive. Add it once in the shared catalog, define its contract and pure decision, and implement any I/O in the runtime. Resource actions declare scope and cost and use the namespace gate. Reads stay free of mutation and provisioning. Add behavioral tests for authority, exact revisions, retries and ownership.
