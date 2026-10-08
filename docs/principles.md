# Principles and guardrails

[Documentation map](../README.md#documentation-map) · [Product](product.md) · [Domain model](domain-model.md) · [Architecture](architecture.md)

These are normative constraints for changes to Cruce. The [product document](product.md) states the boundary. The [domain model](domain-model.md) defines the concepts. The architecture describes the implementation, and tests provide evidence. If implementation and these rules disagree, record the gap and resolve it explicitly. Do not silently redefine the product from whichever behavior happens to exist.

> **Cruce coordinates durable concurrent Git work; other systems execute the work.**

## 1. Pass the boundary test

Every capability must become materially more valuable because Cruce has durable, remotely observable, independently addressable Git workspaces and canonical revision history. Ask: *if local Git worktrees plus an agent orchestrator would deliver essentially the same thing, why is this in Cruce?* If no answer involves durable workspace identity, cross-machine, cross-developer, cross-vendor or long-running coordination, baselines, provenance, concurrency visibility, reconciliation, exact-revision review, approval, promotion or auditability, the capability belongs elsewhere.

Do not add features to capture the single-developer, single-agent case at the cost of the thesis.

## 2. Use Git for Git

> If Git already has a primitive for something, Cruce uses Git instead of inventing another one.

Clone, fetch, pull, push, commit, refs, branches, merge, diff, log and revision identity keep their Git meaning. Cruce adds no replacement command language, no `cruce clone`/`fetch`/`push`, and no pseudo-ref store of claims. Publication adds retention and review to an exact pushed revision; it does not transport source. Attaching a checkout preserves existing remotes and never uploads history implicitly. Published ancestry stays reachable.

## 3. Coordinate work; never own execution

Cruce does not launch, schedule, pause, resume, message or host agents, and it does not store their prompts or conversations. It is not an IDE, CI/CD system, deployment platform, cloud development environment or general workflow engine. Orchestrators, relays and agent tools are consumers of Cruce, not things to replace. The local bridge creates worktrees, configures remotes and reports local Git state. It never starts an agent process.

The domain model is agent-neutral. Client labels (Claude Code, Codex, Cursor, a script) are provenance data. They never confer identity, special roles or architectural authority. Vendor-specific setup is a convenience outside the domain.

## 4. Make work durable and execution replaceable

Namespace → Repository → Workspace is the hierarchy. Stable IDs determine ownership and storage; handles, names, paths and remote URLs are addresses. A workspace is owned by a user, not by an agent connection, session, process, path or machine. Its baseline is immutable and its fork is reused for its whole life.

An execution attachment is local materialization: at most one at a time, explicitly detachable, and replaceable from another machine or tool of the same owner. Disconnects, process exits and session ends never erase work, ownership or provenance. Persistent local writer locks and server checkout reservations protect checkouts. Elapsed time never releases them.

## 5. Be honest about what coordination knows

Overlap is advisory awareness. It is not a Git conflict, a semantic verdict, a stop signal or scheduling clearance. The absence of overlap proves neither the absence of concurrent work nor compatibility. Label every fact by its trust: reported, observed, retained, human-attested or accepted. Show unavailable data as unavailable rather than inferring success. Presence is not intent freshness. A clean merge is not proof of correct behavior.

Prefer boring, trustworthy primitives (revisions, baselines, refs, forks, commits, paths, diffs, provenance, approval state) over premature intelligence. Do not add conflict prediction, semantic analysis, dependency graphs, AI merge decisions or automatic sequencing until the primitives are solid and a measured need exists. When added, analysis enriches context and never grants authority.

## 6. Bind every decision to an exact revision

Review, evidence, approval and promotion each name one exact revision. A source change requires a new published revision, fresh evidence and fresh review. A stale proposal cannot be made current by rewriting its base. Keep reported heads, observed fork refs, published revisions and accepted canonical revisions distinct. Events and observations are signals. They never approve source or prove promotion.

## 7. Keep humans in authority over canonical

Agents may inspect, propose, explain, prepare, reconcile, review, disagree, supply reported evidence and request promotion. Canonical promotion requires authenticated human approval of the exact revision, controller readiness and an explicit non-forced Git update validated against the approved base at the remote ref update. Paired human terminals participate in workspaces; they cannot approve or promote. Any automated promotion would be a deliberate change to the authority policy, recorded as an architectural decision, never an incidental convenience.

Continuing writers incorporate accepted source explicitly with Git, verify the result and obtain fresh review. Receiving, acknowledging or fetching an update proves nothing.

## 8. End at canonical Git

Cruce's responsibility ends when concurrent work is reviewed and reconciled into canonical Git. Builds, test infrastructure, releases, deployments, environments, rollout, rollback and runtime operations belong to external systems. Cruce may expose revision and provenance data that downstream systems consume, and it may record evidence they report. It never runs them. Cruce's own hosting and release tooling is infrastructure, not a repository capability.

## 9. Derive authority on every request

Verify authentication, then resolve current membership, repository grants, the connection's repository approval and capability scopes on every request and retry before returning saved results. Git authors, branch names, client labels, source files and analysis are not authority. Credentials stay sealed server-side. Git uses 60-second scoped provider tokens that are revoked after use, never tokens in source, remotes, configuration, logs or frontend responses.

## 10. Account for resources where they are owned

The installation configures its Cloudflare Artifacts binding once; the namespace owns resource policy and its recorded storage identity. Resource operations declare scope and cost and pass the namespace gate before infrastructure calls. Repository policy may only narrow namespace policy. The deployment binding is explicit storage authority, never a fallback to missing customer credentials. A changed storage account or physical namespace is rejected after first resource use. Retries reuse operation identity, exact input and reservation. Uncertain outcomes remain reserved until reconciled. Coordination reads must not provision, call the source provider or mutate state, including schema creation and initialization after a cold start. Initialization is an explicit sign-in or setup step; unavailable state never silently repairs itself during a read.

## 11. Retain work; make cleanup explicit

Completion, detachment and disconnection preserve commits, published revisions and provenance. Local cleanup removes only Cruce-owned, clean contexts whose head is published or retained. Fork cleanup requires an ended workspace and proof that every remote ref is retained, and uncertainty blocks deletion. Presence expiry is never a cleanup trigger. A durable alarm may recover a submitted cleanup operation, never infer a new one. Recheck its current authority, narrowed policy and provider identity; preserve the operation and reservation through interrupted confirmation/settlement. Capacity limits must reject new work without pruning receipts, retained source or provenance. The sole repository-wide exception is an authenticated console namespace Owner’s explicit permanent deletion, confirmed by the exact repository name after retirement blockers are resolved ([ADR 0010](decisions/0010-repository-archive-and-permanent-deletion.md)). Archive is reversible and preserves history; permanent deletion is journalled, namespace-gated, identity-checked and recoverable, retaining only a deletion tombstone/receipt and the namespace resource ledger.

The local Git cache is disposable derived data. Eviction never deletes remote retained source or coordination records. Inspect/recover retained source through explicit, identity-checked, namespace-gated resource operations; keep coordination reads pure. First-parent history is a display traversal, never complete ancestry or proof of retention. [ADR 0004](decisions/0004-bounded-source-inspection-and-cache.md) owns this distinction.

## 12. Keep decisions testable and documentation accountable

Keep core controllers pure and deterministic with injected time and IDs; put I/O in adapters. The console renders controller-derived permissions and readiness. [src/shared/tools.ts](../src/shared/tools.ts) is the single MCP catalog. Architecture-changing work updates the owning document, the relevant [decision record](decisions/README.md) and the behavioral tests together. Distinguish proposed, implemented, locally verified and live-verified behavior. Cruce is early: remove contradicting concepts rather than adding compatibility layers. The working name should remain easy to change.

## Review prompts

Before accepting a design, ask:

- Does it pass the boundary test, or does it make Cruce own execution, scheduling, messaging, editing, CI/CD or hosting?
- Is there an existing Git primitive? Are exact revisions and existing remotes preserved?
- Does it couple durable work to a session, process, path, machine or vendor?
- Which stable identity owns the state, the authority and the cost? What happens after revocation, detach or a lost response?
- Is each fact labelled as reported, observed, retained, attested or accepted? Can a moving ref change the meaning of a prior decision?
- Is any analysis presented as more certain than it is, or used as authority?
- What survives disconnect, completion and cleanup, and which tests demonstrate it?

Do not reintroduce project/mission aliases, Flight/radar routes, migration adapters, shared-branch execution workspaces, read-only "observer" workspaces, unverified ref-claim stores, agent pause/resume or sequencing controls, mandatory scheduling or a general workflow engine through incremental features. Cloudflare Artifacts is the intentional canonical-storage foundation. Other source-hosting, CI/CD, deployment, runtime, infrastructure-orchestration or workflow integrations require an explicit architectural decision before becoming core dependencies.
