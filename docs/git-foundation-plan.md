# Artifacts Git foundation — 2026-10-05

## Assessment and decisions before implementation

At inspection, the hierarchy was Workspace → Repository → Session. The accepted replacement is Namespace → Repository → Workspace. Directory and Namespace Durable Objects already separate verified identity, ownership, current membership, repository grants and atomic resource reservations. RepositoryRuntime owns workspaces, exact-revision proposals, artifacts and deployments. GitWorkspace uses isomorphic-git over a SQLite object cache. The bridge creates dedicated worktrees with persistent writer locks. The console already has Code, Work, Artifacts and Deployments, path overlap, review and provenance. Existing uncommitted changes add upstream reconciliation and must be preserved.

The inconsistency is transport and durable execution: canonical hosting is optional, hosted attachment creates an extra baseline repository before forking, the fork is stored on local ExecutionContext, and checkout/refresh require Cruce pack commands. No ordinary Git gateway or hosted cleanup exists. Completion is correctly separate from promotion.

1. Rename the ownership Workspace to Namespace and Session to Workspace. The durable unit is Repository → Workspace → actor, task and Artifacts fork. Remove optional local-only repository hosting: every repository has canonical Artifacts storage. A local checkout is an attachment, not a competing backend. No aliases or migration adapters.
2. Delete baseline repositories from new attachment logic. Fork the canonical Artifacts repository directly. Its fork API has no revision selector; preserve the immutable base in workspace metadata and a pinned fork ref, and materialize the local worktree at that exact commit. Do not assert that every inherited fork ref equals the starting revision.
3. Move hosted fork identity/lifecycle from ExecutionContext.storageName to Workspace.fork. Local materialization remains separate and can evolve beyond worktrees without redefining the hosted resource.
4. Retain exact-revision Changes (Proposal internally), human review, verification, stale-base checks, non-forced promotion and deployment provenance. Do not add a competing integration object or lifecycle. Workspace completion does not integrate source.
5. Replace hosted checkout/refresh transport with ordinary Git. Remove the checkout CLI and pack-fetch MCP tools. Keep publish_revision because it seals a revision into an immutable review artifact; hosted callers name a pushed fork ref and exact commit, Git performs all source transport. Source inspection commands support coordination and console review.

## Domain, lifecycle and schema

Namespace owns repositories, membership and cloud budgets. Repository.storageName identifies canonical hosted storage. RepositoryState records canonical provider metadata after successful provisioning. Workspace owns immutable baseRevision, actor, task title, presence, changes and its hosted fork. ExecutionContext owns only local checkout identity. Workspace keeps preparing/active/completed/cancelled, with disconnected derived from heartbeat freshness. Fork lifecycle is ready/deleting/deleted, separate from presence; failed provisioning leaves a preparing workspace and a retryable resource reservation. Repository creation reserves deterministic identity, provisions canonical, then exposes Git access; failed provisioning is visible and retryable with the original operation key.

SQLite stores remain typed JSON records; change these records directly with no migration adapters. Git objects in SQLite serve review and promotion, not a second authoritative remote. Provider refs remain in Artifacts. Published source goes to an immutable artifact repository, separate from mutable workspace forks, so normal force pushes cannot destroy retained review/deployment source.

## Artifacts and Git design

Use the existing namespace-account REST adapter and cloudflare.config.ts. No operator-account binding fallback. Available now: create, metadata, smart HTTP Git, repository forks, scoped read/write tokens (minimum TTL 60 seconds), token revocation and asynchronous delete. Fork creation may return retriable conflicts. Store actual remote URLs returned by Artifacts. Validate destination origin before forwarding credentials.

A thin authenticated smart-HTTP gateway under /mcp/git/<namespace-id>/<repository-id>/<canonical-or-workspace>.git forwards only info/refs, upload-pack and receive-pack. Every request rechecks OAuth identity, approved repositories, current membership and scopes. Canonical is read-only through this gateway; only explicit human-reviewed promotion writes it. Workspace write access requires the owning connection, active write workspace and namespace resource approval. Push request bytes determine retry identity. Cloudflare tokens stay on the server, expire after 60 seconds and are revoked after response consumption. Never forward browser cookies or client authorization to Artifacts. This is Git protocol transport, not a new source-control language.

A standard Git credential helper uses existing Cruce OAuth credentials. Authentication setup is optional tooling; clone/fetch/pull/push stay normal Git. Dedicated agent worktrees get workspace-specific remote names and push defaults without rewriting the developer's origin or upstream. Shared Git configuration must not direct another worktree to this workspace's fork. The configured Access application currently bypasses only exact /mcp; deployment needs an explicit narrow /mcp/git/* machine-transport exception, with OAuth still enforced. Do not imply an undeployed URL is live.

## API, UI and retention

The MCP catalog remains the single coordination surface. Add read-only Git access metadata and explicit fork cleanup; remove export_revision/fetch_workspace_updates as Git substitutes. publish_revision seals pushed exact source into retained artifact storage, deriving changed paths and commits from Git. UI exposes a normal clone command, active work with commits and path overlap, fork status, and controller-derived cleanup readiness. Keep familiar navigation and existing keyboard/deep-link handling.

Cleanup is explicit, never heartbeat-driven. Only ended workspaces qualify. Check all fork branch/tag tips against retained canonical/artifact history before deletion; refuse unretained commits. Persist deletion intent before the provider call and reconcile asynchronous deletion on retry. Keep identity, base, source artifacts, proposals and activity after deletion. Local cleanup independently refuses dirty or unpublished work. No automatic retention scheduler.

## Security and verification

Test deterministic controller decisions; canonical write denial; cross-workspace, revoked-connection and scope denial; allowed smart HTTP routes and header stripping; resource gates and uncertain retry charging; real direct canonical fork calls; immutable artifact storage; ended-workspace cleanup and unretained refs; normal native Git clone/fetch/push against a protocol fixture; local remote isolation; console clone/fork state and existing browser navigation. Run typecheck, lint, unit tests, browser tests, scenario verification and offline cf build.

Live verification uses only explicit CRUCE_TEST_ACCOUNT_ID/CRUCE_TEST_TOKEN. Check create, native Git clone/push/fetch, fork isolation, short-token revocation and deletion there if configured. Missing credentials or Access transport configuration are recorded as unverified, never simulated as live success. Deployment and Workers Builds verification remain distinct.

## Implementation sequence

1. Fork/provider model and direct canonical attachment; immutable source retention.
2. Authenticated native Git gateway and credential helper.
3. Hosted publication from pushed refs, bridge remotes, remove replacement Git commands.
4. Explicit fork cleanup and controller-derived readiness.
5. Repository UI, documentation and targeted integration/security tests.
6. Full local checks and authorized live provider checks when credentials exist.

## Principles

> If Git already has a primitive for something, Cruce should use Git instead of inventing another one.

> Humans and agents use Git for Git. Agents use Cruce for coordination.

> One Cruce workspace represents one isolated unit of concurrent agent work backed by an isolated repository/fork.

Namespace owns access and budgets; Workspace owns durable concurrent work. Agent identity is the authorized Actor, and the task is its bounded title/context, without a separate task-management engine.

## Platform references inspected

- [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
- [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/)
- [Limits](https://developers.cloudflare.com/artifacts/platform/limits/): 1 GB/repository, 32 MB/blob; gateway transport is bounded separately.
- [cf configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
