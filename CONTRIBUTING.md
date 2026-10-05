# Contributing to Cruce

Start with the [product](docs/product.md), [domain model](docs/domain-model.md), [principles and guardrails](docs/principles.md) and [architecture](docs/architecture.md). [AGENTS.md](AGENTS.md) gives the compact repository instructions for coding agents. Cruce is early; remove obsolete concepts instead of adding compatibility aliases for retired designs.

## Set up and explore

Install Git, Node 22.18+ and pnpm. CI uses Node 24 and pnpm 12.4.2. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:fixture
```

Open the printed loopback URL. This separate fixture uses the real console/controllers and fixed-clock Git objects, with simulated authentication/provider behavior. Explore concurrent work, overlap, source review, published revisions, evidence, membership and responsive navigation. It cannot reach live namespaces. The reusable source overlays under `demo/auth-service` and `demo/scenario` are inputs to deterministic verification, not a second product model.

The [local console walkthrough](docs/local-demo.md) includes curated screenshots and instructions for refreshing them as the console changes.

To run the actual Worker locally:

```sh
pnpm exec cf dev --mode offline
```

Offline mode avoids configured cloud provisioning; it does not bypass Access. Use the fixture for unauthenticated UI development. For authenticated Worker work, configure the public origin, Access issuer/audience and server secret as described in [Cloudflare setup](docs/cloudflare-setup.md). [.env.example](.env.example) and [.dev.vars.example](.dev.vars.example) document configuration names; keep real credentials out of tracked files. Hosted binding checks require an explicitly authorized installation environment. The opt-in REST provider harness still uses its separately authorized test credentials; it does not verify the deployed binding.

## Locate a change

Every change must pass the [boundary test](docs/product.md#the-boundary-test): it should become materially more valuable because Cruce has durable, independently addressable Git workspaces and canonical revision history. Do not add agent execution, scheduling, messaging, editing or CI/CD capabilities. Keep workspaces independent of agent sessions, processes, paths and machines. Do not turn advisory overlap into scheduling or conflict verdicts. Preserve human promotion authority, the exact expected base and provider identity through retries and remote updates. Prefer trustworthy primitives over premature intelligence. The [roadmap](ROADMAP.md) orders candidate work.

| Concern | Start here |
| --- | --- |
| Ownership, permissions, readiness, resource policy | `src/core` and `test/core` |
| Authentication, persistence, Git transport, provider adapters | `src/worker`, `test/worker`, `test/git` |
| Shared contracts and MCP catalog | `src/shared/platform.ts`, `src/shared/tools.ts` |
| Local isolation, bridge and credentials | `runner`, `test/runner` |
| Console and navigation | `src/ui`, `test/browser`, [visual identity and interaction](docs/design.md) |
| Reproducible examples and verification | `src/demo`, `demo`, `tools/verify-scenario.ts` |

Keep core decisions deterministic with injected time and IDs. Add controller behavior tests when changing decisions; use native Git tests for locks, refs, checkout safety and transport. Render server-derived permissions/readiness in the UI. Keep one command catalog for all clients. Before changing platform adapters, read current [Artifacts](https://developers.cloudflare.com/artifacts/llms.txt) and [cf](https://developers.cloudflare.com/cf/llms.txt) docs; use `cf` and `cloudflare.config.ts`, never wrangler project commands.

Preserve pre-existing working changes. Do not reformat the reusable demo source fixtures or change their reproducible commit IDs incidentally. Keep account settings separate from namespace/repository settings, and preserve keyboard navigation, deep links, Back, retry identity and protection against late responses.

## Verify

Before committing, run the repository checks:

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm test:browser
pnpm verify:scenario
pnpm exec cf build --mode offline
```

`test:browser` uses Playwright Chromium and starts its own isolated fixture server. If Chromium is missing, install the matching browser with `pnpm exec playwright install chromium`, then rerun. `pnpm release:check` additionally validates release metadata when version/changelog changes are involved.

See [verification](docs/local-verification.md) for what each layer proves, provider-test resource use and evidence locations. Hosted publication/promotion must pass the configured live test environment before being described as live-verified. A local passing suite, mock or offline build does not satisfy that gate. Record executed and unrun checks in the review description. Update the verification guide when evidence or live status changes.

## Keep the documentation authoritative

The [README documentation map](README.md#documentation-map) is the entry point. Each kind of information has one home:

| Information | Authoritative document |
| --- | --- |
| Product purpose, boundaries and non-goals | [Product](docs/product.md) |
| Concepts, lifecycle, provenance and authority | [Domain model](docs/domain-model.md) |
| Consequential decisions and what they superseded | [Decision records](docs/decisions/README.md) |
| Constraints and reasons to reject a design | [Principles](docs/principles.md) |
| Current domain, components, lifecycles and evidence-backed gaps | [Architecture](docs/architecture.md) |
| User/client setup | [Native setup](docs/native-setup.md), [MCP](docs/mcp.md) |
| Provider configuration and live environment | [Cloudflare setup](docs/cloudflare-setup.md), [test environment](docs/test-environment.md) |
| How to verify and what has been verified | [Verification](docs/local-verification.md) |
| Future direction and candidate ideas | [Roadmap](ROADMAP.md) |
| User-facing changes and released behavior | [Changelog](CHANGELOG.md) |

When architecture changes, update its owning document and corresponding behavioral tests in the same change. Explain the decision, rationale, tradeoff and verification boundary in the review description. Git history preserves that implementation history; do not duplicate it in a progress log. Add a [decision record](docs/decisions/README.md) only when a choice changes the product boundary, the domain model, authority or a core dependency; supersede earlier records explicitly rather than editing their decisions.

Use the [domain vocabulary](docs/domain-model.md#vocabulary) consistently: Namespace, Repository, Workspace, baseline, execution attachment, published revision, proposal, promotion. Do not make session, run, mission or agent task into durable domain objects. Retired names may appear in clearly historical records or unchanged fixture paths, not current setup instructions. Label plans as proposed, distinguish local from live evidence, and link executable schemas instead of copying them. Prefer Mermaid for explanatory diagrams. Check relative links, section anchors and diagrams when moving or deleting documents; merge overlapping material rather than keeping placeholder pages.

For documentation-only work without a commit, check links, diagrams, terminology and lint; run focused existing tests if needed to resolve behavior, and report exactly which suites ran or were omitted. All pre-commit checks above still apply if committing. Release and control-plane deployment are covered in [releases](docs/releases.md).
