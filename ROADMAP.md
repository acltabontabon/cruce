# Roadmap

[Documentation map](README.md#documentation-map) · [Product thesis](docs/product-thesis.md) · [Architecture audit](docs/architecture.md#implementation-audit)

Cruce's direction is Git-native coordination and convergence across independently running coding agents. Prioritize useful in-flight awareness and a trustworthy exact-revision convergence loop. Automatic sequencing and supported pause/resume are exploratory. These are evidence-backed candidates, not shipped behavior, dates or work instructions.

**P0** is required to prove the thesis; **P1** materially strengthens coordination/convergence; **P2** addresses scale, ecosystem and operations; **Exploratory** requires validation before commitment. Current behavior belongs in architecture, test results in verification, and implementation history in Git. Stable item IDs connect this roadmap to the audit.

## P0 — prove the complete loop

### P0.1 Promotion against the exact approved base — done

**Status:** Implemented and locally verified on 2026-10-06. The installed Git library's pre-push hook binds the advertised old revision and exact candidate; non-forced receive-pack checks the same old/new pair at ref update. A durable promotion journal records operation identity, exact inputs, reservation and prepared/attempted/confirmed phases. Same-identity retries reconcile the exact independently observed remote candidate without another push. Provenance and the receipt persist before namespace settlement; interrupted settlement retries separately under current human authority.

**Acceptance evidence:** Native Git tests inject ancestor/candidate movement before advertisement and before ref update; every raced update fails closed. Lost successful responses and persistence/settlement interruptions recover after runtime restart with one operation, event and reservation. Tests also cover concurrent promotions, revoked retries and pre-update authority, missing source, provider identity replacement, changed inputs and unrelated remote history. Console recovery preserves the original operation across reloads. See [verification and limitations](docs/local-verification.md#exact-base-promotion-verification) and [current architecture](docs/architecture.md#publication-review-and-retention).

**Verification boundary:** Local native Git and in-process authority, not a new hosted Artifacts or deployed Worker result. P0.3 retains deployed/provider validation. Unobserved or changed remote outcomes stay charged; they cannot be relabeled as accepted source. No custom transport, forced update, Workflows or new infrastructure was added.

### P0.2 Durable provider ownership and identity

**Problem:** Publication/promotion do not consistently compare recorded provider IDs; disconnect removes the account record used to prevent rebinding retained resources.

**Target:** Preserve account/namespace/repository identity independently of credentials and validate it for every provider operation. **Invariants:** Credential removal cannot transfer storage ownership; name/description/remote matching cannot substitute for stable identity; retained artifact repositories remain protected.

**Cloudflare:** Artifacts repository IDs and scoped credentials; Namespace DO owns the persistent resource binding. **Acceptance:** Disconnect then connect another account, recreate canonical/fork/retention names with different IDs, and retry an interrupted operation. Each mismatch is rejected before source access or mutation; reconnecting credentials for the original binding works without losing provenance or reservation state.

### P0.3 Deployed and heterogeneous participation proof — verification gap

**Problem:** The [deployed gateway check](docs/local-verification.md#deployed-gateway-verification) now proves one owner-approved OAuth test writer through native Git, publication/replay, authenticated console reconciliation, reduced-scope retry rejection, whole-grant revocation and pre-expiry rejection of revoked provider Git tokens. Test client labels do not establish real coding-tool participation; a second deployed writer, membership/repository-grant changes and in-flight revocation remain unverified.

**Target:** Complete the two-writer journey through actual Codex/Claude Code connections and verify the remaining authority-change cases. **Invariants:** Browser human review, separate OAuth actors, unchanged fixture history, declared resource budget, no operator-account fallback. **Cloudflare:** Existing Access, OAuth, Worker, DOs and Artifacts; no new service required.

**Acceptance:** One developer creates/connects a Cruce repository, establishes canonical, attaches two direct-fork writers at exact bases, commits/pushes independently, inspects awareness, reconciles, records exact evidence, approves/promotes and retrieves retained provenance. Include response loss, membership/scope revocation and independently checked canonical/retained refs. Demonstrate agents consume relevant context without manual relays. Preserve the existing 20-reservation test ceiling unless explicitly revised before resource use. The staged verifier's client labels do not count as real tool participation.

### P0.4 Observed Git activity and explainable convergence

**Problem:** A successful Git push does not update an independently observed workspace head. Canonical awareness reflects Cruce's recorded promotions; external movement is not continuously reconciled. Reports and heartbeats share a freshness clock.

**Target:** Observe pushed refs and canonical movement, derive exact commit/path evidence, and expose a compact read-only coordination view through the existing tool boundary. Record report freshness separately from presence; keep local uncommitted reports alongside remote evidence. **Invariants:** Stable provider identity, immutable starting revisions, events as signals, no inferred approval, no provider fetch or acknowledgement during ordinary context reads.

**Cloudflare:** Artifacts event subscriptions → Queues → authenticated ingestion → existing Repository DO, with explicit bounded provider reconciliation. First validate namespace-account queue permissions, routing and cost; the operator account cannot silently stand in for a connected account.

**Acceptance:** Two independently authorized clients see ordinary pushes without `publish_revision` being required for awareness. Duplicate/reordered messages, unknown schema, branch deletion/rewind, truncated commit lists and missed delivery never regress or falsely approve state. A bounded backfill restores observation after a gap. Every warning names its workspace, exact evidence, freshness and limitations; independent overlapping edits can continue. UI and clients expose degraded observation honestly. No event starts an agent or promotes code.

## P1 — strengthen coordination and recovery

### P1.1 Bounded source inspection and recoverable caches

**Problem:** A persistent SQLite Git cache supports inspection, ancestry and transport, but has no integrated eviction or explicit retained-source rehydration path. Small reads can walk substantial trees; source hashing exports complete reachable packs.

**Target:** Use Artifacts file/object/history APIs where equivalent; retain bounded derived Git data only where ancestry, diff, pack transfer or source retention needs it. **Invariants:** Artifacts remains source authority; cache loss cannot redefine review, bypass retention or turn a coordination read into provider I/O. First-parent history is not complete ancestry.

**Cloudflare:** Artifacts REST for connected accounts, binding where account scope is proven; DO metadata and explicitly bounded cache. **Acceptance:** Cold-cache recovery of canonical and retained source/evidence after fork deletion; comparisons across merge parents; unavailable source reported honestly; measured memory, storage and request bounds on representative repositories; no returned credentials. Preserve hash meaning and exact identities when changing inspection implementation.

### P1.2 Fresh intent, evidence and explicit follow-through

**Problem:** Titles/context and path overlap cannot express dependencies, duplicate outcomes or whether a continuing writer incorporated and verified accepted source.

**Target:** Add bounded, versioned intent/dependency reports and explicit responses where the pilot shows value. Explain canonical/path evidence first, enriching it with pinned structural context for missed interactions. Track outstanding incorporation and verification against exact revisions. **Invariants:** Heartbeats do not renew report content; reading, receiving, acknowledging and fetching are distinct from acting; structural/semantic signals never authorize changes or prove compatibility.

**Cloudflare:** Existing Repository DO and MCP catalog; asynchronous analysis only when its cost warrants a queue. **Acceptance:** Scope drift supersedes old reports, disconnect preserves ownership, dependency cycles and disagreement reach a human, and stale approvals/evidence cannot carry forward. Measure false alarms and missed cross-file interactions. Receiving source alone cannot satisfy follow-through; fresh resulting revision, evidence and review do.

### P1.3 Pure reads and timely delivery

**Problem:** UI snapshots poll every 15 seconds, and nominal read routes still write Directory/Repository initialization metadata. Polling does not ensure an agent consumes context.

**Target:** Remove avoidable persistence from established read paths, then use repository-version notifications if measured latency or fan-out justifies them. **Invariants:** Authorization on read/reconnect, read-only coordination, no implicit acknowledgements, no claim that delivery proves attention. **Cloudflare:** Existing DO snapshots; hibernating WebSockets for UI only when justified, demonstrated MCP/client mechanisms for agents.

**Acceptance:** Repeated established coordination reads cause no domain/storage mutation or provider calls. Reconnect obtains an authorized current snapshot; missed/duplicate notifications and late responses cannot replace newer state. Compare update latency/cost with polling and verify actual client consumption.

### P1.4 Diagnosable operations and safe errors

**Problem:** Workers observability is enabled, but there is no consistent domain correlation, operation-phase tracing or unified redaction; MCP can return raw exception messages.

**Target:** Add structured operational evidence and allowlisted public errors. **Invariants:** No credentials, OAuth payloads or source content in logs/errors; no monitoring service becomes correctness authority. **Cloudflare:** Workers Logs/Traces and existing durable operation IDs. **Acceptance:** Trace namespace/repository/workspace, proposal/promotion, revision and reservation through success, retries and uncertainty; injected provider errors are redacted across HTTP and MCP; failures remain actionable without exposing sensitive payloads.

## P2 — adoption, scale and operational maturity

### P2.1 Explicit external-provider onboarding and synchronization

**Problem:** Creation starts a new canonical history; attaching an unrelated existing checkout is not import. Requiring users to relocate canonical storage can obstruct adoption.

**Target:** If pilot evidence justifies it, add GitHub-first explicit import, external fetch/divergence inspection, reconciliation and exact approved-revision publication/PR links. **Invariants:** Artifacts canonical remains authoritative inside Cruce; no silent bidirectional sync, duplicate source authority or unapproved source transport. Stable provider repository identity and installation authorization are required.

**Cloudflare:** Documented Artifacts public-HTTPS import; private GitHub repositories need a separately validated GitHub App/normal-Git transport path. Workflows are a candidate for long-running import/sync recovery. **Acceptance:** Public/private behavior is demonstrated separately; revoke installation access, move external refs and interrupt import/sync; retries preserve one resource identity and external divergence never becomes implicit approval. Architecture records authority and credential handling before integration becomes a core dependency.

### P2.2 Bounded state, transfers and explicit retention operations

**Problem:** Directory scans, repository-wide JSON records, growing receipts/activity/reservations, cache growth and the 32 MiB gateway limit constrain scale. Pending deletion currently needs caller retries.

**Target:** Measure and bound hot state/transfer costs; make retention blockers and uncertain operations inspectable; recover explicitly authorized operations after interruption. **Invariants:** Retain referenced source/provenance; uncertainty blocks deletion; disconnect/heartbeat expiry never triggers cleanup. **Cloudflare:** DO SQLite/query projections and alarms for already-authorized reconciliation; streaming Git where safe; D1 only for a measured query need with a rebuildable index and one authority.

**Acceptance:** Representative load and restart tests establish documented limits; retained source survives cleanup; pending deletion resumes without new reservation identity; no leaked token on a failed/oversized transfer. Query projections recover without becoming authoritative. No scheduled deletion is enabled merely to lower cost.

## Exploratory — validate before commitment

| Capability / problem | Target and invariants | Cloudflare relevance | Evidence required to proceed |
| --- | --- | --- | --- |
| Automatic sequencing and opt-in pause/resume | Reduce demonstrated interference while unrelated work continues; explicit scope, reason, release condition and override; unsupported clients stay advisory | Existing coordination DO; no agent runtime | Per-client/version proof of a safe action boundary, observed enforcement and release, recovery after disconnect, and net benefit beyond advice |
| Durable multi-step execution | Recover long-running import/sync or operation phases without caller babysitting; preserve authority, idempotency and charged uncertainty | Workflows versus an existing DO operation record/alarm | A concrete selected flow, failure injection and cost comparison showing less recovery complexity; no blanket wrapping of reads, heartbeats or promotion |
| Business analytics | Measure saved intervention, stale work and reconciliation outcomes; aggregate without source/secrets; metrics cannot approve work | Analytics Engine optional | Pilot data volume/query requirements that exceed simple exported evidence and justify another service |
| ArtifactFS or portable Git-note provenance | Reduce measured checkout cost or improve external provenance discovery; mutable notes never replace review authority | ArtifactFS / Git notes | A demonstrated retrieval or handoff problem, secure credentials and a measured gain; neither is an initial dependency |

## Proposed coordination milestones

The proof order is **P0.1/P0.2 safety → P0.3 deployed participation → P0.4 observed activity and convergence → measured two-tool value**, with local P0.4 prototyping possible while deployment verification is pending. P1 work addresses demonstrated deficiencies. Completed forks, worktree isolation and revision-bound review are existing foundations, not new milestones. GitHub integration competes with the proof loop rather than blocking it automatically.

### Proposed interaction contract

Future reports and responses identify the affected workspace, scope/version, exact source evidence and freshness. Advice explains uncertainty and an available next action; a pause additionally needs a release condition. Reads remain read-only. Duplicate or delayed delivery cannot reactivate obsolete advice. Explicit acknowledgement, reported incorporation and observed verification are separate records. Escalate competing designs and unresolved dependencies without inventing tasks or claiming authority over arbitrary local execution.

## Foundation validation still needed

P0.3 owns the remaining deployed/client verification. Existing [real-provider two-writer convergence](docs/local-verification.md#hosted-two-writer-convergence) proves a narrower foundation and must not be erased or described as entirely untested. P0.1 now has targeted local race/restart evidence; its new implementation still needs hosted validation. P0.2 failure windows remain future corrections.

## How we choose what to build

Use matched trials: one developer, one repository, Codex and Claude Code. Keep tasks, tools/models, instructions and checks comparable; repeat trials and vary order. Record Cruce/client versions and enabled capabilities. Predeclare the sample, numeric improvement targets and acceptable cost, delay and quality limits.

Include independent same-file edits, overlapping outcomes, cross-file assumptions, canonical advancement, a clean but behaviorally failing merge, scope drift and disconnect/recovery. Count routine interventions/manual relays separately from deliberate review/design decisions. Measure coordination time, duplication, integration rework, reporting/setup burden, false alarms, misses, completion delay, cloud/agent cost and quality. Registration or acknowledgement counts alone cannot prove value.

Proceed only when repeated trials show net benefit. If value concentrates in upstream awareness or recovery, narrow the product there. If friction dominates, simplify before adding automation. If the simpler system still misses the predeclared targets, revisit the thesis. No metric justifies weakening human review or source safeguards.

## Open questions and integration requirements

Account-scoped event subscription delivery into a separately hosted control plane, binding access to dynamically connected accounts, Artifacts event identity/replay guarantees and private-import transport remain feasibility questions. Resolve them using current primary documentation and bounded verification before choosing a production mechanism. Record an unknown rather than inferring a guarantee from an example.

Cruce remains outside agent execution, CI/CD, deployment, application hosting and runtime management. Cloudflare Workflows, if selected for Cruce's own durable operations, do not authorize a repository workflow engine. No new component is justified without the concrete capability lost if it disappeared.
