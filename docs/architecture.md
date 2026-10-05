# Architecture

The initial product focus is one developer coordinating several agents on one repository. Connected tools share repository participation, upstream observations and exact-revision decisions through Cruce; agents still execute in their existing environments. This architecture supports the [product thesis](product-thesis.md), whose coordination benefit remains subject to the [usage pilot](PLAN.md). Shared namespaces and multiple repositories remain part of the ownership model.

Cruce organizes Git-native collaboration as Namespace → Repository → Workspace. The Worker authenticates requests and dispatches them to three ownership boundaries:

```text
Access browser / OAuth agent / browser-authorized human bridge
                       ↓
Directory DO — stable users, personal/shared namespaces, handle lookup
                       ↓
Namespace DO — membership, teams, repository grants, sealed account, budget reservations
                       ↓
Repository Control Tower — workspaces, observed refs, changes, artifacts, deployments, Git objects
                       ↓
Local Git bridge                         Namespace Cloudflare account
persistent checkout locks                Artifacts REST → Workers Builds
isolated agent worktrees                 short-lived server-side Git tokens
```

## Identity and authorization

Directory writes run synchronously in one Durable Object. Concurrent first logins for the same verified issuer/subject resolve to one user and personal namespace. Handles are unique mutable labels; storage uses IDs. Namespace membership is independent of Access admission. Shared membership and explicit user/team repository grants are rechecked on requests and retries. Owners and maintainers administer all repositories; developers receive at most Write and viewers at most Read.

Agent actors are derived from the authenticated user and OAuth connection; labels supplied during client registration are display metadata. OAuth consent selects repositories and scopes. Effective access is the intersection with current membership and repository grants. Human terminal pairing is browser-approved, short-lived and bound to one workspace; it cannot authorize production or forge a human actor through MCP.

## Git and workspaces

Every repository has canonical Artifacts storage. Workspace forks are direct forks of canonical; no extra baseline repository is created. The provider cannot fork at an exact commit, so each workspace pins its immutable base in metadata and a dedicated fork ref. ExecutionContext contains local materialization only. Agent/task/fork identity survives client disconnection.

Workspaces pin a starting revision and track head, optional ref, actor, execution context, observed changes and lifecycle. Writer checkout identity combines realpath and Git worktree identity. The bridge holds a persistent exclusive local lock and the controller reserves the context. Presence expires after 90 seconds; lock ownership does not. Agent writers get dedicated branches/worktrees. Read-only observers share safely. End/cancel releases participation but retains commits and records; local cleanup requires Cruce ownership, a clean checkout and no unpublished head.

Workspace forks persist across source publications. Upstream awareness uses Cruce's accepted canonical source, with those trust levels kept distinct. Reads compare uploaded source and reported touched paths without provider calls. Normal Git fetch imports canonical source; Git merge or rebase performs reconciliation. The authenticated smart-HTTP gateway restricts writes to the caller’s workspace fork. Cloudflare tokens remain server-side. Publication validates the integrated upstream against Git ancestry and records it separately from the immutable starting revision. Every source artifact pins its review base; later Workspace integrations cannot rewrite existing proposals. The next proposal can therefore be reviewed and promoted against current source after an explicit local merge and fresh verification.

Overlap compares reported touched paths across active workspaces, including both sides of renames and binary/deleted paths. It carries evidence trust and observation time. Babel structural indexing enriches pinned source context. Neither overlap nor a stale base blocks local editing. Protected-path policy, authorization, resource budget and revision review still govern Cruce operations.

## Changes and artifacts

A proposed change names an immutable source artifact and exact base/head. Reviews, disagreement resolution and verification name that revision. Agent evidence remains reported; authenticated human attestation is labelled separately from runtime verification. Readiness is computed in the controller. Hosted promotion checks current source and performs a non-forced push after human approval. External integration records are bridge observations with timestamps, not verified remote pushes.

Artifacts identify namespace, repository, workspace, actor, exact revision, SHA-256 content hash, immutable storage and trust. Source artifacts retain Git objects. Evidence artifacts retain content separately. No workspace cleanup deletes retained source. Lineage traverses workspaces, artifacts, changes, reviews and deployments in both directions.

## Resources and deployment

The Namespace DO owns one sealed account and serializes reservations across repositories. Operation IDs and exact input fingerprints make retries idempotent. Reservations remain held on uncertain provider outcomes; retries inspect existing state and reuse named resources before continuing. No fallback to the control-plane account is available. Control operations do not spend resources.

Deployments require a source artifact and derive its revision, retaining requester, environment, build, runtime observation and predecessor. The deployment repository is separate from accepted source; only its environment ref is forced for an explicit rollback. Production requires human authority and revision-bound review/evidence. Rollback names a prior deployed artifact. Durable Workflows observe builds, time out boundedly and stop superseded deployments; smoke checks remain runtime evidence. Provider observations have timestamps and absent data stays unavailable.

Pure decisions live in `src/core` with injected clock and IDs. Worker adapters perform persistence and infrastructure. The console renders controller permissions/readiness and protects navigation from late responses. The bridge never launches participants. The fixed-clock fixture server is separate from the deployed Worker. Disposable old state is not converted.

The gateway supports ordinary HTTPS Git at `/mcp/git/<namespace>/<repository>/<canonical-or-workspace>.git`, with stable IDs and OAuth or a browser-authorized human terminal credential. Canonical writes require reviewed human promotion. See [native setup](native-setup.md) for authentication, the 32 MiB transfer limit and deployment prerequisites.
