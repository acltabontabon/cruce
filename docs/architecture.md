# Architecture

[Documentation map](../README.md#documentation-map) · [Principles](principles.md) · [Verification status](local-verification.md)

This describes the current Namespace → Repository → Workspace design. It does not establish live verification. Cruce maintains shared repository state and exact-revision decisions across independently running agents; their execution remains outside the control plane.

## Domain vocabulary and ownership

```mermaid
flowchart TD
    N[Namespace: access, resources, budgets] --> R[Repository: canonical Git and policy]
    R --> W[Workspace: actor, task, immutable base]
    W -->|Writer only| F[One reusable hosted fork of canonical]
    W --> E[Execution context: local worktree or clone]
    W --> A[Publications and provenance]
```

| Term | Meaning and boundary |
| --- | --- |
| Namespace | Owns repositories, membership, teams, connected Cloudflare credentials, resource policy and atomic shared budgets; personal or shared |
| Repository | Stable code identity and configured default branch; names and URLs are mutable addresses |
| Canonical repository | The authoritative Git repository for a Cruce repository, backed by Cloudflare Artifacts; its accepted source history advances through controlled promotion |
| Cloudflare Artifacts | Provider infrastructure for canonical Git storage, workspace forks, retained source/evidence storage and Git/provider operations; not a Cruce source artifact |
| Actor | Human or agent identity derived from authentication; an agent belongs to an authorized user and connection |
| Workspace | Durable coordination identity for one actor's repository work: task, immutable starting revision, writer fork, publications, provenance and lifecycle state |
| Execution context | Local materialization with checkout/machine identity, ownership and branch; not the durable task or hosted storage owner |
| Writer fork | One mutable Cloudflare Artifacts Git repository forked directly from canonical, owned by one writer workspace and reused across its publications; read-only observers need no fork |
| Source artifact | Cruce domain record of an exact retained source revision, pinned review base, provenance, content hash and storage identity (`Artifact` with `kind: "source"`) |
| Evidence | Revision-linked claims/results, such as reported tests or human attestation; stored evidence content (`Artifact` with `kind: "evidence"`) is separate from source. A `Verification` records an outcome for a proposal and may link an evidence artifact |
| Publication | Retention of an exact pushed workspace revision for review through `publish_revision`, producing a source artifact; `publish_artifact` stores evidence. There is no separate `Publication` contract |
| Change / Proposal | The same exact-revision review unit: a source artifact, base, head and reviews. Product language uses change; the contract and MCP use `Proposal`/`*_proposal`. `WorkspaceChange` is only a reported path change |
| Review | A permitted participant evaluates an exact revision and its evidence; only authenticated human approval satisfies the current approval requirement |
| Promotion | Human-authorized, controller-gated, non-forced canonical Git update; a `Promotion` records the transition. Local integration means reconciling with Git before publication and is not canonical acceptance |

An authorized agent may participate in many workspaces; each workspace belongs to one actor, and each attached writer workspace owns one reusable hosted fork. The vendor/tool does not own the fork. Preparing writers may not yet have a fork; explicit cleanup can later delete it without deleting the workspace. Directory identities and provider repository IDs prevent mutable addresses from becoming proof of ownership. Full contracts are in [src/shared/platform.ts](../src/shared/platform.ts).

Canonical does not mean a local clone, cached Git objects, a workspace fork, retained source storage or an arbitrary external remote. Publication retains source separately without advancing accepted history; promotion advances canonical history.

The [console design guide](design.md) owns visual identity and topology semantics. Console topology is a presentation of authorized snapshots, never an inferred Git DAG or an independent readiness/authority decision. Namespace summaries expose minimal workspace and overlap membership for miniature views without provider reads.

The console **Artifacts** area lists both source and evidence artifacts, with revision, producer/trust, storage/hash, content and lineage inspection. Reviews and verification decisions live in **Work**. Keep Artifacts as the mixed collection label: Sources or Evidence would exclude part of it, while Publications would blur the source-publication operation with stored evidence. This area is not the Cloudflare Artifacts service or a provider resource browser.

### Workspace durability

A workspace is durable coordination identity. Its execution context records machine, checkout/worktree/clone, branch and local ownership; the bridge holds the persistent writer lock for that local materialization.

```text
Process exit or agent disconnect  ≠ workspace deletion or loss of ownership
Worktree removal                 ≠ erasure of published work
Heartbeat expiry                 ≠ loss of checkout ownership or cleanup
Execution context disappearance  ≠ loss of durable provenance
Workspace completion             ≠ source acceptance or cleanup
```

## Components and trust boundaries

```mermaid
flowchart TB
    subgraph Participants[Participant environments]
        H[Human console]
        B[Agent tool and local bridge]
        T[Browser-approved human terminal]
        G[Ordinary Git client]
    end
    subgraph Control[Cruce control plane]
        W[Worker: Access, OAuth, terminal authentication]
        D[Directory DO: users and address lookup]
        N[Namespace DO: membership, grants, reservations]
        R[Repository Control Tower: work, review, source cache]
    end
    subgraph Account[Explicitly connected namespace account]
        A[Cloudflare Artifacts: canonical, forks, retained source]
    end
    H -->|HTTPS and Access| W
    B -->|MCP and OAuth| W
    T -->|Restricted terminal credential| W
    G -->|Git smart HTTP and Cruce credential| W
    W --> D
    W --> N
    W --> R
    R -->|Current authority and resource reservations| N
    R -->|Server-side provider tokens| A
```

The operator's account hosts the control plane. Each namespace explicitly connects the account used for its source resources. The two may happen to be the same account, but configuration for one never authorizes the other.

| Implementation boundary | Responsibility |
| --- | --- |
| [src/core/ownership.ts](../src/core/ownership.ts) | Pure Directory/Namespace decisions: identity, membership, grants and reservations |
| [src/core/platform.ts](../src/core/platform.ts), [capabilities.ts](../src/core/capabilities.ts) | Pure repository decisions, permissions, workspace presence, overlap, review readiness |
| [src/worker](../src/worker) | Authentication, Durable Object persistence, serialization, Git/provider I/O |
| [src/worker/git](../src/worker/git) | Git object cache in SQLite and exact source inspection/transport; not a competing canonical remote |
| [src/shared/tools.ts](../src/shared/tools.ts), [src/shared/platform.ts](../src/shared/platform.ts) | Single MCP catalog and shared contracts |
| [runner](../runner) | OAuth, local observation, checkout locks, worktree isolation and Git credential helper |
| [src/ui](../src/ui) | Console rendering of controller-derived decisions; navigation, retries and protection against late responses |
| [src/intelligence](../src/intelligence) | Babel source structure at pinned revisions; contextual analysis, never authority |
| [test/browser](../test/browser) | Separate fixed-clock console fixture; simulated identity/provider behavior |

Core controllers receive state, time and IDs. Adapters persist their results and perform external work. Directory DO serializes identity/address decisions; Namespace DO serializes shared budgets across repositories; each Repository Control Tower owns its workspaces, changes and artifacts.

## Identity and authorization

Access verifies issuer, subject, audience, signature and expiry. Directory first-login provisioning idempotently creates a user, human actor identity and personal namespace. Authentication admission is separate from namespace membership. Shared invitations are expiring links bound to verified email.

Personal namespaces have one owner. In shared namespaces, Owner and Maintainer have repository Maintain authority. Developer and Viewer access comes from direct/team grants, capped at Write and Read respectively. Repository roles are Read, Write and Maintain.

Agent authority intersects the user's current membership, repository grants, OAuth-approved repositories and capability scopes. It is re-evaluated on requests and retries before saved mutation results are returned. A client label or Git author cannot assert identity. Browser-approved human terminal credentials bind participation to one workspace and cannot exercise console promotion authority.

## Git and workspace lifecycle

The bridge registers a workspace at an exact local commit. Writer attachment checks known retained source, reserves the checkout and provisions a direct canonical fork. Artifacts forks inherit refs at fork time; the API has no exact-commit selector. Cruce pins the workspace base in metadata and a `cruce-base` fork ref, and creates the local checkout at that exact commit. There is no extra baseline repository. See the [Artifacts fork API](https://developers.cloudflare.com/artifacts/api/rest-api/).

Agent writers get Cruce-owned worktrees; adapters may also supply isolated clones. Humans can attach existing checkouts. Local locks use real checkout/worktree identity and persist across process exits; server reservations prevent another workspace claiming the same context. MCP or `watch` renews presence every 30 seconds. After 90 seconds without activity, active presence becomes disconnected, while the writer reservation remains.

Writer state progresses from `preparing` to `active`, then `completed` or `cancelled`. Disconnected is derived from freshness and can recover on heartbeat. A failed attachment remains retryable. Ending participation releases the bridge lock and server participation without merging, deleting source or automatically cleaning up.

The Git gateway serves ordinary smart HTTP at `/mcp/git/<namespace-id>/<repository-id>/<canonical-or-workspace-id>.git`. It supports `info/refs`, `git-upload-pack` and `git-receive-pack`. Canonical is read-only through this path. Fork writes require the owning active writer and, for agents, read, workspace-write and revision-publication scopes. See [setup](native-setup.md) for credentials and transfer limits.

Cloudflare credentials stay server-side: creation/fork tokens are revoked, and Git operations use 60-second scoped tokens revoked after use. The gateway validates destinations, rejects redirects and does not forward client cookies or authorization to Artifacts. Push retries replay the Git protocol against current refs, using request content to identify budget accounting; a cached success never substitutes for a remote ref check.

## Concurrent work and convergence

```mermaid
sequenceDiagram
    participant A as Agent A / workspace A
    participant B as Agent B / workspace B
    participant C as Cruce
    participant H as Human reviewer
    participant G as Canonical Git
    A->>C: Register at S0 and report paths
    B->>C: Register at S0 and report paths
    C-->>A: Shared work and advisory overlap
    C-->>B: Shared work and advisory overlap
    A->>A: Commit and push revision A1 to own fork
    A->>C: Publish A1, propose artifact, record evidence
    H->>C: Review A1 and approve promotion
    C->>C: Require readiness for exact A1
    C->>G: Recheck current base S0, non-forced push A1
    B->>C: Inspect workspace updates
    C-->>B: Accepted source A1 and available comparison
    B->>G: Normal Git fetch
    B->>B: Explicit merge, resolve, verify, commit B2
    B->>B: Push B2 to own fork
    B->>C: Publish B2 with review base A1
    H->>C: Fresh review and promotion decision for B2
    C->>C: Require readiness for exact B2
    C->>G: Recheck current base A1, non-forced push B2
```

These are three different revision references:

- `Workspace.baseRevision` is the immutable starting point, S0 in the example.
- `Workspace.integratedRevision` records the review base of its latest publication; local fetch alone does not advance it.
- `Artifact.baseRevision` pins that artifact's review base, A1 for B2 above. Later publications cannot change it.

A new source publication must descend from the workspace base and its previous publication. Merge upstream explicitly when needed; rewriting already published history by rebase can make later publication fail ancestry checks. Local Git can manipulate unpublished work, but publication must preserve retained ancestry.

`inspect_overlap` compares paths reported by currently present writers, including both sides of reported renames, deleted paths and binary files. Overlap is awareness, not a Git conflict or a reason to block local work. Absence of overlap proves neither absence of concurrent work nor semantic compatibility: edits to `auth-contract.ts` and `auth-client.ts` can be behaviorally dependent without sharing a path. Observation is not a decision; analysis is not authorization.

`get_workspace_updates` compares accepted source against the workspace's publication baseline using available cached Git objects. A reported local ref never advances accepted source. Missing objects produce unavailable comparison, not a provider fetch during a coordination read.

## Publication, review and retention

Publication fetches the named pushed fork ref and verifies it equals the requested commit. It checks ancestry and protected-path policy, pins the review base, then retains the exact source under a unique artifact ref in a separate per-repository Artifacts repository. Workspace forks remain mutable; retained artifact refs and Cruce records are not exposed as agent-writable remotes. Immutability is an application/storage-access invariant, not a claim that ordinary Git refs are intrinsically immutable.

Every artifact identifies namespace, repository, workspace, actor, source revision, SHA-256 content hash, storage and trust. Evidence content lives separately from source. **Publication proves which source was retained, not that it is correct.**

| Knowledge or state | What it establishes |
| --- | --- |
| Reported (`reported`) | A participant supplied a claim; a reported test pass or local ref is not an independently verified test or remote push |
| Human-attested (`human_attested`) | An authenticated authorized human attests an outcome; Cruce has not thereby run the check |
| Independently verified | A named check was independently exercised for a specific revision/environment; current `Verification` trust values are only `reported` and `human_attested`. Cruce does not execute tests |
| Retained | Exact source remains stored and reachable; retention does not imply approval or correctness |
| Published | A publication record identifies retained source for review; it does not imply approval or canonical acceptance |
| Approved | An authenticated human approved the exact revision; readiness and an explicit promotion are still required |
| Accepted / canonical | Source in authoritative canonical history, initially provisioned or advanced by completed promotion; existence of a publication is insufficient |

Publication records currently carry `reported` trust even when source retention succeeds. Source identity/retention checks and correctness claims are different facts. Missing source/provider observations remain unknown or unavailable, never inferred success.

Changes bind an artifact, base and head. Controller readiness requires current base, human approval for the exact revision, reasoned resolution of concerns and policy-required trusted passing evidence without unresolved failures. Promotion rechecks canonical source and makes a non-forced Git push. A moved base requires reconciliation and a new proposal, not rewriting the existing review. Agents can publish, inspect, review, disagree, supply evidence and request promotion, but cannot supply human authority. Automatic promotion would change the authority policy, not merely add an auto-merge convenience; it is outside the current model.

Hosted cleanup requires an ended workspace. The runtime checks every fork ref against retained canonical/artifact history; unretained commits, annotated tags and non-commit refs conservatively block deletion. Deletion intent is persisted and asynchronous provider absence is reconciled on retry. Workspace records, source artifacts and lineage survive. Local cleanup separately requires Cruce ownership, clean files and a published or retained-base head.

## Resources and the canonical Git boundary

Namespace reservations serialize operation budgets across repositories. Mutation IDs and exact input fingerprints prevent accidental identity reuse. Unknown provider outcomes retain their reservation and named resource identity until reconciliation. Coordination reads do not provision or mutate; explicit Git reads contact the provider and have provider costs even though Cruce's reservation model is not a meter of every request.

Cruce’s responsibility ends when isolated concurrent work is safely reviewed and reconciled into the canonical Git repository. CI, build/release orchestration, deployment, environment management, rollback and runtime operation belong to external systems. No deployment environments, preview/rollback refs, build observers, runtime checks or workflow bindings belong to repository state. Artifacts and evidence remain inputs to source review. External handoff/provenance is only a roadmap candidate.

See [Cloudflare setup](cloudflare-setup.md) for provider configuration and limits. Events, native file/history retrieval, Git-note mirroring and ArtifactFS are optional future evaluations in the [roadmap](../ROADMAP.md); no current event subscription or agent notification-delivery capability is implied.
