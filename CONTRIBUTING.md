# Contributing to Cruce

Thank you for being here. Before the commands and checklists, here is the picture we are building toward.

## The future we're building for

Software has gone from written, to assisted, to agentic. Soon it will be normal for one developer to have several agents working at once, across tools and machines, and for a team of developers to do that together in the same repository. Code will be cheap and fast to produce. Deciding what becomes canonical will not.

Cruce exists for that world. It began as a figment of one person's imagination: developers and their agents working hand in hand, with Git still underneath, and humans still deciding what lands. Every contribution is a small piece of making that future feel calm instead of chaotic.

Contributing here also means living in that future a little early. Many of us build Cruce with coding agents. Your agent is welcome too, and [AGENTS.md](AGENTS.md) gives it the same ground rules this guide gives you. The work that comes in still lands the way Cruce says it should: as an exact revision a human has read and approved.

## What we care about

These ideas shape every change. The [principles](docs/principles.md) state them precisely; here they are in plain words.

- **The human decides.** Agents can write, reply and propose. Only an authenticated person approves an exact revision and promotes it. Nothing we build should blur that line.
- **Git stays Git.** People keep their clone, commit, merge and push. Cruce adds memory and judgment around Git, never a replacement for it.
- **Work outlives the session.** A workspace belongs to a person, not to the process or machine that happened to run it.
- **Honest, boring signals.** Overlap is a heads-up, never a verdict. An unknown stays unknown. We prefer trustworthy primitives over clever guesses.
- **Cruce coordinates; others execute.** We never launch, schedule, message or pause agents, and never store prompts or conversations. If Git worktrees plus an agent tool would already give you a feature, it doesn't belong here. That's the [boundary test](docs/product.md#the-boundary-test).
- **Plain words.** The console and the docs talk like a thoughtful teammate, not a manual.

Cruce is early, so we remove ideas that no longer fit instead of keeping compatibility layers for them.

## Set up and explore

You need Git, Node 22.18+ and pnpm (CI uses Node 24 and pnpm 12.4.2). From the repository root:

```sh
pnpm install --frozen-lockfile
```

```sh
pnpm dev:fixture
```

Open the printed loopback URL. The fixture runs the real console and controllers over deterministic Git source with a fixed clock; sign-in and the cloud provider are simulated, and it uses no cloud resources. It's the quickest way to feel how Cruce works: concurrent workspaces, the lane map, overlap, review notes, promotion and history. The [console walkthrough](docs/local-demo.md) tours each page.

To run the actual Worker locally:

```sh
pnpm exec cf dev --mode offline
```

Offline mode avoids cloud provisioning but still expects Access. Use the fixture for UI work. For authenticated Worker work, follow [Cloudflare setup](docs/cloudflare-setup.md); [.env.example](.env.example) and [.dev.vars.example](.dev.vars.example) name the settings. Keep real credentials out of tracked files.

## Find your way around

Start with the [product](docs/product.md) for the why, the [domain model](docs/domain-model.md) for the words we use, and the [roadmap](ROADMAP.md) for what's open.

| If you're changing… | Start here |
| --- | --- |
| Ownership, permissions, readiness, resource policy | `src/core` and `test/core` |
| Authentication, persistence, Git transport, provider adapters | `src/worker`, `test/worker`, `test/git` |
| Shared contracts and the MCP catalog | `src/shared/platform.ts`, `src/shared/tools.ts` |
| The local bridge, isolation and credentials | `runner`, `test/runner` |
| The console | `src/ui`, `test/browser`, and the [design guide](docs/design.md) |
| Reproducible examples | `src/demo`, `demo`, `tools/verify-scenario.ts` |

A few habits keep the codebase trustworthy:

- Keep `src/core` decisions deterministic, with time and IDs injected, and add controller tests when a decision changes. Use native Git tests for locks, refs, checkout safety and transport.
- The console shows what the server decides about permissions and readiness; it doesn't work them out itself.
- There is one MCP catalog for every client.
- Before touching platform adapters, read the current [Artifacts](https://developers.cloudflare.com/artifacts/llms.txt) and [cf](https://developers.cloudflare.com/cf/llms.txt) docs. Use `cf` and `cloudflare.config.ts`, never wrangler project commands.
- Leave other people's uncommitted work alone, and don't reformat the demo fixtures or change their reproducible commit IDs.
- Keep keyboard navigation, deep links, Back, retries and protection against late responses working.

## Verify

Before committing, run:

```sh
pnpm typecheck && pnpm lint && pnpm test
```

```sh
pnpm test:browser
```

```sh
pnpm verify:scenario
```

```sh
pnpm exec cf build --mode offline
```

`test:browser` uses Playwright Chromium and starts its own fixture server. If Chromium is missing, run `pnpm exec playwright install chromium`. `pnpm release:check` also validates release metadata when the version or changelog changes.

Be precise about what you proved. A passing local suite is not live evidence: hosted publication and promotion count as verified only after they pass in the configured test environment. Say in your review description which checks ran and which didn't, and update [verification](docs/local-verification.md) when the evidence changes.

## Keep the docs true

Each kind of information has one home, so nothing drifts out of sync:

| Information | Home |
| --- | --- |
| Why Cruce exists, its boundaries and non-goals | [Product](docs/product.md) |
| Concepts, lifecycle, provenance and authority | [Domain model](docs/domain-model.md) |
| Rules and reasons to reject a design | [Principles](docs/principles.md) |
| Consequential decisions | [Decision records](docs/decisions/README.md) |
| How it's built today, and its known gaps | [Architecture](docs/architecture.md) |
| Setup for people and their tools | [Native setup](docs/native-setup.md), [MCP](docs/mcp.md) |
| Hosted configuration and the test environment | [Cloudflare setup](docs/cloudflare-setup.md), [test environment](docs/test-environment.md) |
| What has been verified, and how | [Verification](docs/local-verification.md) |
| What might come next | [Roadmap](ROADMAP.md) |
| What changed for users | [Changelog](CHANGELOG.md) |

The [documentation map](docs/README.md) links them all. When behavior changes, update its home and its tests in the same change. Git history is the record of how we got here, so there's no progress log to keep. Write a [decision record](docs/decisions/README.md) only when a choice changes the product boundary, the domain model, authority or a core dependency.

Use the [shared vocabulary](docs/domain-model.md#vocabulary): Namespace, Repository, Workspace, baseline, execution attachment, published revision, proposal, promotion. Sessions, runs and agent tasks are not durable things in Cruce. Mark plans as proposed, keep local and live evidence apart, prefer Mermaid for diagrams, and check links and anchors when you move or delete a page.

Releases and deployment are covered in [releases](docs/releases.md).

Thank you for helping build the place where people and agents work well together.
