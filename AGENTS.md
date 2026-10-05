# AGENTS.md — working on Cruce

Cruce is a Git-native platform for coordinating multiple heterogeneous AI coding agents working concurrently on the same repository, organized as **Namespace → Repository → Workspace**. It starts where individual-agent isolation ends: worktrees isolate work; Cruce coordinates independent workers. The working name should remain easy to change.

Read the [principles and guardrails](docs/principles.md), [architecture](docs/architecture.md) and [contributor guide](CONTRIBUTING.md) before changing domain behavior. [MCP participation](docs/mcp.md) describes the shared tool boundary. These documents own current constraints/design; [roadmap](ROADMAP.md) contains future candidates, not commitments or work instructions, [verification](docs/local-verification.md) records evidence, and [CHANGELOG](CHANGELOG.md) summarizes user-facing changes. Git history preserves implementation history; do not maintain a separate progress log.

- If Git already has a primitive, use Git instead of inventing another one. Commit, clone, fetch, pull, push, branch, diff and log remain normal Git. Publication adds exact-revision retention/review, not source transport.
- Coordinate across independent tools without launching agents or owning their runtimes. Cruce is not a Git/worktree replacement, a vendor-specific worktree manager, a GitHub/GitLab clone, an IDE, a cloud coding environment, a CI/CD replacement or a general agent orchestrator.
- Cruce ends at reviewed reconciliation into canonical Git. CI, build/release orchestration, deployment, environments, rollback and runtime management remain external. Do not add deployment abstractions or orchestration. Cruce’s own hosting and release tooling is infrastructure, not a repository capability.
- Keep architectural constraints, current implementation, proposed features and local/live verification distinct. Update the owning documentation with architectural changes; merge duplicate material and remove superseded instructions.

## Domain and boundaries

- A namespace owns repositories, membership, teams, Cloudflare credentials, resource policy and shared budgets. Personal namespaces have one owner. Shared namespaces support Owner, Maintainer, Developer and Viewer. Repository grants are Read, Write and Maintain, capped by namespace role.
- Stable internal IDs determine identity and storage ownership. Handles and repository names are mutable addresses. Remote URL matching never proves repository identity.
- Access verifies issuer and subject; the directory creates the user, human actor identity and personal namespace idempotently. Authentication identity is separate from membership. Invitations are expiring, verified-email-bound links.
- Agent identity comes from its authorized user and OAuth connection. Effective authority intersects current membership, repository grants, approved repositories and capability scopes. Client labels and Git authors cannot establish identity or human authority. Revocation applies on every request, including retries.
- Every repository has canonical Cloudflare Artifacts storage. Humans and agents use normal Git for clone/fetch/pull/commit/push. Cruce publishes exact pushed workspace revisions into immutable review artifacts. Local attachment never rewrites existing remotes or silently uploads history.
- A Workspace belongs to one repository and one actor. Its starting revision is immutable. Workspace is durable coordination identity, not a process or agent vendor. Each writer workspace owns one reusable direct fork of canonical in Cloudflare Artifacts; an agent may participate in many workspaces. ExecutionContext records only local materialization. Agent writers receive dedicated worktrees or isolated clones; human writers may attach existing checkouts.
- Enforce both persistent local writer locks and server checkout reservations. Thirty-second heartbeats expire active presence after ninety seconds, never ownership of a locked checkout. Disconnects and completion preserve workspaces, retained source and provenance. Local cleanup only removes Cruce-owned contexts after checking dirty and unpublished work; hosted fork cleanup requires proof of retention and uncertainty blocks deletion.
- Overlap is advisory awareness, not a Git conflict, initially based on changed paths including renames and binary files. Absence of overlap proves neither absence of concurrent work nor semantic compatibility. Structural analysis enriches context; it never grants authority. Local work does not require a plan or scheduling clearance.
- Changes preserve exact-revision review, reasoned disagreement, verification and promotion. Canonical promotion currently requires authenticated human approval, controller readiness and an explicit non-forced Git update. A local ref report never proves remote integration.
- Cloudflare Artifacts is provider infrastructure; Cruce source artifacts retain exact source with provenance, review base, hash, storage and trust. Evidence is separate. Publication proves which source was retained, not that it is correct or approved. See the [domain vocabulary](docs/architecture.md#domain-vocabulary-and-ownership).
- Namespace resource reservations are atomic across repositories. Retries reuse operation identity and reservation; uncertain outcomes remain charged until reconciled. No operator-account fallback. Repository policy may only narrow namespace policy.
- Credentials remain sealed server-side. Git operations use 60-second tokens, revoked after use. Never expose credentials in source, remotes, configuration, logs or frontend responses. Retain source referenced by artifacts.

## Implementation

- Keep `src/core` pure and deterministic with injected time and IDs. Add tests for controller behavior. The UI renders controller-derived permissions and readiness.
- `src/shared/tools.ts` is the single MCP command catalog. Coordination reads do not mutate, provision or fetch provider source. Every resource operation declares scope/cost and passes the authoritative namespace gate before infrastructure calls.
- Directory DO: identity/address lookup. Namespace DO: membership and atomic reservations. Repository Control Tower: workspaces, changes, artifacts and Git.
- Console navigation: Overview, Code, Work, Settings. Published revisions belong in Code; revision evidence belongs in Work. Persistent namespace/repository switchers; Members and Teams belong to shared namespaces. Keep account settings separate. Preserve keyboard navigation, deep links, Back, retries and late-response protection.
- Cruce coordinates local participants; it never launches agents. No coding chat, editor, agent runtime or intake forms. Offer Create repository, Clone and Attach local checkout. Disclose cloud setup/cost where resources are consumed.
- Read current [Artifacts](https://developers.cloudflare.com/artifacts/llms.txt) and [cf](https://developers.cloudflare.com/cf/llms.txt) documentation before platform changes. Use `cf` and `cloudflare.config.ts`; never use wrangler project commands.
- No legacy Flight/radar routes, project/mission aliases, migration adapters, shared-branch execution workspaces, mandatory scheduling or general workflow engine. Cloudflare Artifacts is intentional infrastructure; other source-hosting/forge, CI/CD, deployment, runtime, infrastructure-orchestration or workflow integrations require an explicit architectural decision before becoming core dependencies.

## Layout and verification

`src/core`: ownership, repository decisions, capabilities. `src/worker`: authentication, directory/namespace/repository Durable Objects, Git transport and source retention. `src/shared`: contracts/catalog. `runner`: local bridge and isolation. `src/ui`: console. `src/intelligence`: Babel structural index. `test/browser`: explicitly isolated fixed-clock console fixture.

Preserve pre-existing working changes. `demo/auth-service` and `demo/scenario` are reusable source fixtures: do not reformat them. Historic overlay directory names are fixture paths, not domain entities. Keep demo commit IDs reproducible.

Before committing run `pnpm typecheck && pnpm lint && pnpm test`, `pnpm test:browser`, `pnpm verify:scenario` and `pnpm exec cf build --mode offline`. Validate hosted publication/promotion in the configured test environment before describing them as live-verified. Update `CHANGELOG.md` for user-facing changes and `docs/local-verification.md` when verification status changes. Record checks and limitations in the review description.
