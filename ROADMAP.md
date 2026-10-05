# Roadmap

[Documentation map](README.md#documentation-map) · [Product thesis](docs/product-thesis.md) · [Principles](docs/principles.md)

Cruce's direction is to make concurrent work across independent coding agents easier to understand, reconcile and accept. This is a curated set of likely improvements and promising ideas, not a delivery schedule or a record of work underway. Inclusion does not mean implementation has started, a design is settled or delivery is committed. There are no promised dates or fixed implementation order.

Current behavior belongs in the [architecture](docs/architecture.md); local and live evidence belongs in [verification](docs/local-verification.md). This roadmap replaces the former implementation plan so there is one place for future direction.

## Likely next improvements

These are the strongest candidates because they complete or simplify the central coordination loop. Priorities may change after real usage.

| Candidate | Why it matters | What a useful result would demonstrate |
| --- | --- | --- |
| Compact coordination context for agents | Participants currently assemble context from several reads | One bounded checkpoint view of current work, relevant upstream changes, overlap, freshness and review reasons, with exact revisions and trust labels |
| Clearer human attention and next actions | A developer needs to see which concurrent work needs a decision | Overview and workspace views explain stale proposals, unresolved concerns and relevant updates, linking to the exact source/evidence without implying automatic resolution |
| Easier participation across different tools | Configuration alone does not establish interoperability | Repeatable connection/setup guidance and real journeys with independently authorized clients; evaluate Gemini CLI and custom-client adapters alongside the existing configuration writers |
| Recovery and handoff of published work | Work should remain usable after an agent disconnects or stops | Another participant can locate and fetch an exact retained revision with ordinary Git, understand its provenance and continue in a new workspace |
| Clearer setup and interruption recovery | Authentication, checkout ownership and uncertain operations can be difficult to diagnose | Actionable explanations for missing grants, preparing workspaces, stale presence and pending retries, while preserving local changes and operation identity |

A compact context read could become `get_coordination_context`, with a bridge `status` entry point; these names are proposals, not available commands. It should assemble recorded state without provider calls or acknowledgement mutations. Base-revision instructions remain separate from current observations, and fetching an update must remain distinct from integrating or accepting it.

Recovery should improve discovery and guidance around existing retained source, not add a Cruce checkout/fetch language or transfer ownership of an old workspace to a new actor. Broader client support must preserve the same authority and isolation model rather than special-case a vendor.

## Promising ideas to validate

These fit the product direction but need evidence that their benefit justifies the complexity.

| Idea | Evidence that would justify it | Architectural boundary |
| --- | --- | --- |
| More useful advisory overlap | Path-only signals repeatedly miss relevant interactions or create too much noise | Explore symbol/dependency context from pinned source; label uncertainty and never claim semantic compatibility or grant authority |
| More timely upstream awareness | Polling or delayed observations measurably cause stale work | Evaluate push/lifecycle event reconciliation; tolerate duplicates and reordered delivery; events do not approve changes or launch agents |
| Focused source/context retrieval | Agents spend material time or tokens retrieving unrelated source | Evaluate pinned file/tree/history retrieval and caching; provider reconciliation is explicit and gated, while ordinary coordination reads remain on recorded state |
| External CI/release handoff or provenance | Users repeatedly need to locate external results for an accepted revision | Explore links or externally reported provenance tied to exact canonical revisions; this is uncommitted and would not trigger builds, manage environments, deploy, roll back or operate runtimes |
| Better review and evidence navigation | Humans repeatedly reconstruct what changed or which checks apply | Improve comparison and evidence-freshness explanations across publications; each artifact, review and attestation keeps its original exact revision |
| Resource and retention visibility | Users cannot explain operation usage, uncertain reservations or cleanup blockers | Show ownership, budget and retention reasons; distinguish logical operations from provider billing and never delete referenced or unpublished source automatically |
| Larger-transfer support | Representative repositories exceed the current gateway's transfer bound | Investigate bounded streaming while preserving credential isolation, retry safety and provider limits; do not promise unrestricted repository size |

Git-note summaries are a later option if portable provenance becomes useful; mutable notes cannot replace authoritative identity or review records. ArtifactFS is worth considering only if measured checkout startup costs justify it and server-side credential handling can be preserved. Neither is a current setup requirement. Provider work follows the [Cloudflare references](docs/cloudflare-setup.md#platform-references).

## Foundation validation still needed

These are verification gaps in the existing foundation, not new feature promises:

- Exercise two writers starting from one revision, accept one result, then fetch, merge, verify and freshly review the other. Include a behavioral incompatibility whose patches merge cleanly; passing a merge is not proof of correctness.
- Verify the current hosted Git/publication path and reconciliation flow against the explicit test account, including distinct forks, fork reuse, retention, lost-response recovery and revocation. Declare the resource budget before running it.
- Exercise actual browser consent and independent bridge processes with different tools. Adapter tests with in-memory grants do not establish client interoperability or that an agent consumes updates.

The [verification guide](docs/local-verification.md) owns detailed status and costs. Keep required contributor checks and deterministic fixture history intact when extending these scenarios.

## How we choose what to build

Prefer improvements that reduce human coordination effort while preserving the [principles and guardrails](docs/principles.md). Before starting a candidate, define a concrete user problem, the smallest useful change, its authority/resource boundary and observable completion evidence. Track the implementation detail in an issue or review rather than turning this document into a task log.

Use a small matched pilot: one developer, one repository and two or three independent agents, with interacting tasks, independent tasks and a disconnect/recovery case. Compare Cruce with ordinary worktrees and Git review using comparable tools/models, instructions and checks. Measure human coordination/review time, avoidable rework, delivery quality and recoverability alongside setup, agent and cloud overhead. Retain exact revisions and distinguish reported outcomes from executed checks.

Agree on what improvement would justify continued use before evaluating results. If value concentrates in upstream awareness or recovery, focus there. If Cruce adds bookkeeping without reducing effort, simplify or revise the idea before expanding scope. Successful MCP registration or more concurrent agents alone is not evidence of product value.

When an idea ships, update architecture/setup documentation and the changelog, record verification evidence, and remove or narrow its roadmap entry. Drop ideas when their premise no longer holds; Git history preserves the decision trail. Do not retain completed checklists here.

Agent runtimes, remote IDEs, mandatory scheduling, automatic source acceptance, forge/provider integrations, CI/build/release orchestration, deployments, environments, rollback, runtime management and a general workflow engine remain outside the current product boundary. A roadmap idea cannot silently override that boundary.
