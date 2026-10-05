# MCP and agent participation

[Documentation map](../README.md#documentation-map) · [Git and bridge setup](native-setup.md) · [Principles](principles.md)

MCP exposes Cruce coordination to independently running agents. It is neither Git transport nor an agent runtime. The single executable catalog is [src/shared/tools.ts](../src/shared/tools.ts); its descriptions, scopes, mutation flags, resource classes and input fields drive both the remote server and local bridge. Shared schemas live in [src/shared/platform.ts](../src/shared/platform.ts). Consult those files for exact arguments instead of maintaining a second schema in documentation.

## Connection paths

| Path | What it does | Adapter responsibilities |
| --- | --- | --- |
| Local stdio bridge: `node /absolute/path/to/cruce/runner/cruce.mjs mcp --cwd /absolute/path/to/checkout --client NAME` | Connects to the hosted `/mcp` endpoint using OAuth; creates isolated worktrees and reports local Git state | Agent must work in the returned directory and consume coordination context |
| Direct hosted MCP: `https://YOUR_HOST/mcp` | Exposes repository-scoped coordination through OAuth | Client must provide local isolation, persistent locks, attachment, heartbeat and Git observation itself |
| Git smart HTTP | Normal clone/fetch/pull/push authenticated with a Cruce credential helper | Use Git, not MCP commands, to transfer source |

The bridge supplies namespace/repository/workspace IDs and mutation identities from local connection state. It handles `start_workspace` by creating and attaching a dedicated directory for an agent writer. A direct remote call only registers the workspace; it does not create local files or launch an agent.

`connect --client codex|claude|cursor` currently writes client configuration and a bounded participation-instruction block through [runner/client-config.ts](../runner/client-config.ts). The corresponding files are `.codex/config.toml` and `AGENTS.md`, `.mcp.json` and `CLAUDE.md`, or `.cursor/mcp.json` and `.cursor/rules/cruce.mdc`. Existing surrounding content is preserved. Review these explicit local setup changes before committing them.

The configuration writer reports Git observation and coordination MCP capabilities, with `hooksInstalled: false` and `adaptiveVerified: false`. It does not install decision-delivery or pause/resume hooks. Generated instructions do not prove an agent consumes updates or follows recommendations; the proposed Codex/Claude Code pilot must establish that with actual independent connections.

Gemini CLI, future tools and internal agents are within the product model, but no dedicated configuration writer or end-to-end compatibility claim exists for them here. A compatible adapter must obey the same authority and isolation rules. A tool name is only a label; independent authorization comes from OAuth connections. One authorized agent may participate in many workspaces; each writer workspace owns and reuses its own fork. Reusing a cached connection is not evidence of distinct participant identity.

## Current command families

| Purpose | Commands | Scope / resource boundary |
| --- | --- | --- |
| Discover authorized ownership | `list_namespaces`, `list_repositories`, `get_repository` | `cruce:read`; recorded state only |
| Inspect work and context | `get_context`, `get_workspace`, `get_workspace_updates`, `list_active_workspaces`, `inspect_overlap` | `cruce:read`; instructions at immutable base, current observations labelled separately |
| Inspect source and provenance | `get_git_access`, `get_source`, `get_history`, `get_diff`, `read_artifact`, `get_lineage` | `cruce:read`; source requires available retained objects |
| Participate | `start_workspace`, `heartbeat`, `report_change`, `report_ref`, `end_workspace` | `workspace:write`; control mutations |
| Attach or clean up a hosted fork | `attach_workspace`, `cleanup_workspace` | `workspace:write`; Artifacts resource operations |
| Retain source or evidence | `publish_revision`, `publish_artifact` | `revision:publish` / `artifact:publish`; Artifacts resource operations |
| Propose, review and report checks | `create_proposal`, `review_proposal`, `record_verification` | `change:write`; agent evidence stays reported |
| Request source acceptance | `request_promotion` | `promotion:request`; requests a human decision |

Hosted discovery filters tools by granted scope. Scope does not replace current membership, approved-repository checks, writer ownership or namespace resource policy. Human concern resolution and source promotion are absent from the agent catalog. Deployment and environment orchestration are outside Cruce entirely. A promotion request is not an approval, and an agent review with outcome `approve` cannot satisfy human approval. Publication, the product term change (`Proposal` in contracts), evidence and promotion are distinguished in the [architecture vocabulary](architecture.md#domain-vocabulary-and-ownership).

## Participation protocol

1. Start a workspace from the exact intended commit. Use the bridge's returned directory for all edits and read `get_context` for base-revision instructions/policy.
2. At task start and scope changes, inspect active work, overlap and workspace updates. The MCP bridge maintains heartbeat/reporting while running; standalone CLI work needs `watch` in a separate terminal for continued presence.
3. Make commits and push the workspace branch with ordinary Git. `publish_revision` seals the exact pushed revision; it cannot upload uncommitted local changes.
4. Create a proposal from that source artifact and report verification for the exact revision. Request human promotion when ready.
5. After canonical advances, inspect updates, fetch and integrate with Git, verify again, then push/publish and propose the new revision. Receiving or fetching an update is not integration or acceptance.
6. End participation when finished. Choose local or hosted cleanup explicitly after retention checks; end does not promote source.

These checkpoints are cooperative guidance, not scheduling gates. Cruce cannot guarantee an agent reads updates, monitor unconnected participants or recreate an agent conversation. A compact recorded coordination view is proposed in the [roadmap](../ROADMAP.md), without committing a new command name. A normal push does not currently refresh an independently observed remote-head record; `report_ref` is a claim, and publication verifies a specific pushed revision later. Timely observations and actual two-tool context consumption remain gaps.

`start_workspace` accepts a title and optional context, not structured intent/dependency reports. `report_change` reports observed changes, not a planned scope or decision response. Heartbeat activity does not prove these reports remain accurate. The current catalog has no coordination decision, acknowledgement or agent pause/resume commands; source review outcomes and promotion requests are separate concepts.

## Proposed coordination integrations

Convergence-first means fresh recorded evidence and deliberate incorporation precede execution controls. The [roadmap interaction contract](../ROADMAP.md#proposed-interaction-contract) constrains future reports and responses; it is not an available protocol. If decisions are introduced, a supported adapter must deliver them at demonstrated checkpoints and let agents acknowledge, decline with reasons or report inability to comply. Reading must not record a response; that requires an explicit authorized mutation. Delivery, acknowledgement, reported action and observed enforcement remain distinct.

Begin with cooperative checkpoint reads and explainable canonical/path evidence. Automatic sequencing and targeted pause/resume remain exploratory; any control requires opt-in, demonstrated client support, a precise constrained action, safe pause/release behavior and a human override. Unsupported clients remain advisory. A client label or MCP connection cannot establish that Cruce can interrupt an agent. Scope changes and stale reports require reassessment; reconnecting participants need refreshed context rather than replaying obsolete advice. Missing acknowledgement is unknown compliance, not success.

The current command table remains the available interface. New schemas, tool names, scopes and client hook choices require implementation design and evidence. The roadmap's [open integration questions](../ROADMAP.md#open-questions-and-integration-requirements) track those gaps; do not instruct participants to call proposed tools.

## Failures and retries

Mutations require an idempotency key. Direct clients reuse the same key and exact request after an uncertain outcome; the bridge retains pending operation state for this purpose. Changed input needs a new operation after the prior outcome is known. Access is checked again on retry, so a stored receipt cannot authorize a revoked connection.

Unavailable source requires explicit publication or Git transport, not a read that silently provisions/fetches. A preparing workspace can be resumed after attachment failure. A lost heartbeat leaves locks intact. An asynchronous cleanup can return `deleting`; retry its original operation until the provider confirms deletion. Report these states honestly instead of inventing successful completion.

The [implementation audit](architecture.md#architecture-contradictions-and-correctness-gaps) identifies remaining interruption, provider-identity and promotion-race gaps. Existing idempotency receipts do not prove every remote-success/restart window is recovered. Coordination tools avoid provider fetches, but routing/initialization still persists metadata on some read paths; the strict read-only contract remains normative until that gap is corrected.

## Extending the surface

Add a tool once in the shared catalog, define its contract and pure decision, and implement necessary I/O in the runtime. Every resource action declares scope/cost and uses the namespace gate. Reads must remain free of mutation/provisioning. Add behavioral checks for authority, exact revision, retry and ownership boundaries, then update this guide only when a new concept or family needs explanation. Do not add `cruce clone`, `cruce fetch`, `cruce push` or agent-launch tools.
