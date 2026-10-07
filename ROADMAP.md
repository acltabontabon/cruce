# Roadmap

[Documentation map](README.md#documentation-map) · [Product](docs/product.md) · [Domain model](docs/domain-model.md) · [Architecture audit](docs/architecture.md#implementation-audit)

Cruce is the durable Git coordination plane for parallel agentic development. This roadmap orders work by that thesis: trustworthy foundations and exact-revision reconciliation first, then coordination signals, then broader collaboration and ecosystem reach. Intelligence comes last.

These are candidates, not commitments, dates or work instructions. Current behavior is described in the [architecture](docs/architecture.md), evidence in [verification](docs/local-verification.md), and history in Git. **Now** is needed for a credible end-to-end foundation, **Next** strengthens the coordination product, and **Later** waits for evidence from the earlier stages. Every item must pass the [boundary test](docs/product.md#the-boundary-test).

## Foundation

Canonical lifecycle, the namespace/repository/workspace model, fork lifecycle, exact baselines, credentials and durable state.

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
| F1 | Promotion against the exact approved base | Now | **Done**, locally verified ([evidence](docs/local-verification.md#exact-base-promotion-verification)); hosted validation in D2 |
| F2 | Durable provider ownership and identity | Now | **Done**, locally verified ([evidence](docs/local-verification.md#durable-provider-identity-verification-f2)); hosted validation in D2 |
| F3 | Pure coordination reads | Now | **Done**, locally verified ([evidence](docs/local-verification.md#pure-coordination-read-verification-f3)); hosted acceptance remains unverified |
| F4 | Bounded source inspection and recoverable cache | Next | **Done**, locally verified ([evidence](docs/local-verification.md#bounded-source-inspection-and-cache-recovery-f4)); hosted acceptance remains unverified |
| F5 | Diagnosable operations and safe errors | Next | **Done**, locally verified ([evidence](docs/local-verification.md#diagnosable-operations-and-safe-errors-f5)); hosted log acceptance remains unverified |
| F6 | Bounded state, transfers and explicit retention operations | Later | **Done**, locally verified ([evidence](docs/local-verification.md#bounded-state-and-authorized-retention-recovery-f6)); hosted alarm and memory acceptance remain unverified |

**F2 — Durable provider ownership and identity.** *Done locally:* deployment storage pins its account and physical namespace; the Repository DO journals canonical, fork, source-retention and evidence-retention provider IDs before token cleanup or Git access. Resource operations validate recorded IDs and addresses, including fork parents, publication checkpoints and promotion recovery. Recreated or missing recorded repositories fail closed; names and descriptions cannot establish an unrecorded identity. Restoring the original installation binding and repository identities reuses provenance, operations and reservations. Fault tests cover recreation after interruption, unknown creation responses and restoration. Hosted binding acceptance remains in D2; publication receipt/settlement recovery is R3.

**F3 — Pure coordination reads.** *Done locally:* HTTP, MCP and terminal coordination routes resolve established identities without login writes. Explicit sign-in/authorization initializes identities and personal namespaces; canonical setup or setup retry initializes repository state. Cold Durable Object and SQLite/Git-cache reads create no schema or metadata and make no Artifacts call. Current repository metadata and permissions are projected from Namespace authority without saving them. Interrupted registration remains inspectable with an authorized setup retry; missing source stays unavailable rather than triggering repair. SQL-backed route tests exercise every catalog read, the actual MCP handler, restarts, missing state and revoked access. Hosted acceptance remains unverified; cache recovery is F4.

**F4 — Bounded source inspection and recoverable cache.** *Done locally:* explicit namespace-gated `inspect_source` uses Artifacts commit/tree/file/history APIs for bounded listings, selected files, evidence and labelled first-parent history. `recover_source` restores exact retained Git source after cache loss without requiring a workspace fork. SQLite writes and retained cache generations have byte/entry limits; refs, indexes and packs are evicted together while metadata and remote retention survive. Clean staging, exact provider/ref checks and complete all-parent object/checksum validation prevent partial caches or first-parent logs from proving ancestry. Attachment, publication, cleanup and promotion handle missing cached source within their existing resource operations; interrupted promotion recovery never repeats an attempted push. Cache-only coordination reads remain pure. [ADR 0004](docs/decisions/0004-bounded-source-inspection-and-cache.md) records limits and tradeoffs. Hosted binding acceptance and peak-memory measurement remain unverified; publication receipt/settlement parity is locally covered by R3; hosted acceptance remains separate.

**F5 — Diagnosable operations and safe errors.** *Done locally:* HTTP and MCP use one explicit status/message allowlist, including serialized Durable Object errors. Validation names only known schema fields; unexpected errors, unknown keys and raw provider/validation text stay private. MCP validates inside the safe dispatcher while preserving catalog schemas and scope filtering. Structured diagnostics carry typed SHA-256 correlation of namespace, repository, workspace, proposal, promotion, revision, operation and reservation, plus fixed phases, outcomes and latency. Evidence-publication and promotion fault tests preserve correlation through uncertainty, restart, settlement and completed replay; independent asynchronous contexts stay isolated. Provider paths, account IDs, raw error names/messages, credentials, OAuth payloads and source are excluded from application logs. Hosted Workers log/trace acceptance remains unverified; publication recovery ordering is locally covered by R3; hosted acceptance remains separate.

**F6 — Bounded state and retention operations.** *Done locally:* indexed Directory identity/address lookup and bounded per-user discovery candidates replace global scans. Receipts, full activity and namespace reservations live in indexed records with bounded pages; current state and total coordination storage have enforced byte/count limits with recovery headroom. A repeatable local measurement retains 10,000 reports/receipts and 10,002 events with about 27 KiB of hot state. Explicit retention inspection records exact unretained refs and incomplete inventories. Fork cleanup journals authorization, deletion and confirmation, then uses bounded DO alarms to recover the same operation/reservation after interruption, with current membership, scopes, policy and provider identity checks. Confirmation survives lost settlement without repeating deletion. Expiry never creates deletion authority; no source, receipts or provenance are automatically pruned. [ADR 0005](docs/decisions/0005-bounded-state-and-authorized-cleanup-recovery.md) defines the supported envelope. The 32 MiB gateway ceiling remains explicit and locally measured; hosted alarm delivery, revocation propagation and Worker peak memory require acceptance. Publication recovery is locally covered by R3; hosted acceptance remains separate.

## Developer workflow

Workspace creation, Git-native onboarding, CLI, MCP, existing repositories, worktree ergonomics and revision publication.

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
| D1 | Continue a workspace across sessions, tools and machines | Now | **Done** locally ([ADR 0002](docs/decisions/0002-workspace-ownership-and-execution-attachment.md)); hosted check in D2 |
| D2 | Deployed multi-tool, multi-session participation proof | Now | **Journey verified** 2026-10-06 with Claude Code and Codex ([evidence](docs/local-verification.md#deployed-multi-tool-participation-d2)); fork cleanup, response loss and a second physical machine remain |
| D3 | Installable `cruce` CLI and a `status` view | Next | Open |
| D4 | Existing-repository onboarding | Next | Open; depends on E1 for history import |

**D2 — Deployed participation proof.** The core journey passed on 2026-10-06: Claude Code and Codex in separate workspaces, detach and continuation in another checkout by another tool, stale detection, reconciliation and two human promotions, all judged by a read-only auditor. *Remaining:* fork cleanup with retained-source retrieval, response loss, M1 revocation cases and a physically separate machine. Earlier deployed evidence covers one owner-approved OAuth test writer through native Git, publication, console reconciliation, scope reduction and revocation. *Target:* through the deployed Worker, two actual tools (for example Codex and Claude Code) work in separate workspaces. One workspace is detached and continued from a second checkout or machine. Canonical moves while the other works. The stale proposal is detected, reconciled, reviewed by a human and promoted, and provenance is retrieved after fork cleanup. Include response loss, membership and grant revocation, and independently checked canonical and retained refs. Client labels alone do not count as tool participation.

**D3 — CLI ergonomics.** Replace `node /path/to/runner/cruce.mjs` with an installable `cruce` command. Add a read-only `cruce status` that shows workspace, baseline, attachment, last pushed and published revision, and canonical divergence, using only recorded state and local Git.

**D4 — Existing-repository onboarding.** A developer's `~/projects/app` with `origin → GitHub` should gain a Cruce workspace remote and worktrees without changing `origin`, and without the developer having to "move development into Cruce." Attaching today requires a checkout that contains the canonical baseline. History import from a forge is E1.

## Coordination intelligence

Canonical divergence, concurrent workspace awareness, path overlap, staleness and reconciliation readiness, kept boring and honest.

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
| C1 | Observed pushed revisions and canonical movement | Next | Implemented; verification below |
| C2 | Staleness and reconciliation view | Next | Implemented; verification below |
| C3 | Report freshness separate from presence | Next | Done locally |
| C4 | Relationship hints beyond paths | Later | Evidence-gated |

**C1 — Observed pushed revisions.** Implemented: explicit human-maintainer opt-in, Artifacts push subscriptions → Queues → private idempotent Repository DO ingestion, identity-checked current-ref inspection, and bounded 15-minute reconciliation. Reported heads, observed refs, retained publications and accepted canonical remain distinct. Rewinds/deleted refs remain visible without rewriting accepted history; duplicates, reordering and truncated event payloads cannot assign heads. Namespace policy, current authority and charged reservations govern retries. Degraded observations and recurring cost are visible. No event starts an agent or promotes code. See [ADR 0007](docs/decisions/0007-observed-refs-and-reconciliation.md) and [verification](docs/local-verification.md#coordination-observation-and-reconciliation-c1c3).

**C2 — Staleness and reconciliation view.** Implemented: the Workspaces view and `get_reconciliation` expose published-ancestry relations, accepted-revision incorporation and every open proposal's controller-derived blockers. Before publication the comparison is explicitly baseline-only; incorporation remains unverified. Complete all-parent cached Git traversal proves ancestry; missing objects and traversal limits stay unknown. Reads neither fetch nor mutate. Observed canonical movement never becomes accepted provenance. Verification is linked above.

**C3 — Report freshness.** Explicit server report time remains separate from presence. Shared freshness is fresh below 90 seconds, stale at or above 90 seconds, and unknown without a timestamp. Workspace, reconciliation and overlap views label the distinction. Hosted acceptance is recorded separately in verification.

**C4 — Relationship hints.** Remains evidence-gated. After C1–C3 are operational, require **two independently reviewed, reproducible real interactions missed by path overlap**, identifying exact revisions, disjoint paths and consequences. Measure observation delay, unknown comparisons, coordination effort, false alarms and misses. Synthetic examples alone cannot unlock the gate. Those cases determine the smallest symbol, module or dependency hint in a subsequent implementation plan; no analyzer ships in this stage. Hints never grant authority or claim compatibility.

## Review and reconciliation

Immutable proposal revisions, comparison against baseline and canonical, reconciliation, human approval, promotion and provenance.

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
| R1 | Proposal comparison against baseline and current canonical | Next | Open |
| R2 | Reconciliation provenance | Next | Open |
| R3 | Publication recovery parity with promotion | Next | Done locally |

**R1 — Comparisons.** For a proposal, show the diff against its pinned base, the diff against current canonical when it differs, and which accepted revisions landed in between.

**R2 — Reconciliation provenance.** When a workspace publishes a revision that merges accepted canonical source, record which accepted revisions it incorporated (from Git ancestry). Lineage then answers "what did this reconciliation include?"

**R3 — Publication recovery.** Implemented locally: exact retention journals, artifact/activity/receipt before settlement, exact-ref recovery and no regression of newer workspace state. Hosted binding acceptance remains separate.

## Multi-user collaboration

Namespace permissions, workspace ownership, reviewer roles, team visibility and shared coordination.

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
| M1 | Authority changes during operations | Now (with D2) | Open |
| M2 | Workspace hand-off between developers | Later | Open |
| M3 | Review requests and reviewer roles | Later | Evidence-gated |
| M4 | Namespace-wide view of concurrent work | Later | Evidence-gated |

**M1 — Authority changes.** Verify and define behavior for membership, grant and scope revocation between steps and during an in-flight provider operation.

**M2 — Hand-off.** Transfer workspace ownership to another developer with an explicit, recorded, authorized transfer. ADR 0002 deliberately excludes this for now.

**M3, M4.** Request review from specific humans. See concurrent work across a namespace's repositories. Add these only when shared-namespace use shows the need.

## Ecosystem

Agent-agnostic MCP/API, upstream forge integration, external orchestrators and downstream provenance.

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
| E1 | GitHub/GitLab upstream: explicit import, divergence, publication of approved revisions | Later (Next if D4 shows adoption needs it) | Open |
| E2 | Stable, documented MCP/HTTP contract | Next | Open |
| E3 | Use from external orchestrators | Later | Open |
| E4 | Downstream revision provenance for CI/release systems | Later | Open |
| E5 | Push-based console updates | Later | Measured need only |

**E1 — Upstream forges.** Explicit import (Artifacts public-HTTPS import; private repositories need a separately validated GitHub App installation transport), external divergence inspection, reconciliation, and publication of exact approved revisions or PR links. One canonical authority inside Cruce. No silent bidirectional sync. Stable external identity. Tokens never in persistent remotes.

**E2 — Contract stability.** Version the MCP catalog and HTTP routes, and document error semantics and idempotency, so tools and orchestrators can depend on them without special cases.

**E3 — Orchestrators.** Show an orchestrator (for example a relay or agent framework) creating, continuing and publishing workspaces through MCP/API with no Cruce-side special casing.

**E4 — Downstream provenance.** A read API, or portable Git notes if justified, that lets CI/release systems ask which proposal, reviews and human approval produced a canonical revision. Cruce never runs those systems.

**E5 — Live updates.** The console polls snapshots every 15 s. Use hibernating WebSockets only if measured latency or fan-out justifies them. Delivery never implies attention.

## Removed from the roadmap

Removed by [ADR 0001](docs/decisions/0001-product-boundary-reset.md) as outside the product boundary or not product capabilities. Do not reintroduce them without a new decision record.

- Automatic sequencing and opt-in agent pause/resume.
- Decision delivery, acknowledgement, intent/dependency reports and the agent "interaction contract."
- Business analytics pipelines.
- Workflows, ArtifactFS or other infrastructure as product items. Infrastructure is chosen when a concrete operation needs it.
- Any agent launching, hosting, messaging, scheduling or conversation storage.
- CI/CD, build, deployment, environment, rollout or runtime capabilities.

## How value is validated

Cruce's value appears at scale, so it is validated at scale. Scenarios include at least three concurrent workspaces from at least two different tools. One workspace is continued after a session restart and from a second checkout or machine. Canonical advances while other work continues. Overlapping and non-overlapping work, a clean merge that fails behaviorally, asynchronous review, and stale-proposal detection with reconciliation are all exercised. Later scenarios add a second developer.

Predeclare the measures and thresholds:

- time spent reconstructing state by hand (comparing branches, asking which revision is where);
- rework from late-discovered overlap or stale baselines;
- approvals or promotions of an unintended revision, which must be zero;
- setup and reporting burden, false alarms and misses;
- hosting cost and delay.

Count deliberate review separately from routine coordination. If value concentrates in one area (for example continuation and provenance rather than overlap), narrow the product there. If friction dominates, simplify before adding capability. No metric justifies weakening human review or source safeguards.

## Open feasibility questions

Hosted Artifacts subscription privileges, event latency and recovery remain acceptance checks; event ordering and historical replay are not assumed. Private-import transport remains unresolved. Resolve them with current primary documentation and bounded verification before choosing a mechanism. Record an unknown rather than inferring a guarantee from an example.
