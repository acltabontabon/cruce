# Principles and guardrails

[Documentation map](../README.md#documentation-map) · [Architecture](architecture.md) · [Contributing](../CONTRIBUTING.md)

These are normative constraints for changes to Cruce. The architecture describes their implementation; tests provide evidence. If implementation and these rules disagree, record the gap and resolve it explicitly. Do not silently redefine the product from whichever behavior happens to exist.

## 1. Use Git for Git

> If Git already has a primitive for something, Cruce should use Git instead of inventing another one.

Use commits, refs, worktrees, clone, fetch, merge and push directly. Publication adds immutable review provenance to an exact pushed revision; it does not replace commit or push. Attaching a checkout must preserve its existing remotes and must not upload history implicitly. Preserve original workspace bases and already published commits when integrating upstream work.

## 2. Coordinate across tools; leave execution with participants

Worktrees isolate work. Cruce coordinates workers through a Git-native awareness and convergence loop. Prioritize timely evidence, deliberate reconciliation and exact-revision human review while useful independent work continues. Any adapter must use the same repository, workspace and authority model regardless of client brand. No client label confers identity or a special role. Cruce never launches agents, edits on their behalf through a hosted IDE, owns their conversation or acts as a general task scheduler.

Automatic sequencing and opt-in scoped controls through supported client integrations are exploratory [roadmap](../ROADMAP.md) candidates, not prerequisites for convergence or current execution control. Their scope is coordinating interacting work, not choosing models, assigning arbitrary tasks or owning runtimes. Escalate ambiguous requirements, competing designs and unresolved disagreement to the developer; routine coordination automation cannot supply human approval.

## 3. Make ownership durable and addresses mutable

Namespace → Repository → Workspace is the domain hierarchy. Stable IDs determine ownership and storage; handles, names, paths and remote URLs are addresses. A workspace owns the actor/task association, immutable starting revision and fork. An execution context records local materialization only. Disconnecting a process must not erase durable work or provenance.

Provider resources must match their recorded account, namespace and repository identities before use. Removing a credential must not erase the resource-account binding or authorize migration. The [audit](architecture.md#architecture-contradictions-and-correctness-gaps) records incomplete enforcement today.

Every repository has authoritative canonical Git storage backed by Cloudflare Artifacts. Each writer workspace owns one direct fork of canonical, reused across publications. An authorized agent may participate in many workspaces; the vendor never owns their forks. Local worktrees and hosted forks solve different isolation problems; neither substitutes for the other.

## 4. Derive authority on every request

Verify authentication before resolving current membership, repository grants, approved repositories and capability scopes. Recheck on retries before returning saved results. Git authors, branch names, tool labels, source files and structural analysis are not authority.

Human decisions require authenticated human authority. An agent may review, disagree or request promotion; it cannot impersonate a human approval. Human terminal pairing is restricted participation, not console authority. Namespace admission and repository grants remain separate from Access sign-in. Credentials stay sealed server-side; Git uses short-lived server-side provider tokens, never credentials embedded in source, URLs, logs or frontend responses.

## 5. Protect writers without mandatory scheduling

Enforce persistent local writer locks and server checkout reservations. Agent writers use dedicated worktrees or isolated clones; humans may attach existing checkouts. A stale heartbeat changes presence, never ownership of a locked checkout. Local edits need no plan, overlap clearance or scheduling approval.

Overlap is awareness, not a Git conflict. The current implementation is an advisory observation based on paths, including rename endpoints and binary files; it does not require participants to stop or block a merge. Shared files can contain independent edits; different files can encode incompatible assumptions or duplicate outcomes. Absence of overlap proves neither absence of concurrent work nor semantic compatibility. Structural analysis enriches context and cannot authorize a write or acceptance.

Future coordination decisions must distinguish notice, recommendation and enforced control. A targeted pause requires meaningful interference or a dependency, an explicit scope and a release condition; a shared path alone is insufficient. Enforce only through an opted-in integration with demonstrated support, leaving unsupported clients advisory. Delivery and acknowledgement are not proof of compliance. Scope changes require reassessment, stale reports reduce confidence, and heartbeat presence cannot prove intent freshness. Disconnects preserve ownership; reconnecting participants must refresh context before relying on old decisions. These are constraints on roadmap work, not claims that the protocol exists today.

## 6. Bind decisions to exact source and honest evidence

Retain exact source revisions, review bases, hashes, storage identity and producing actors. Review and verification concern a revision, not a moving branch label. Source changes require fresh evidence and review for the new revision. A stale proposal cannot be made current by rewriting its base metadata. Record reasons for disagreement and human resolution.

Keep reported evidence, authenticated human attestation and independent verification distinct. Publication proves which source was retained, not that it is correct. Separate reported local heads, observed remote refs, published revisions and human-accepted canonical provenance. Events supply observations, never approval or proof of a completed promotion. Missing source or provider observations stay unavailable, rather than being inferred as success.

## 7. End coordination at canonical Git

Hosted source promotion requires authenticated human approval, controller readiness and an explicit non-forced Git update against the approved expected base. That expectation must hold at the remote update, not only an earlier observation. The promotion adapter validates the advertised old/new pair before Git performs its atomic ref comparison; non-force alone is insufficient. Interrupted operations reconcile exact independently observed remote source under current authority and never reinterpret the approved base. Approval alone does not integrate source. Any future automated promotion would be an authority-policy change requiring an explicit architectural decision. Receiving, acknowledging or fetching updates does not integrate or verify them; ending a workspace does not accept it. Continuing writers explicitly incorporate accepted source with Git, verify the resulting revision and obtain fresh review before promoting their next result. Proposed follow-through tracking cannot substitute for that evidence.

Cruce’s responsibility ends when isolated concurrent work is safely reviewed and reconciled into the canonical Git repository. CI, build/release orchestration, deployment, environment management, rollback and runtime operation belong to external systems. Cruce records revision-linked evidence supplied by participants; it does not execute their builds or operate their applications. Cruce’s own hosting and release tooling remains necessary infrastructure.

## 8. Account for resources where they are owned

The namespace owns its connected Cloudflare account, policy and shared operation budgets. Resource operations declare scope/cost and pass the authoritative namespace gate before infrastructure calls. Repository policy can only narrow namespace policy. Never fall back to the operator account.

Retries reuse operation identity, exact input and reservation. An uncertain outcome remains charged until reconciled. Coordination reads must not provision, fetch provider source or mutate state; existing initialization writes are an audit finding. Explicit Git transport is a separate path. Operation budgets are policy limits, not complete dollar estimates or a meter of every provider request.

## 9. Retain work; make cleanup explicit

Workspace completion preserves commits, artifacts and provenance. Local cleanup removes only Cruce-owned contexts after checking dirty and unpublished work. Hosted fork cleanup requires an ended workspace and proof that every remote ref is retained; uncertain retention blocks deletion. Retain source referenced by artifacts. Heartbeat expiry is never a cleanup trigger.

## 10. Keep decisions testable and documentation accountable

Keep core controllers pure and deterministic with injected time and IDs. Put I/O in adapters. The console renders controller-derived permissions and readiness instead of independently deciding authority. Use one MCP catalog, [src/shared/tools.ts](../src/shared/tools.ts), for bridge and hosted tools.

Architecture-changing work updates the relevant invariant, design explanation and behavioral checks together. Distinguish proposed, implemented, locally verified and live-verified behavior; implementation alone is not verification. Preserve dated evidence without treating retired designs as current instructions. The working name Cruce should remain easy to change.

## Review prompts

> Does this capability help independent participants coordinate and safely converge work around canonical Git, or make Cruce own another layer of software delivery? The latter needs an explicit architectural decision before entering the core.

Before accepting a design, ask:

- Does it coordinate independent workers, or take ownership of an agent's execution?
- Does it reduce measured routine intervention or rework enough to justify reporting, false alarms, waiting and setup costs? Can independent work continue?
- Is a claimed control advisory, acknowledged, reported as acted on or observed as enforced? Which client integration demonstrates the claim?
- Is there an existing Git primitive, and are exact source and existing remotes preserved?
- Which stable identity owns the state, authority and cost? What happens after revocation or a lost response?
- What is reported, retained, attested or independently observed? Can a moving ref change the meaning of a prior decision?
- What survives disconnect, completion and cleanup? Which tests demonstrate those boundaries?

Do not reintroduce project/mission aliases, Flight/radar routes, migration adapters, shared-branch execution workspaces, mandatory scheduling or a general workflow engine through incremental features. Cloudflare Artifacts is the intentional canonical-storage foundation. Other source-hosting/forge, CI/CD, deployment, runtime, infrastructure-orchestration or workflow integrations must not become core dependencies without an explicit architectural decision. Proposals to change these boundaries require that decision, not terminology drift.
