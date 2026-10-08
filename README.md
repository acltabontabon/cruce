<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/wordmark-white.svg">
    <img src="public/brand/wordmark.svg" alt="Cruce" height="56">
  </picture>
</p>

<h3 align="center">Git coordination for parallel agentic development.</h3>

<p align="center">
  Runs no agents · Replaces no Git · Lands nothing without a human
</p>

<p align="center">
  <a href="docs/product.md">Product</a> ·
  <a href="docs/domain-model.md">Concepts</a> ·
  <a href="docs/native-setup.md">Set up</a> ·
  <a href="docs/mcp.md">Agent integration</a> ·
  <a href="docs/local-demo.md">Console walkthrough</a> ·
  <a href="docs/README.md">All docs</a>
</p>

<p align="center">
  <img src="docs/images/readme/hero.jpg" alt="Code is written in parallel now. The decision is still yours. Software went from written, to assisted, to agentic; as many agents write at once, Cruce sits between them and canonical Git." width="880">
</p>

## Why Cruce exists

Cruce began as a figment of my imagination: a picture of how developers will work once software reaches its third generation. Code was first written by hand, then with one assistant at a time. Next, individual contributors work hand in hand with many AI agents that write, commit and push in parallel, across tools and machines. And not alone: several people, each with their own set of agents, share one repository and build it together, while the people stay in charge of what lands.

In that picture, the human job moves from writing every line to understanding, reconciling and authorizing. The developer sets the intent, reviews exact revisions, answers and resolves the agents' work, and decides what becomes canonical. Cruce is my attempt to build the ground that way of working stands on: plain Git underneath, any agent on top, and a durable record in between of where every piece of work began, how it crossed others and who approved it.

## Many paths. One history.

<p align="center">
  <img src="docs/images/readme/story.gif" alt="Animated story: three workspaces branch from baseline c3d8a90, work in Claude Code, Codex and Cursor, overlap on one path, auth is reviewed and promoted, billing reconciles with plain Git and is promoted next while deps keeps working." width="720">
  <br><sub>Seven steps, from the public homepage</sub>
</p>

1. **Baseline.** Every workspace starts from a known canonical revision, and that baseline never changes.
2. **Work.** Each tool commits locally and pushes to its own workspace fork. Nobody waits on anybody.
3. **Overlap.** Shared paths show up early, as advisory context, never as a conflict verdict.
4. **Review.** A human approves one exact revision, not a branch that can move underneath it.
5. **Promote.** Canonical advances with a non-forced Git update to exactly what was reviewed.
6. **Reconcile.** Work left behind merges the new canonical with plain Git, verifies and asks for fresh review.
7. **Continue.** One promotion at a time; everyone else keeps working.

## What you get

### Every workstream on one lane map

<p align="center">
  <img src="docs/images/readme/lane-map.gif" alt="The console lane map replaying a repository's history: main at 4906343f, two workspaces branching from it, change #1 published on Implement retry policy, then promoted back into main." width="880">
  <br><sub>The console's lane map, replaying a promotion</sub>
</p>

- **See where work began.** Every workspace starts from a fixed baseline, so "3 behind" means exactly that.
- **Pick up anywhere.** Close the laptop, switch tools, continue on another machine. The work stays.
- **Spot overlap early.** Shared paths show as a heads-up, never a blocker.
- **Replay history.** Watch work branch, land and rejoin `main`.

### A whole team, each with their own agents

- **One owner per workspace.** Your agents write only to your work.
- **Agents never exceed their person.** Roles and grants are rechecked on every request.
- **One shared picture.** Everyone sees who owns what and where work crosses.
- **A clear record.** Every revision, note and approval names its human.

### Review with your agent, on the exact revision

<p align="center">
  <img src="docs/images/readme/review-notes.gif" alt="Alex opens change #2, where teammate Sam left two line concerns. Alex's Codex agent answered one, citing revision ea0ddcca; Alex checks it, resolves it with a reason, then hands the remaining concern back to the agent." width="880">
  <br><sub>Sam's concern, answered by Alex's agent, resolved by a human</sub>
</p>

1. **Leave a note on a line.** Concerns block promotion; comments don't.
2. **Your agent picks it up** the next time it checks in. Cruce never pings it.
3. **It fixes the code and replies,** pointing at the new revision.
4. **You resolve it.** Only humans can.

Unresolved concerns follow the change until someone resolves them, so republishing can't drop one.

### What you approve is what lands

Approval names one exact revision, never a moving branch. `main` advances only to that revision, with a non-forced Git update. If `main` moved first, the work is merged with plain Git and reviewed again.

## What Cruce is not

One developer running a few agents on one machine is already well served by Git worktrees and local agent tools; Cruce doesn't compete there. Its value grows with agents × developers × machines × concurrent workstreams × duration.

Cruce is **not** an agent runtime, agent scheduler, conversation manager, multi-agent messaging bus, IDE, Git replacement, GitHub/GitLab replacement, CI/CD system, cloud development environment or agent vendor platform. It never launches, pauses, messages or schedules agents, and never stores prompts or conversations. Git stays Git: there is no `cruce push`, and clone, commit, merge and push work as they always have. Any agent or script takes part through [MCP](docs/mcp.md) or the API, and orchestrators can sit above it the same way. See [product boundaries](docs/product.md#non-goals-and-product-boundaries).

## Status

Cruce is early, experimental software. Expect interfaces to change.

## License

Cruce is open source under the [Apache License 2.0](LICENSE).
