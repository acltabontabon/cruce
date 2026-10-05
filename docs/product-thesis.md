# Product thesis

[Documentation map](../README.md#documentation-map) · [Principles](principles.md) · [Architecture](architecture.md)

Cruce coordinates independent, heterogeneous coding agents working concurrently on the same repository. The initial evaluation setting is one developer, one repository and two or three agents using their existing tools. Shared namespaces and multiple repositories remain supported; neither is a prerequisite for proving the coordination benefit.

## The problem above isolation

An individual agent can use worktrees to separate its own tasks. That protects working files, but it does not establish a common record across independently authorized tools, machines and successive participants. A developer still has to discover what is happening, relay upstream changes, reconstruct what was tested and decide what can converge safely.

Cruce starts where individual-agent isolation ends. Its useful unit is concurrent repository work, independent of which agent vendor performs it. An authorized agent can participate in several workspaces; each workspace belongs to one actor, and each writer workspace owns one reusable direct fork of canonical. Local execution contexts materialize that durable work in worktrees or clones. There is no permanent fork per vendor and no privileged coordinating agent.

For example, a Codex participant might change an authentication contract while a Claude Code participant updates a caller against the previous contract. Both can finish in isolated worktrees. Their changes may share no paths and merge cleanly while the resulting behavior is wrong. Cruce can expose reported path overlap, accepted-source updates and the exact source/evidence under review. It cannot infer every dependency, force an agent to read context or prove behavioral compatibility.

| Need | Current mechanism | Limit |
| --- | --- | --- |
| Know who is working and where | Workspaces, actor connections, presence and reported paths | Cooperative reporting; disconnected or unconnected work may be absent |
| Recognize relevant source changes | Upstream revision inspection and advisory path overlap | No automatic semantic conflict resolution or reliable dependency detection |
| Reconcile independent results | Normal Git fetch/merge, retained source and fresh publication | Participants resolve conflicts and verify the resulting revision |
| Decide what lands | Exact-revision changes, reviews, evidence and human promotion | Passing checks do not guarantee correctness |
| Recover published work | Retained commits, source artifacts and provenance | Uncommitted local files and full agent conversations are not retained |

## Boundaries

Cruce’s responsibility ends when isolated concurrent work is safely reviewed and reconciled into the canonical Git repository. CI, build/release orchestration, deployment, environment management, rollback and runtime operation belong to external systems.

| Cruce is not… | Consequence for the design |
| --- | --- |
| A replacement for Git or Git worktrees | Reuse Git commits, branches, history, diffs, merges and checkout isolation |
| A Claude Code worktree manager | Coordinate independent tools through a common repository model; client-specific setup is an adapter |
| A GitHub or GitLab clone | Hosting exists to support isolated work and exact source; do not expand into a general forge |
| A remote IDE or cloud coding environment | Editing and agent execution remain in participants' existing environments |
| An AI agent runtime | Do not launch agents, select their models or own their conversations |
| A generalized agent orchestration platform | No agent task scheduler, mandatory plans, autonomous delegation or general workflow engine |
| A CI/CD, deployment or runtime platform | Record revision-linked review evidence; external systems own builds, releases, environments, deployment, rollback and runtime operation |
| Another command language over Git | Use Git for source transport and manipulation; Cruce operations add coordination meaning |
| A requirement to abandon normal Git workflows | Preserve existing remotes and require explicit publication; ordinary local editing needs no Cruce clearance |

Normal Git does not mean unrestricted writes to every remote. The current architecture requires authoritative canonical Git storage backed by Cloudflare Artifacts and protects its accepted branch through human-reviewed promotion. Writers push normally into their own forks. GitHub/GitLab integrations and local-only canonical hosting are outside the current foundation. An arbitrary existing checkout is not automatically imported or identified by its remote URL.

## The coordination loop

1. A human authorizes independent participants against a stable repository ID.
2. Writers start from exact commits in dedicated worktrees or clones and report bounded work.
3. Participants inspect other work, overlap and upstream changes at useful checkpoints.
4. Writers commit and push with Git, then publish exact source and evidence for review.
5. A human reviews that revision and advances canonical source when ready.
6. Other writers explicitly fetch, integrate, verify and publish a fresh result. Earlier artifacts and reviews remain intact.

The console supports understanding work and making decisions: Overview, Code, Work, Artifacts and Settings. Namespace membership and account configuration have their own scope. Coding chat, an editor and intake forms do not belong in this flow.

## What must be proven

The mechanisms above describe the current design, not proven product value or live interoperability; [verification](local-verification.md) owns those claims. The hypothesis is less human coordination time, less duplicated or stale work and less effort accepting verified results. More agents, more status panels or more hosted forks are not evidence of value. A developer already coordinating one tool's independent tasks may gain little.

Compare matched tasks using ordinary worktrees and Git review with the same tasks using Cruce. Count setup, reporting, cloud resources and interruptions as costs. The [roadmap](../ROADMAP.md) collects candidate improvements and explains the pilot and decision criteria used to prioritize them. Cross-tool interoperability and useful context consumption must be demonstrated with real participants; generated client configuration alone proves neither.
