# Roadmap

[Documentation map](README.md#documentation-map) · [Product thesis](docs/product-thesis.md) · [Principles](docs/principles.md)

Cruce's direction is proactive coordination across independent coding agents working on one repository: reduce avoidable conflicts, duplicated effort and routine human intervention while preserving controlled integration. The milestones below describe the missing capabilities needed to test that goal. They are proposals, not shipped behavior, a delivery schedule or a record of work underway. There are no promised dates; priorities depend on measured value and integration feasibility.

Current behavior belongs in the [architecture](docs/architecture.md); local and live evidence belongs in [verification](docs/local-verification.md). This roadmap replaces the former implementation plan so there is one place for future direction.

## Proposed coordination milestones

The current foundation has isolated workspaces, cooperative path observations, source retention and exact-revision review/promotion. It has no structured intent/dependency protocol, coordination decision delivery, acknowledgements or pause/resume controls. The sequence below expresses capability dependencies, not a commitment to implement every milestone before evaluating value. Advisory coordination can be evaluated before controls exist.

| Milestone | Proposed capability | Observable completion evidence |
| --- | --- | --- |
| 1. Intent and fresh context | Bounded reports of intended outcomes, code areas, assumptions, dependencies, progress, scope changes and available independent work; a compact checkpoint view | Two independently authorized clients report and consume relevant context. A scope change supersedes old intent; heartbeat alone cannot refresh it. Reporting effort is measured |
| 2. Meaningful interference | Assess intent and available revision context to distinguish independent edits, overlapping edits, duplicate outcomes, incompatible assumptions and explicit dependencies | Examples allow independent same-file work to continue and identify reported cross-file dependencies and duplicate work; missed interactions and false alarms are recorded, with uncertainty visible |
| 3. Decisions and acknowledgements | Automatically recommend continuing, sequencing, a targeted pause or already identified independent work under an agreed policy; escalate unresolved ambiguity | Two clients receive applicable decisions at supported checkpoints and acknowledge, decline with reasons or report inability. Useful work continues; nonresponse leaves compliance unknown |
| 4. Supported controls | Opt-in scoped pause/resume through integrations with demonstrated capability; advisory behavior for unsupported clients | For each supported client/version, demonstrate the precise constrained action, a safe checkpoint, observed pause, release/resume and human override. Test loss of connection and unsupported capability without claiming a global stop |
| 5. Accepted-source follow-through | Track outstanding incorporation and verification for continuing writers against exact accepted revisions | After promotion, a second writer incorporates accepted source, verifies its resulting revision and republishes for fresh review. Receipt or fetch alone cannot satisfy follow-through; trust remains explicit |

A compact context read could become `get_coordination_context`, with a bridge `status` entry point; these names are proposals, not available commands. It should assemble recorded state without provider calls or acknowledgement mutations. Base-revision instructions remain separate from current observations. An acknowledgement is an explicit mutation, not a side effect of reading context. Any new commands and contracts must use the existing shared catalog and authority model; this roadmap does not define a new wire schema or capability scope.

### Proposed interaction contract

Decisions identify the affected workspaces/activity, reason and supporting observations, applicable scope and source revision, required response and release condition. A sequence or pause recommendation must explain what would allow the dependent activity to continue. Recommend existing independent work rather than inventing tasks or delegating new ones. An unresolved requirement or competing design choice needs a developer decision, not an automatic choice disguised as coordination.

Start with explicit context reads at useful checkpoints: task start, progress and scope changes, before dependent work and before publication. Client adapters must demonstrate that agents actually consume this context. Timely notification or lifecycle hooks may improve delivery where supported, but MCP registration alone provides neither attention nor interruption. Duplicate or delayed delivery must not reapply obsolete decisions; acknowledgements must refer to the applicable decision/version and remain separate from reads. Exact API design is implementation work, not an available interface.

An agent can acknowledge, decline with reasons or report inability to comply. Keep delivery, acknowledgement, reported action and observed enforcement separate. Acknowledgement does not prove the action occurred. Nonresponse leaves compliance unknown; escalate an unresolved consequential dependency to the developer without blocking unrelated work. Automatic recommendations are the first target. Scoped enforcement requires explicit opt-in, current authority and demonstrated client support; it cannot imply the ability to pause arbitrary agents or revoke human control. Routine coordination automation does not grant source approval or promotion authority.

Scope changes invalidate affected advice and trigger reassessment. Stale reports reduce confidence even if heartbeats continue. Disconnects preserve workspaces, locks, source and provenance; they do not prove completion, cancellation or that an agent has stopped editing. Reconnection requires refreshed intent, canonical context and outstanding decisions before treating old advice as applicable. A dependent activity can remain blocked while independent work proceeds. Circular dependencies or an unavailable prerequisite with no clear resolution require escalation; do not leave agents waiting indefinitely on an unexplained condition.

### Supporting participation work

Make human attention views explain decisions, freshness, missing responses, unresolved concerns and next actions with links to exact source/evidence. Improve setup and retry explanations for grants, preparing workspaces, checkout ownership and uncertain operations. Preserve local changes and operation identity.

Recovery should improve discovery and guidance around existing retained source, not add a Cruce checkout/fetch language or transfer ownership of an old workspace to a new actor. A successor locates the retained revision and continues in a new workspace using ordinary Git. Prioritize real Codex/Claude Code journeys before expanding client support; Cursor, Gemini CLI and custom clients must preserve the same authority/isolation model and demonstrate their own capabilities.

## Promising ideas to validate

These fit the product direction but need evidence that their benefit justifies the complexity.

| Idea | Evidence that would justify it | Architectural boundary |
| --- | --- | --- |
| Structural context for interference assessment | Reported intent and path signals repeatedly miss relevant interactions or create too much noise | Enrich milestone 2 with symbol/dependency context from pinned source; label uncertainty and never claim semantic compatibility or grant authority |
| More timely upstream awareness | Polling or delayed observations measurably cause stale work | Evaluate push/lifecycle event reconciliation; tolerate duplicates and reordered delivery; events do not approve changes or launch agents |
| Focused source/context retrieval | Agents spend material time or tokens retrieving unrelated source | Evaluate pinned file/tree/history retrieval and caching; provider reconciliation is explicit and gated, while ordinary coordination reads remain on recorded state |
| External CI/release handoff or provenance | Users repeatedly need to locate external results for an accepted revision | Explore links or externally reported provenance tied to exact canonical revisions; this is uncommitted and would not trigger builds, manage environments, deploy, roll back or operate runtimes |
| Better review and evidence navigation | Humans repeatedly reconstruct what changed or which checks apply | Improve comparison and evidence-freshness explanations across publications; each artifact, review and attestation keeps its original exact revision |
| Resource and retention visibility | Users cannot explain operation usage, uncertain reservations or cleanup blockers | Show ownership, budget and retention reasons; distinguish logical operations from provider billing and never delete referenced or unpublished source automatically |
| Larger-transfer support | Representative repositories exceed the current gateway's transfer bound | Investigate bounded streaming while preserving credential isolation, retry safety and provider limits; do not promise unrestricted repository size |

Git-note summaries are a later option if portable provenance becomes useful; mutable notes cannot replace authoritative identity or review records. ArtifactFS is worth considering only if measured checkout startup costs justify it and server-side credential handling can be preserved. Neither is a current setup requirement. Provider work follows the [Cloudflare references](docs/cloudflare-setup.md#platform-references).

## Foundation validation still needed

These are verification gaps in the existing foundation, not new feature promises:

- Verify the deployed Git/publication gateway and authenticated reconciliation flow against the explicit test account, including lost-response recovery, authority revocation and rejection of revoked Git tokens. Provider-backed two-writer convergence, distinct reusable forks and retention are recorded in the [verification guide](docs/local-verification.md#hosted-two-writer-convergence); in-process grants do not establish deployed authentication. Declare the resource budget before running it.
- Exercise actual browser consent and independent bridge processes with different tools. Adapter tests with in-memory grants do not establish client interoperability or that an agent consumes updates.

The [verification guide](docs/local-verification.md) owns detailed status and costs. Keep required contributor checks and deterministic fixture history intact when extending these scenarios.

## How we choose what to build

Prefer improvements that reduce human coordination effort while preserving the [principles and guardrails](docs/principles.md). Before starting a candidate, define a concrete user problem, the smallest useful change, its authority/resource boundary and observable completion evidence. Track the implementation detail in an issue or review rather than turning this document into a task log.

Use a small matched pilot: one developer, one repository, Codex and Claude Code, subject to demonstrated integration support. Compare ordinary isolated worktrees and Git review with Cruce using comparable tasks, tools/models, instructions and checks. Repeat matched trials and vary their order so familiarity with a task does not masquerade as a coordination benefit. Record the Cruce revision, client versions and enabled capabilities. A manually relayed prototype can investigate advice quality, but cannot validate automated delivery or reduced human intervention.

| Scenario | What the pilot must examine |
| --- | --- |
| Independent edits in one file | Useful work continues without unnecessary waiting; a shared path is not sufficient reason to pause |
| Duplicate outcomes | Early shared intent avoids redundant implementation even when paths differ |
| Cross-file contract/assumption changes | Relevant incompatibility is surfaced before substantial avoidable work; clean Git merges do not establish correctness |
| Explicit dependency | Only the dependent activity waits, with a clear release condition; identified independent work continues |
| Scope drift, stale reports and disconnect/recovery | Old advice is reassessed; presence is not intent freshness; locks and retained source survive |
| Ignored, declined or unsupported advice | Nonresponse is visible as unknown compliance; consequential unresolved decisions reach the developer |
| Canonical advancement | Other continuing writers explicitly incorporate the accepted revision, verify the resulting source and obtain fresh review before promotion |

Measure routine human intervention count and coordination time separately from deliberate review and design decisions. Count duplicated effort and integration rework, completion time, unnecessary waiting, reporting effort, setup and cloud/agent costs, missed interference, false alarms and resulting quality. Include required Cloudflare canonical setup and troubleshooting as adoption costs. Preserve exact revisions and revision-linked outcomes; distinguish reported checks from independently exercised verification.

Before trials, define how interventions and rework will be counted, the matched sample, numeric improvement targets and acceptable overhead/quality limits. Proceed only if repeated trials show the agreed reduction in routine coordination, duplication and rework within those limits. Report inconclusive results as inconclusive; successful registration, more concurrent agents or more acknowledgements is not success. Agents must demonstrably consume and act on relevant context without the developer relaying every notice.

If benefit concentrates in upstream awareness or recovery, narrow the product there. If reporting, false alarms, delays or hosting friction outweigh saved effort, simplify and repeat the comparison before expanding. If the simplified approach still misses the agreed targets, stop expansion and revisit the premise rather than adding more orchestration. Do not trade away human review or integration safeguards to improve the metrics.

When an idea ships, update architecture/setup documentation and the changelog, record verification evidence, and remove or narrow its roadmap entry. Drop ideas when their premise no longer holds; Git history preserves the decision trail. Do not retain completed checklists here.

## Open questions and integration requirements

| Unresolved question | Evidence or decision required |
| --- | --- |
| How does each client receive and consume decisions? | Verify checkpoint reads and any notification/lifecycle hooks in actual Codex and Claude Code versions with independent OAuth connections; configuration writers alone are insufficient |
| Where can work safely pause and resume? | Identify the supported action boundary, in-flight behavior, local work preservation and release/override path per adapter; do not claim an arbitrary process can be paused |
| What proves enforcement? | Distinguish an agent's reported compliance from an adapter-observed constrained action; define timeout/disconnect behavior and test duplicate, stale and reordered decisions |
| What is the minimum useful reporting burden? | Trial bounded intent, dependency and scope updates; determine which observations can be collected automatically without treating inferred intent as fact |
| Which decisions can be automatic? | Define authorized opt-in policy, limits, decision expiry/reassessment, human override and escalation for disagreement, uncertainty and dependency cycles; preserve human promotion authority |
| What improvement justifies adoption? | Set the matched trial size, numeric intervention/rework targets, delay/reporting/cost ceilings and quality floor before evaluating results |
| Does mandatory canonical hosting cost too much to adopt? | Measure Cloudflare setup, resource cost and workflow friction against saved effort; any alternative source-hosting architecture needs a separate explicit decision |

Repository-specific recommendations and future opt-in supported controls fit this direction; agent runtimes, remote IDEs, mandatory scheduling, automatic source acceptance, additional source-hosting/forge or delivery-provider integrations beyond the canonical Cloudflare Artifacts foundation, CI/build/release orchestration, deployments, environments, rollback, runtime management and a general workflow engine remain outside the current product boundary. A roadmap idea cannot silently override that boundary; introducing those integrations requires an explicit architectural decision, and automated promotion would change authority policy.
