# Product plan — Git foundation and coordination pilot

The active implementation plan is [Artifacts Git foundation](git-foundation-plan.md). It supersedes the earlier optional-hosting and custom checkout/fetch transport assumptions. The durable hierarchy is Namespace → Repository → Workspace; each writer workspace owns an agent/task identity and an Artifacts fork.

The [product thesis](product-thesis.md) is to reduce the developer's effort keeping interacting agent work coherent and deciding what to accept. The next milestone is a measured usage pilot. Additional platform breadth should follow evidence from that pilot.

## Implemented foundation

- Stable namespace/repository/actor identity, Access sign-in, personal and shared ownership, membership/grants and atomic namespace resource budgets.
- Canonical Artifacts repositories, optional bridge/MCP participation, dedicated agent worktrees, persistent writer locks and server reservations, heartbeats and advisory path overlap.
- Normal Git transport, immutable revision publication, retained workspace forks and upstream inspection, immutable Workspace starting revisions and artifact-pinned review bases.
- Revision-bound proposals/reviews/evidence, human-approved non-forced hosted source promotion and separate artifact-derived deployment records.
- Console, fixed-clock browser fixtures and reproducible source scenarios. No legacy project/mission aliases or migration adapters.

The Workspace update implementation passed local verification on 2026-10-05. Its latest changes remain undeployed and have not been live-verified against Artifacts. Earlier hosted foundation verification does not establish the new reconciliation flow or successful Workers Builds deployment. See [progress](PROGRESS.md), [verification](local-verification.md) and [test environment](test-environment.md) for dated evidence.

## Implementation plan — 2026-10-05

Build a small, complete coordination loop before adding more infrastructure. The first increment should let two independently authorized agents work from the same repository, discover relevant changes at checkpoints, publish isolated results, reconcile after human acceptance and recover published work after a participant stops.

One fork is reused per hosted writer Workspace. Multiple concurrent Workspaces from the same tool remain independent. Agent execution stays local. Repository hosting and workspace forks require the namespace’s explicit Cloudflare account.

| Order | Deliverable | Completion evidence |
| --- | --- | --- |
| M0 | Stabilize the existing upstream reconciliation foundation | Required local checks and a reproducible two-writer scenario |
| M1 | Compact, current coordination context through MCP and the bridge | Deterministic, authorized, bounded reads with useful checkpoint output |
| M2 | Console attention and clear next actions | Browser journey from concurrent work through stale review to fresh acceptance |
| M3 | Recovery of a published artifact into a new participant's checkout | Exact revision recovered; new Workspace owns new work; original provenance retained |
| M4 | Live Artifacts and independent OAuth participation verification | Recorded provider results plus two real authorized bridge connections |
| M5 | Matched developer workflow pilot | Human effort, rework, review and cloud overhead compared with ordinary Git |
| Conditional M6 | Artifacts event reconciliation or focused source retrieval | A measured pilot problem and a verified improvement |

M0–M4 form the proposed first implementation increment. M5 determines whether to expand or simplify it. Do not count local fixtures, the provider-adapter test and the real OAuth journey as interchangeable evidence.

### M0 — stabilize the existing work

- Preserve the current working tree and separate existing Workspace-update work from unrelated changes when preparing reviewable commits. Evaluate existing abstractions against the Git foundation plan; preserve useful behavior without retaining the replaced ownership or transport models.
- Extend the reproducible repository scenario to cover two writers starting together, one accepted change, explicit fetch and integration by the other, fresh evidence and a second acceptance. Include a behavioral incompatibility that merges cleanly, so the scenario demonstrates why verification matters without claiming semantic detection.
- Keep the original Workspace base fixed, retain previously published commits, pin each artifact's review base and reuse fork/reservation identity during uncertain retries. Fetch must preserve dirty files, index, HEAD and remotes.
- Run the required local checks and record the new scenario's exact revisions and verification boundaries.

Primary areas: `runner/execution.ts`, `runner/cruce.ts`, `src/core/platform.ts`, `src/worker/repository-runtime.ts`, `tools/verify-scenario.ts` and existing runtime/native-Git tests. Preserve `demo/auth-service` and reusable overlay fixtures without reformatting them.

### M1 — give agents useful coordination context at checkpoints

Add a proposed read-only `get_coordination_context` command to the single catalog in `src/shared/tools.ts`. It should assemble information already available through repository, Workspace, overlap and review records, rather than require every participant to download the entire repository snapshot and interpret it.

The response should include the requesting Workspace's original and last published integration baselines, accepted or reported upstream status, other participants' reported objectives/paths and freshness, relevant path overlap, retained source-artifact references and review reasons needing attention. Include exact IDs/revisions, observation time, trust labels and bounded lists with explicit truncation. Reuse `get_workspace_updates` for detailed uploaded-object comparison; keep `get_context` tied to immutable starting-revision instructions.

Keep response derivation pure with injected time. Scope every result to the currently authorized repository and recheck access on each request. Reads do not record acknowledgements, fetch provider objects or reserve resources. A bridge may keep a local cursor or response fingerprint to display changes since its own last checkpoint; receiving context never means the agent has integrated source or resolved an overlap.

Update the existing client participation instructions and add a bridge `status` entry point using the same read. Recommend checkpoints at task start, significant scope changes, before publication and after acceptance changes. Participation remains cooperative; there are no mandatory scheduling gates, autonomous agent messages or claims that installing MCP guarantees an agent consumes updates.

Acceptance: two participants receive distinct, relevant context; a reported-only upstream revision remains visibly unavailable for Git comparison; disconnected presence is labelled; repeated reads leave controller/storage/resource state unchanged; revoked and foreign-repository access fail; large responses remain bounded and disclose omitted items.

Primary areas: `src/shared/platform.ts`, `src/shared/tools.ts`, `src/core/platform.ts`, `src/worker/repository-runtime.ts`, `runner/cruce.ts`, `runner/client-config.ts` and controller/runtime tests.

### M2 — make human attention and next actions clear

Use the same controller-derived context for the repository Overview, Work and Workspace details. Surface upstream changes, reported overlap, disconnected participants and proposals requiring decisions with links to the exact records. Each item should explain its evidence and offer the appropriate inspection or review action.

Keep path overlap advisory. Distinguish an update being visible, fetched, included in a published revision and accepted; avoid a single checkbox implying all four. Stale proposals should show the source revision that advanced and why new review/evidence is required. Inspection remains a read; merging remains an explicit local Git action.

Acceptance: the fixed-clock browser journey shows two Workspaces, one human acceptance, an upstream update for the second writer, a stale proposal reason and a reconciled proposal with fresh evidence. Preserve permissions, keyboard navigation, deep links, Back, mobile layout, retry identity and protection against late responses.

Primary areas: `src/ui/App.tsx`, `src/ui/inspect.tsx`, shared controller contracts and `test/browser`. No separate UI authorization or readiness logic.

### M3 — recover published work and continue with a new Workspace

Use ordinary Git clone/fetch/checkout to recover retained revisions. A coordination read should identify exact source artifact provenance and its authorized remote, without inventing a checkout command. Original workspace records and artifact revisions remain unchanged; new work gets a new workspace/fork identity.


### M4 — verify Cloudflare storage and real participation

First extend `tools/verify-cloud.ts` from a single-writer smoke check to two separately identified connections and the full acceptance/reconciliation flow. Use an explicitly connected test account, an isolated namespace and a declared operation budget. The previous script's budget of up to three reservations is insufficient for the expanded flow; document the expected reservation count before running it.

Assert distinct forks, repeated publication to the same Workspace storage, exact independent Git fetches, human-approved non-forced promotion, retention after Workspace completion and recovery from an unaccepted published artifact. Exercise retry identity, access revocation and token revocation without logging credentials. Retain non-secret results and referenced source; do not delete resources whose ownership or retained references are uncertain.

Then verify two independent OAuth grants and bridge processes against the configured test Worker, including separate local checkouts and preferably two different agent tools. The adapter script's in-memory grants do not establish browser consent, grant enforcement or client interoperability. Verify the registered repository IDs, effective scopes, checkout isolation and revocation on retry. No client label establishes identity.

Record which checks ran locally, through the real Artifacts adapter and through the live Worker. A failed or unavailable live gate remains open. Deploy the reviewed build to the configured test environment only within the authorized deployment scope; deployment is not performed as part of creating this plan. Successful Workers Builds deployment is a separate milestone and is not required for this coordination pilot.

Primary areas: `tools/verify-cloud.ts`, `src/worker/namespace-runtime.ts`, resource/Git adapters as needed, `docs/local-verification.md` and `docs/test-environment.md`. Read current Artifacts and `cf` documentation before platform implementation; use `cf` and `cloudflare.config.ts`.

### M5 — measure the developer workflow

Run the matched trial described below after M4. Include one interacting-task case, one independent-task case and one disconnect/recovery case. Predeclare the developer-effort improvement that would justify continued use, then capture the actual human time and added agent/cloud overhead. Use the observations to select the next implementation slice.

### Conditional M6 — add only the Cloudflare capability the pilot needs

If update latency or repeated polling creates material coordination effort, implement the narrow Artifacts event reconciler described in the [Cloudflare strategy](cloudflare-strategy.md). Keep events as provider observations. Resolve them through stable owned storage and exact objects; tolerate duplicate, delayed and reordered delivery; never infer human acceptance or actor authority from an event. Subscription setup and provider reconciliation pass declared resource gates. Keep pure reads on recorded state and do not restore the retired handler.

If source/context transfer is the measured problem instead, compare native pinned file/tree/history retrieval with the existing cache behind the connected-account adapter. Test cost and latency before changing the normal read path. Git notes and ArtifactFS remain deferred unless the pilot establishes a portability or checkout-startup problem.

Acceptance for any event implementation includes wrong-namespace storage, duplicated/out-of-order events, unexpected canonical writes, revoked access, uncertain reservations and actual provider delivery. The feature must demonstrably improve the observed problem without extra agent interruptions or weakened human control.

## Verification and release gates

For controller, runtime and bridge changes, add behavioral tests around authorization, freshness, exact revisions, retention and uncertain retries. Use real native Git where file/index/lock preservation matters. Browser tests should exercise the complete user journey rather than mirror component implementation.

Before committing an implementation increment, run `pnpm typecheck && pnpm lint && pnpm test`, `pnpm test:browser`, `pnpm verify:scenario` and `pnpm exec cf build --mode offline`. Record short dated progress with results and limitations. Live hosted verification uses the explicitly configured test account and must be recorded separately. No production deployment, extra provider integration, agent runtime, mandatory scheduling or automatic source acceptance is included in this plan.

## Next milestone — observe the full developer workflow

Use one developer, one repository and two or three agents in their existing tools. Include interacting tasks and an independent-task comparison. The trial should exercise:

1. Authorizing independent participants and connecting them to the same stable repository without confusing local connection state or permissions.
2. Starting concurrent Workspaces, reporting changes and inspecting current work without repeatedly asking every agent for status.
3. Landing one change while another Workspace is still working; inspecting updates, explicitly integrating source and verifying the new revision.
4. Pausing or ending a participant, then continuing or handing off its published work while retaining provenance and local unpublished work.
5. Reviewing exact artifacts and fresh evidence, making a human acceptance decision and understanding why a proposal is ready or stale.

Start with the existing bridge, console and MCP capabilities. Record missing context and unnecessary steps as observed problems. Do not assume that semantic dependency detection, automatic notification delivery or automatic integration already exists. Run hosted cases only with an explicitly configured test account and resource budget; ordinary local registration remains free of provisioning.

## Cloudflare implementation priorities

Follow the [Cloudflare capability strategy](cloudflare-strategy.md) alongside the pilot:

1. Live-verify retained Workspace forks, exact publication, upstream reconciliation and handoff using the connected test account. Confirm storage/transfer fit, uncertain-outcome recovery and revocation.
2. Evaluate Artifacts push/lifecycle events to reduce stale observations and repeated polling. Build a narrow reconciler only when the pilot shows that update latency creates material effort; preserve human acceptance and agent checkpoint consumption.
3. Compare native commit/tree/file/history retrieval with the existing cache if context transfer is costly. Any provider call needs declared scope/cost and namespace gating; ordinary reads remain on recorded state.
4. Evaluate selective Git-note provenance or ArtifactFS only if portability or startup measurements warrant them. Neither grants authority or introduces an agent runtime.

Measure cloud operations/storage and developer effort at each step. No event subscription, native-read adapter, note mirroring or ArtifactFS integration is installed by this documentation update.

## Compare against the existing workflow

Run matched tasks using ordinary worktrees, normal agent capabilities and Git review, then using Cruce. Keep agent count, tool/model settings, instructions, test requirements and acceptance criteria comparable. Alternate the order across task pairs to reduce learning effects. Include both interacting and independent work so improvements are not attributed solely to parallel execution.

| Measure | Record for both approaches |
| --- | --- |
| Human coordination effort | Minutes spent relaying updates, requesting status, identifying dependencies and reconstructing work |
| Avoidable rework | Duplicated edits and work redone because source or assumptions became stale, including diagnosis time |
| Review and acceptance effort | Human minutes locating exact changes, checking evidence and deciding what lands |
| Delivery outcome | Time to an accepted revision passing the agreed checks, failures after integration and retained/recoverable work |
| Added overhead | Setup, Workspace/report/publication steps, agent time or tokens, cloud usage and interruptions |

Store commit IDs, task descriptions, timestamps and developer observations with the trial results. Distinguish reported agent outcomes from executed tests. Git merge success does not prove behavioral compatibility. Passing automated checks also does not prove reduced coordination effort.

## Product decision after the pilot

Agree on a worthwhile reduction in developer effort before evaluating results; do not invent a universal percentage from a small sample. Continue when repeated interacting-task trials show a meaningful improvement after accounting for setup and operating costs, without weakening verification or human control.

If gains come mainly from upstream awareness, simplify around that workflow. If retention and handoff provide the clearest value, make those easier. If developers still relay the same information and Cruce adds bookkeeping, revise or narrow the thesis before adding features. A small pilot supports a product decision, not a market-wide adoption claim.

Shared-namespace administration and deployments remain supported but are not required to prove this initial use case. Preserve private access, local Git, advisory overlap and explicit namespace resource accounts. Public signup, external provider integrations, automated external pushes, mandatory scheduling and a general workflow engine remain out of scope.
