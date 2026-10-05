# Cloudflare capabilities for the product thesis

Reviewed 2026-10-05. The product goal is one developer keeping several agents' work coherent on one repository, with less manual relaying, stale work and review effort. Cloudflare capabilities should support those outcomes while agents continue running in their chosen tools.

This document maps available platform features to that goal. It distinguishes the current Cruce implementation from planned experiments. It is not a claim that the planned features are deployed or live-verified.

## Use Artifacts as the hosted source foundation

Artifacts provides isolated Git repositories, repository-scoped tokens and durable storage. Forks begin with a source repository's history and then evolve independently. This supports retaining an exact starting point and published work across local participants. Cloudflare's platform durability reduces infrastructure Cruce would otherwise need to operate. See [how Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/).

Cruce already uses the REST adapter with each namespace's explicitly connected account. Keep that account boundary: an Artifacts binding tied to Cruce's operator account must not become a fallback for a namespace without resource credentials. Native APIs are useful when they preserve namespace ownership and improve the product outcome; changing adapters solely to use a binding provides no demonstrated benefit.

| Platform capability | Product outcome | Cruce status and next use |
| --- | --- | --- |
| Direct canonical forks with pinned bases | Independent work with a consistent starting point and reusable hosted storage | Implemented: one hosted fork per writer Workspace, reused across publications. Validate the full two-agent reconciliation flow live. |
| Standard Git transport | Share exact commits among participants without changing their Git workflow | Implemented locally: authenticated standard Git transport, exact-revision publication and non-forced human-approved promotion. Measure reconciliation and handoff effort in the pilot. |
| Repository-scoped tokens | Give authorized operations access to the appropriate hosted repository | Implemented: sealed namespace credentials and 60-second server-side tokens revoked after use. Retain this boundary for new platform calls. |
| File, tree, commit and history APIs | Retrieve focused context for review or handoff without exporting all source | Candidate optimization: compare native retrieval with Cruce's existing uploaded-object cache. No live reads in ordinary cached read commands. |
| Push and lifecycle events | Make published changes visible sooner with less polling | Planned experiment: reconcile hosted observations and expose relevant updates to connected participants. Events do not launch agents or approve changes. |
| Git notes | Make selected provenance portable with source history | Optional later experiment: mirror a small authorized summary while keeping authoritative identity and decisions in Cruce. |
| ArtifactFS | Reduce checkout startup time when repository hydration is a measured bottleneck | Deferred: current local worktrees are the execution model. Any adoption must preserve credential handling and platform size limits. |

Cloudflare documents [forks and repository APIs](https://developers.cloudflare.com/artifacts/api/workers-binding/), [standard Git transport](https://developers.cloudflare.com/artifacts/api/git-protocol/) and [token and metadata patterns](https://developers.cloudflare.com/artifacts/concepts/best-practices/). Native file/history reads and event consumption remain planned Cruce uses, rather than implemented product behavior.

## First priority — prove retained work and reconciliation

Exercise two independent writer Workspaces from the same exact source revision. Publish both into their own hosted storage. Accept one through human review; have the other inspect source changes, fetch, merge, verify and publish a reconciled artifact. Its fork and original starting revision must persist, while the new artifact pins the current review base.

Repeat after disconnecting a participant and from an independent checkout. Published work and its review context should be recoverable without the original agent process. Local uncommitted work is not uploaded automatically and cannot be recovered from Artifacts until explicitly committed and published.

Validate uncertain fork/push outcomes and revoked access against the configured test account, retaining operation identity and namespace reservations. Compare the developer's effort with an ordinary Git workflow. Existing local tests establish controller and transport behavior; they do not establish live provider behavior or product value.

## Next experiment — events for useful update awareness

Artifacts offers repository-level push events with ref and before/after revisions, as well as repository lifecycle events. These can feed a Worker. See [event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/).

Start with relevant hosted source and Workspace publications. Reconcile events against Cruce-owned storage and exact Git objects, then expose revision changes and advisory affected paths through the console and MCP at participant checkpoints. Measure event-to-visible-update latency, polling saved, stale work avoided and new interruptions before expanding the event surface.

The handler must tolerate duplicate, delayed and reordered delivery; confirm actual delivery behavior in the integration trial. A provider event is an observation, not a Workspace identity, review approval or authorization decision. Commit author names cannot identify the authorized actor. Unknown storage and unexpected canonical writes need reconciliation; they must not silently advance accepted source. Recheck grants when a participant reads an update or attempts a follow-up operation.

Subscription setup and provider reconciliation need declared scope/cost and the authoritative namespace gate before infrastructure calls. Keep pure reads on recorded state. Reconciliation must not silently deploy, recreate deleted resources, overwrite local files or restore the retired event handler. A stopped agent remains stopped; pending context is available when it reconnects.

## Focused context and portable provenance

If full source transfer or repeated context reconstruction is costly in the pilot, evaluate the provider's commit/tree/file/history methods behind the connected-account adapter. Pin retrieval to commit IDs, cache by repository identity and revision, and preserve unavailable states when source has not been published. Meter provider operations under namespace policy rather than turning every console read into an external request.

Git notes can attach metadata without changing the source commit, but their refs require explicit transport and can change independently. A future note should reference a Cruce record and exact revision; it must not contain credentials, unapproved conversation contents or claims of human authority. Cruce remains authoritative for access, reviews, evidence trust and acceptance. Notes are not an immutable review record by themselves.

ArtifactFS uses a blobless clone and FUSE to hydrate contents as files are read. Cloudflare recommends ordinary clones for smaller repositories. Consider it only after measured startup delays justify the additional dependency and a design that keeps repository tokens server-side. It does not remove Artifacts storage limits or authorize a new agent runtime inside Cruce. See [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/).

## Cost and platform fit

As of 2026-10-05, Artifacts requires Workers Paid, with operation/storage billing scheduled to start October 14, 2026. Published allowances are 10,000 operations and 1 GB of storage per month, then $0.15 per 1,000 operations and $0.50 per GB-month. Other Cloudflare services have their own costs. Recheck [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) before estimating a pilot or changing product disclosure.

The documented maximum is 1 GB per repository and 32 MB per file/blob. Namespace control-plane and per-repository Git rate limits also apply. Validate repository and transfer size early; large monorepositories may need to remain local. ArtifactFS speeds hydration without increasing hosted capacity. See [limits](https://developers.cloudflare.com/artifacts/platform/limits/).

Reuse Workspace storage and immutable baselines rather than creating a repository on every report or heartbeat. Track operations and retained storage separately; Cruce's current reservation budget is an operation-policy limit, not a dollar estimator. Retain source referenced by artifacts or deployments. Any later cleanup must establish Cruce ownership and check references and unpublished work.

## Supporting services and scope

Directory, Namespace and Repository Durable Objects retain identity, atomic budgets and coordination state. They complement hosted Git storage. Workers Builds and durable deployment observation can connect an accepted source artifact to an explicitly requested preview or deployment, but successful end-to-end build/deployment behavior still needs its configured test environment.

The initial proof does not require a build on every push, Cloudflare-hosted agents, coding chat, provider integrations or a general workflow engine. Use `cf` and `cloudflare.config.ts` for platform implementation. Consult current [Artifacts](https://developers.cloudflare.com/artifacts/llms.txt) and [cf](https://developers.cloudflare.com/cf/llms.txt) documentation before changes.
