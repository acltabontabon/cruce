# Principles and guardrails

[Documentation map](../README.md#documentation-map) · [Architecture](architecture.md) · [Contributing](../CONTRIBUTING.md)

These are normative constraints for changes to Cruce. The architecture describes their implementation; tests provide evidence. If implementation and these rules disagree, record the gap and resolve it explicitly. Do not silently redefine the product from whichever behavior happens to exist.

## 1. Use Git for Git

> If Git already has a primitive for something, Cruce should use Git instead of inventing another one.

Use commits, refs, worktrees, clone, fetch, merge and push directly. Publication adds immutable review provenance to an exact pushed revision; it does not replace commit or push. Attaching a checkout must preserve its existing remotes and must not upload history implicitly. Preserve original workspace bases and already published commits when integrating upstream work.

## 2. Coordinate across tools; leave execution with participants

Worktrees isolate work. Cruce coordinates workers. Any adapter must use the same repository, workspace and authority model regardless of client brand. No client label confers identity or a special role. Cruce never launches agents, edits on their behalf through a hosted IDE, owns their conversation or schedules their local work.

## 3. Make ownership durable and addresses mutable

Namespace → Repository → Workspace is the domain hierarchy. Stable IDs determine ownership and storage; handles, names, paths and remote URLs are addresses. A workspace owns the actor/task association, immutable starting revision and fork. An execution context records local materialization only. Disconnecting a process must not erase durable work or provenance.

Every repository has canonical Artifacts storage. Each writer workspace gets one direct canonical fork, reused across publications. Local worktrees and hosted forks solve different isolation problems; neither substitutes for the other.

## 4. Derive authority on every request

Verify authentication before resolving current membership, repository grants, approved repositories and capability scopes. Recheck on retries before returning saved results. Git authors, branch names, tool labels, source files and structural analysis are not authority.

Human decisions require authenticated human authority. An agent may review, disagree or request promotion; it cannot impersonate a human approval. Human terminal pairing is restricted participation, not console authority. Namespace admission and repository grants remain separate from Access sign-in. Credentials stay sealed server-side; Git uses short-lived server-side provider tokens, never credentials embedded in source, URLs, logs or frontend responses.

## 5. Protect writers without scheduling their work

Enforce persistent local writer locks and server checkout reservations. Agent writers use dedicated worktrees or isolated clones; humans may attach existing checkouts. A stale heartbeat changes presence, never ownership of a locked checkout. Local edits need no plan, overlap clearance or scheduling approval.

Overlap is an advisory observation based initially on paths, including rename endpoints and binary files. Absence of overlap proves neither absence of concurrent work nor semantic compatibility. Structural analysis enriches context and cannot authorize a write or acceptance.

## 6. Bind decisions to exact source and honest evidence

Retain exact source revisions, review bases, hashes, storage identity and producing actors. Review and verification concern a revision, not a moving branch label. Source changes require fresh evidence and review for the new revision. A stale proposal cannot be made current by rewriting its base metadata. Record reasons for disagreement and human resolution.

Keep reported evidence, authenticated human attestation and independent verification distinct. Publication proves which source was retained, not that it is correct. A local ref report is not an independently verified remote push. Missing source or provider observations stay unavailable, rather than being inferred as success.

## 7. End coordination at canonical Git

Hosted source promotion requires human approval, controller readiness and a non-forced Git update. Fetching updates does not integrate them; ending a workspace does not accept it. Participants use Git to reconcile before proposing a new exact artifact.

Cruce’s responsibility ends when isolated concurrent work is safely reviewed and reconciled into the canonical Git repository. CI, build/release orchestration, deployment, environment management, rollback and runtime operation belong to external systems. Cruce records revision-linked evidence supplied by participants; it does not execute their builds or operate their applications. Cruce’s own hosting and release tooling remains necessary infrastructure.

## 8. Account for resources where they are owned

The namespace owns its connected Cloudflare account, policy and shared operation budgets. Resource operations declare scope/cost and pass the authoritative namespace gate before infrastructure calls. Repository policy can only narrow namespace policy. Never fall back to the operator account.

Retries reuse operation identity, exact input and reservation. An uncertain outcome remains charged until reconciled. Coordination reads do not provision, fetch provider source or mutate state; explicit Git transport is a separate path. Operation budgets are policy limits, not complete dollar estimates or a meter of every provider request.

## 9. Retain work; make cleanup explicit

Workspace completion preserves commits, artifacts and provenance. Local cleanup removes only Cruce-owned contexts after checking dirty and unpublished work. Hosted fork cleanup requires an ended workspace and proof that every remote ref is retained; uncertain retention blocks deletion. Retain source referenced by artifacts. Heartbeat expiry is never a cleanup trigger.

## 10. Keep decisions testable and documentation accountable

Keep core controllers pure and deterministic with injected time and IDs. Put I/O in adapters. The console renders controller-derived permissions and readiness instead of independently deciding authority. Use one MCP catalog, [src/shared/tools.ts](../src/shared/tools.ts), for bridge and hosted tools.

Architecture-changing work updates the relevant invariant, design explanation and behavioral checks together. Label proposed, locally verified and live-verified behavior separately. Preserve dated evidence without treating retired designs as current instructions. The working name Cruce should remain easy to change.

## Review prompts

Before accepting a design, ask:

- Does it coordinate independent workers, or take ownership of an agent's execution?
- Is there an existing Git primitive, and are exact source and existing remotes preserved?
- Which stable identity owns the state, authority and cost? What happens after revocation or a lost response?
- What is reported, retained, attested or independently observed? Can a moving ref change the meaning of a prior decision?
- What survives disconnect, completion and cleanup? Which tests demonstrate those boundaries?

Do not reintroduce project/mission aliases, Flight/radar routes, migration adapters, shared-branch execution workspaces, mandatory scheduling, external provider integrations or a general workflow engine through incremental features. Proposals to change these boundaries need an explicit architectural decision, not terminology drift.
