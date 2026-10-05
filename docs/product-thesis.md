# Product direction

Cruce helps one developer keep several agents working coherently on the same repository, with clear human control over what lands.

The initial customer is a developer who already runs concurrent agent workspaces, potentially across different tools or machines, and spends time relaying updates, reconstructing progress, reconciling stale work and reviewing results. The benefit should grow when tasks interact. A developer using one agent, or several agents doing unrelated work, may receive little benefit beyond their existing tools.

Namespace → Repository → Workspace remains the product model: ownership, code identity, then participation in bounded work. A personal namespace and one repository are the initial evaluation setting. Shared namespaces, membership and multiple repositories remain supported without becoming prerequisites for the first useful experience.

## The problem to prove

Separate checkouts protect participants' working files. They do not by themselves establish a shared record of active work, relevant upstream changes, verification evidence and human acceptance across connected tools. A developer can assemble that record with Git, scripts and communication; Cruce must reduce that effort enough to justify its own setup and cost.

For example, one agent changes an authentication contract while another changes workspace storage against the previous contract. Both may finish in isolated worktrees. Their changes can merge cleanly while the combined behavior is wrong. The developer needs to understand the dependency, reconcile the work and verify the resulting revision.

Today's Cruce exposes reported path overlap and upstream revision changes. Those signals can support reconciliation, but they do not reliably identify semantic dependencies or prove compatibility. Structural indexing supplies source context; it is not an authority or a semantic conflict detector.

## Existing alternatives and differentiation

As reviewed on 2026-10-05, Claude Code supports isolated worktrees, workspace resumption and agent teams with shared tasks and communication. GitHub supports required reviews, revision-bound checks and merge queues. Isolation, messaging and safe merging are established capabilities rather than unique claims for Cruce. See [Claude worktrees](https://code.claude.com/docs/en/worktrees), [Claude agent teams](https://code.claude.com/docs/en/agent-teams) and [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

Cruce's hypothesis is that a repository-wide record spanning connected tools, machines and successive Workspaces can make concurrent work easier to understand and accept. It needs to remain useful as individual agent tools improve their own coordination. Supporting more agents or displaying their status is insufficient evidence of product value.

| Developer need | Current foundation | Benefit to validate |
| --- | --- | --- |
| Understand concurrent work | Workspaces, actor identity, presence freshness and reported paths | Less status checking and manual relaying |
| Reconcile work after source advances | Upstream inspection, safe explicit fetching and immutable starting revisions | Less work performed against stale assumptions |
| Decide which changes to accept | Exact source artifacts, revision-bound reviews and labelled verification evidence | Less effort reconstructing what was reviewed and tested |
| Continue after a participant stops | Retained published commits, artifacts, context and provenance | Less effort recovering or handing off work |

Participation and reporting remain cooperative. Cruce cannot observe an unconnected agent or guarantee that an agent reads an update. Published source survives Workspace completion; unpublished local work remains in its local execution context. Retained records do not recreate an agent's full conversation or reasoning.

## Intended daily workflow

1. The developer creates a canonical Artifacts repository in a connected namespace, clones with Git and authorizes participants. Attaching a local checkout does not silently upload history.
2. Each agent starts bounded work at an exact revision and uses its dedicated worktree. Cruce records who is working and what they report changing.
3. At useful checkpoints, participants inspect overlap and relevant upstream updates. They can continue editing without mandatory plans or scheduling clearance.
4. When source advances, a writer explicitly fetches available objects, merges with normal Git, resolves conflicts and verifies the resulting revision.
5. A published source artifact pins the exact result and its review base. The developer reviews evidence and decides what to accept. Deployment is a separate decision.

The console should make active work and decisions needing attention understandable. The agent interface should provide actionable repository context through the shared MCP catalog. Neither should require the developer to operate a separate agent runtime inside Cruce.

## Role of hosted forks

Agents continue executing locally in isolated worktrees or clones. Artifacts provides every repository’s canonical history and each writer workspace’s durable fork. One hosted writer Workspace reuses its own fork across publications, with namespace ownership and budget control. A tool such as Claude Code or Codex can have multiple independent Workspaces and therefore multiple forks; it does not receive a permanent product-wide fork.

Forks support isolated access and retained exact source. The developer benefit must be easier sharing, inspection, recovery or reconciliation. The fork provides durable isolation; Cruce supplies coordination and human-controlled integration. See the [artifact model](artifacts-model.md).

Use Cloudflare capabilities deliberately to strengthen this workflow. Prioritize retained exact source and live reconciliation; evaluate push events for timely relevant updates and native file/history reads for focused context. Git notes and ArtifactFS are later options if portability or checkout startup becomes a measured problem. The [Cloudflare strategy](cloudflare-strategy.md) records the capability mapping, implementation status, costs and limits. Platform features do not automatically establish semantic coordination or justify cloud execution of agents.

## Validation and boundaries

The initial goal is to demonstrate less human coordination time, less rework caused by duplicated or stale work and less effort accepting verified results. Compare equivalent multi-agent tasks with ordinary worktrees and Git review, using the same tools and comparable task difficulty. Count setup, publication and operating costs alongside any savings. See the [plan](PLAN.md) for the pilot and decision criteria.

Wider parallel-agent adoption is plausible, but its timing and Cruce's advantage are unproven. Do not present Cruce as the inevitable future of Git. If the pilot adds bookkeeping without reducing the developer's effort, simplify the flow or revise the thesis before expanding scope.

Private access, stable IDs, current authorization, sealed credentials, retained provenance and clear observation trust remain foundations. Cruce coordinates participants; it does not launch agents, provide coding chat or an editor, mandate scheduling, automatically resolve semantic conflicts, or add a general workflow engine. Public signup, GitHub/GitLab integrations and automated external merges/pushes remain outside this foundation. Cruce is a working name.
