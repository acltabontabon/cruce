# Documentation

[Project README](../README.md) · [Contributing](../CONTRIBUTING.md) · [Changelog](../CHANGELOG.md)

Cruce coordinates durable concurrent Git work through **Namespace → Repository → Workspace**. Your tools execute the work; Cruce records its baseline, concurrent relationships, retained revisions and human-approved path into canonical Git.

## Use Cruce

Start with [Git and bridge setup](native-setup.md) to install once per machine, clone or attach a checkout, work in an isolated workspace and publish for review. Use the [console walkthrough](local-demo.md) for a no-cloud tour. Integrators should then read [MCP participation](mcp.md) for tools, scopes, reports, review notes and retries.

The current implementation supports new canonical repositories, independent reusable workspace forks, ordinary Git transport, replaceable local attachments, advisory overlap, exact-revision publication/evidence/review, human promotion, retained history and explicit cleanup. It also has opt-in pushed-ref observation and bridge coordination updates. Forge import/upstream publication and agent execution are outside the current functionality. [Verification](local-verification.md#current-evidence-at-a-glance) distinguishes implemented behavior from hosted acceptance.

## Understand or change Cruce

Read these in order when changing domain behavior:

1. [Product](product.md): purpose, users, boundaries and non-goals.
2. [Domain model](domain-model.md): vocabulary, lifecycle, exact revisions and authority.
3. [Principles](principles.md): design constraints and review rules.
4. [Architecture](architecture.md): current components, Git lifecycle, storage, recovery and limitations.

Use [Contributing](../CONTRIBUTING.md) for development and checks, [design](design.md) for console interaction, and [decision records](decisions/README.md) for consequential rationale. [AGENTS.md](../AGENTS.md) summarizes repository instructions. [The roadmap](../ROADMAP.md) contains candidates, not implemented behavior or work instructions.

## Install and operate Cruce

| Task | Guide |
| --- | --- |
| Configure the Worker, Artifacts binding, Access and observation queues | [Cloudflare setup](cloudflare-setup.md) |
| Understand the configured test installation and last recorded deployment | [Test environment](test-environment.md) |
| Verify a change and interpret local/provider/hosted evidence | [Verification](local-verification.md) |
| Recover uncertain operations, storage identity or missing cached source | [Operations](operations.md) |
| Package the local client or release Cruce's own Worker | [Releases](releases.md) |

Each guide owns one kind of information. Current behavior belongs in its guide, rationale in decision records, acceptance in verification, future candidates in the roadmap and user-facing changes in the changelog. Detailed implementation/deployment chronology stays in Git history. Keep existing guide paths stable when reorganizing; link to contracts and commands rather than copying their schemas.
