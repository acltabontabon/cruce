# Architecture

Cruce is an agent-native development platform built on **Git + Cloudflare Artifacts**. Git provides the mechanics of software evolution; Artifacts is the canonical Cloudflare-native home of that evolution; **Cruce MCP** gives agents an intentional interface to the development lifecycle; the **Cruce Control Tower** provides intent, coordination, policy, verification, governance and lineage. Cloudflare capabilities sit behind Cruce where they serve that lifecycle. The project's Cloudflare account is the resource and billing boundary. Agents execute locally unless cloud execution adds real value.

No GitHub or GitLab hosting, pull requests, issues, Actions, apps or provider-specific workflows participate. They may later be supported for import, export and mirroring only.

```text
                LOCAL DEVELOPMENT
     Claude Code / Codex / Cursor / IDE / terminal / git / docker
                         │ MCP (remote Streamable HTTP, or runner/cruce.ts stdio bridge)
                         ▼
     Worker: Access identity · OAuth scopes · project membership · Cruce MCP · console API
                         │
                         ▼
     ControlTower Durable Object (one per project) — Cruce Control Tower
       ProjectRuntime ─ pure PlatformController (intent, mission, proposal, verification,
       │                 review, promotion, resource policy, environments, deployments, lineage)
       CoordinationRuntime ─ pure WorkstreamController (scope, partial clearance, refresh)
       SQLite: state, audit, isomorphic-git object database (actual Git objects)
                         │ 60-second server-side tokens, revoked after each Git operation
                         ▼
     Cloudflare Artifacts (canonical software state)
       project-<id>                canonical repository; main = accepted source
       project-<id>-baseline-<sha> immutable baseline snapshot a workspace forks from
       project-<id>--w-<n>         one isolated fork per mission workspace
       project-<id>--evidence      immutable evidence artifacts
       project-<id>--deploy        deployment intent for Workers Builds (main = production,
                                   cruce/proposal-N = Worker Preview); lives in the resource account
                         │
            local build/test/dev            Workers Builds → Worker Preview → Production
                                            DeploymentWorkflow: await build → smoke checks → evidence
```

## Three layers

| Layer | Concepts | Where |
| --- | --- | --- |
| Intent | Intent, Mission, Agent, Proposal, Verification, Policy, Lineage | `src/core/platform.ts`, `src/shared/platform.ts` |
| Version | Git, Artifacts, Revision, Diff, Workspace, Fork, Merge | `src/worker/git/*`, `src/worker/managed-workspace.ts`, `src/worker/artifacts-host.ts` |
| Execution | Local machine, agent runtime, build, preview, Worker, deployment | `runner/*`, `src/worker/deployments.ts`, `src/worker/deployment-workflow.ts` |

## Domain model

- **Project** (`ProjectConnection`, `ProjectDirectory`): tenant, members (maintainer, contributor, observer) and its **SourceRepository** in Artifacts. Creating a project provisions the canonical repository — an explicit human action. Reading an unprovisioned project never creates resources.
- **Revision**: a full Git commit id. Every artifact, proposal, verification, review, promotion and deployment names one.
- **Intent** → **Mission** (bounded plan; `baseRevision` pinned to an accepted revision by Cruce; `headRevision`; `agent`; optional `experimentOf` for alternative approaches).
- **Workspace**: one Artifacts fork per mission workstream, forked from an immutable baseline snapshot. Never branches of a shared repository.
- **Artifact**: immutable output anchored to a revision: source (with commits and changed files) or typed evidence (test report, benchmark, architecture, security scan, SBOM, preview report…). Records producer and **execution** location (local, cloudflare, external) separately from source and deployment.
- **Proposal**: exact `base` and `revision`, repository, commit and file counts, number, state (`proposed`, `promoting`, `promoted`, `rejected`, `changes_requested`, `superseded`).
- **VerificationRequest / Verification**: always pinned to the proposal's exact revision. Trust is `reported` (agent), `human_attested`, or `runtime_verified` (observed by Cruce itself, e.g. preview smoke checks).
- **Promotion**: non-forced advance of `main` in the canonical repository from `from` to `to`; optionally deploys the same revision to production in the same human decision.
- **Environment** (preview, production) with a target: a Cloudflare Worker (deploy repository + Workers Builds) or an external description (Kubernetes etc., record only). **Deployment** records the exact revision, environment, proposal/promotion, build, URL, previous revision and evidence.
- **ResourceAccount**: operator (Cruce is deployed in this account) or connected (another account via REST). Credential sealed with `CRUCE_SECRET`, never returned.
- **ResourceRequest**: a resource action awaiting, or decided by, a human.
- **Policy**: promotion policy (approvals, required trusted evidence) plus resource policy (allow / approval / deny per action, count budgets). Versioned; changes invalidate readiness.
- **Lineage**: `PlatformController.trace(subject)` walks intent → mission → revision → artifacts → proposal → verification → promotion → deployment and back. `explainRevision` answers which proposal, mission, intent and agent produced an accepted revision.

## Cruce MCP

`src/shared/tools.ts` is the single catalog: name, description, scope, control/resource class, cost class, resource action and input fields. The remote MCP server (`src/worker/mcp.ts`) and the local bridge (`runner/cruce.ts`) register from it; a connection only sees tools its scopes allow. HTTP commands go through the same `authorizeMachine` check, and human decisions (`promote_proposal`, `decide_proposal`, `set_policy`, `decide_resource_request`, `configure_environment`, `deploy_revision`, `plan_rollback`, `resolve_review`) are never reachable by agents.

Cruce MCP expresses development intent, not infrastructure commands: `request_preview(proposal)` makes Cruce check the revision, Worker compatibility, scopes, policy, budgets and the connected account before it pushes anything. There are no `create_worker`, DNS, zone, D1, R2 or log tools; Cloudflare's own MCP servers cover administration.

## Control and resource actions

`src/core/capabilities.ts` is pure: scopes, cost classes (`none`, `local`, `artifacts`, `metered`, `metered_production`), resource actions (`workspace.create`, `revision.publish`, `artifact.publish`, `preview.deploy`, `production.deploy`, `ai.inference`), default policy and `evaluateResource`. Budgets turn an allowed action into a human approval when exhausted. Production deployment is always human. Cloud AI (Jev semantic analysis) runs only when policy allows `ai.inference`.

## Publishing real Git history

Agents commit locally. `publish_revision` from the bridge sends a non-thin Git pack of `workspace head..HEAD`; the Control Tower imports it, checks the revision descends from the workspace head and contains the latest plan baseline, runs the deterministic publication decision on the actual diff, and pushes the exact revision to the workspace fork with a 60-second token. The recorded revision is the agent's commit. Reconciliation with a newer accepted revision happens locally with normal Git; Cruce never rewrites agent commits. A bounded files mode remains for clients without a local repository; then Cruce authors the commit.

## Deployment

The deploy repository is separate from the canonical repository so that promotion (accepted source) and deployment remain separate decisions, and so that Workers Builds' "main is production" rule does not auto-deploy every promotion. Cruce force-updates only that deployment mirror; source history lives in the canonical repository. Workers Builds connection to the deploy repository is a dashboard step (the Builds API does not yet expose Artifacts repository connections); Cruce reads build status, commit and preview URL through the Builds API with the sealed account token. `DeploymentWorkflow` provides durable waiting and retries; all decisions stay in the Durable Object.

## Key decisions

- One Durable Object per project is the single authority; `src/core` is pure with injected time.
- Agents never hold Artifacts write tokens; server-issued 60-second tokens are revoked after each operation.
- Reads never consume resources; provisioning, publishing, previews and deployments are policy-checked actions.
- Verification must name the exact revision; agent evidence never masquerades as runtime-verified execution.
- Babel structural index in the Worker; unresolved symbols never widen permissions.
- Namespaces separate environments: `cruce-dev` (local) and `cruce` (production).
- The legacy cloud agent runtime (Claude Code in Cloudflare containers) was removed: Cruce coordinates agents, it does not run them.

## Deterministic demo (`/demo`)

The original coordination demo remains for illustration: a scripted three-agent story on `demo/auth-service` that shows deterministic scheduling, partial clearance, a gated publish, an amendment, merges with Git notes and a stale → refresh → re-plan → land cycle. It uses the legacy Flight controller (`src/core/controller.ts`, `src/worker/tower.ts`, `src/worker/project-git.ts`) under `/api/demo/*`, with a local Git backend offline or Artifacts forks online, and keeps reproducible commit ids from a fixed clock. Its vocabulary (Flight, landing, airspace) is internal to the demo, not the native product contract. See [demo](demo.md), [controller model](controller-model.md) and [demo resource cleanup](flight-cleanup.md).
