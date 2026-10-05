# AGENTS.md — working on Cruce

Cruce is Git-native collaboration for developers and agents, organized as **Workspace → Repository → Session**. This direction supersedes the former project/mission model. The working name should remain easy to change.

## Domain and boundaries

- A workspace owns repositories, membership, teams, Cloudflare credentials, resource policy and shared budgets. Personal workspaces have one owner. Shared workspaces support Owner, Maintainer, Developer and Viewer. Repository grants are Read, Write and Maintain, capped by workspace role.
- Stable internal IDs determine identity and storage ownership. Handles and repository names are mutable addresses. Remote URL matching never proves repository identity.
- Access verifies issuer and subject; the directory creates the user, human actor identity and personal workspace idempotently. Authentication identity is separate from membership. Invitations are expiring, verified-email-bound links.
- Agent identity comes from its authorized user and OAuth connection. Effective authority intersects current membership, repository grants, approved repositories and capability scopes. Client labels cannot establish identity or human authority. Revocation applies on every request, including retries.
- A repository uses local Git through the bridge or Cloudflare Artifacts hosting. Local registration never uploads history, rewrites remotes or provisions cloud resources. Explicit publication transports exact commits in a Git pack. Server browsing requires uploaded objects.
- A Session belongs to one repository and one actor. Its starting revision is immutable. ExecutionContext records a local checkout/worktree and optional hosted fork. Agent writers receive dedicated worktrees; human writers may attach existing checkouts.
- Enforce both persistent local writer locks and server checkout reservations. Thirty-second heartbeats expire active presence after ninety seconds, never ownership of a locked checkout. Completion retains commits, artifacts and provenance. Cleanup only removes Cruce-owned contexts after checking dirty and unpublished work.
- Overlap is advisory, initially based on changed paths including renames and binary files. Structural analysis enriches context; it never grants authority. Local work does not require a plan or scheduling clearance.
- Changes preserve exact-revision review, reasoned disagreement, verification and promotion. Hosted source promotion is human-approved and non-forced. External integration is an observed record, never a claim that a remote push was independently verified.
- Artifacts carry workspace, repository, session, actor, revision, hash, storage and trust. Deployment requires an immutable source artifact and derives its revision. Source acceptance and deployment are separate. Production is an authenticated console decision. Rollback names a prior deployed artifact.
- Workspace resource reservations are atomic across repositories. Retries reuse operation identity and reservation; uncertain outcomes remain charged until reconciled. No operator-account fallback. Repository policy may only narrow workspace policy.
- Credentials remain sealed server-side. Git operations use 60-second tokens, revoked after use. Never expose credentials in source, remotes, configuration, logs or frontend responses. Retain source referenced by artifacts/deployments.

## Implementation

- Keep `src/core` pure and deterministic with injected time and IDs. Add tests for controller behavior. The UI renders controller-derived permissions and readiness.
- `src/shared/tools.ts` is the single MCP command catalog. Reads do not mutate or provision. Every resource operation declares scope/cost and passes the authoritative workspace gate before infrastructure calls.
- Directory DO: identity/address lookup. Workspace DO: membership and atomic reservations. Repository Control Tower: sessions, changes, artifacts, Git and deployments.
- Console navigation: Overview, Code, Work, Artifacts, Deployments, Settings. Persistent workspace/repository switchers; Members and Teams belong to shared workspaces. Keep account settings separate. Preserve keyboard navigation, deep links, Back, retries and late-response protection.
- Cruce coordinates local participants; it never launches agents. No coding chat, editor, agent runtime or intake forms. Offer Open local repository and Create Artifacts repository. Disclose cloud setup/cost where resources are consumed.
- Read current [Artifacts](https://developers.cloudflare.com/artifacts/llms.txt) and [cf](https://developers.cloudflare.com/cf/llms.txt) documentation before platform changes. Use `cf` and `cloudflare.config.ts`; never use wrangler project commands.
- No legacy Flight/radar routes, project/mission aliases, migration adapters, shared-branch execution workspaces, mandatory scheduling, provider integrations or general workflow engine.

## Layout and verification

`src/core`: ownership, repository decisions, capabilities. `src/worker`: authentication, directory/workspace/repository Durable Objects, Git transport, deployments. `src/shared`: contracts/catalog. `runner`: local bridge and isolation. `src/ui`: console. `src/intelligence`: Babel structural index. `test/browser`: explicitly isolated fixed-clock console fixture.

Preserve pre-existing working changes. `demo/auth-service` and `demo/scenario` are reusable source fixtures: do not reformat them. Historic overlay directory names are fixture paths, not domain entities. Keep demo commit IDs reproducible.

Before committing run `pnpm typecheck && pnpm lint && pnpm test`, `pnpm test:browser`, `pnpm verify:scenario` and `pnpm exec cf build --mode offline`. Validate hosted publication/deployment in the configured test environment before describing them as live-verified. Record short dated progress in `docs/PROGRESS.md`.
