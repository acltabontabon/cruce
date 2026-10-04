# Cruce

**An agent-native software development platform.** Humans define intent. Agents perform bounded work. Artifacts preserve source and evidence. Review and policy govern what becomes accepted.

Cruce runs on Cloudflare and Cloudflare Artifacts. It functions independently of GitHub and GitLab. Existing tools such as Codex, Claude Code and Cursor participate through MCP. The human console answers what is happening, what needs attention, what is ready, what changed, and why.

```text
Intent → Mission → isolated Workspace → immutable Artifacts
                                       ↓
                                  Proposal
                                       ↓
                           Verification + Review
                                       ↓
                           Governed source Promotion
```

Source remains inspectable, versioned, diffable and exportable. Agents cannot promote accepted state. Each mission's durable workstream has its own Artifacts fork; switching tools preserves the same workspace and history. Source publication and source promotion are separate boundaries.

## Run locally

```sh
pnpm install
pnpm exec cf dev --mode offline
```

The native console is `/`. Authentication requires configured Cloudflare Access. The isolated deterministic public demo remains at `/demo` and works offline without credentials. Offline fixtures explicitly do not support managed publication or promotion.

For an Artifacts-backed development environment, use `pnpm exec cf auth login`, configure Access as described in [setup](docs/native-setup.md), then run `pnpm exec cf dev`.

## Connect existing tools

```sh
node runner/cruce.ts checkout --url https://YOUR_CRUCE_HOST --system SYSTEM_ID --directory ./payments
node runner/cruce.ts connect --url https://YOUR_CRUCE_HOST --system SYSTEM_ID --client codex --cwd ./payments
```

Use `claude` or `cursor` for their respective client configurations. Continue in the chosen tool; MCP supplies intent, source, policies, coordination, artifacts and proposals. `node runner/cruce.ts check --cwd ./payments` provides a cooperative local check. The bridge neither changes existing branches nor reads normal Git credentials. Connection alone does not establish verified adaptive behavior.

## What is implemented

- Native system membership, Cloudflare Access identity and MCP OAuth.
- Durable intents, specialized missions, sessions, isolated workspaces and handoff.
- Deterministic coordination, partial clearance, plan drift and dependency refresh instructions.
- Managed source publication from actual Git objects, immutable typed evidence artifacts and causal lineage.
- Exact-revision verification, agent disagreement, human review, versioned promotion policy and resumable source promotion.
- Read-only source/diffs/history and accepted-source export. Rollback supplies a forward-change specification requiring the same proposal and verification process.
- Native activity console and navigable lineage graph. The legacy runner/Sandbox remains opt-in compatibility (`CRUCE_LEGACY_RUNTIME=on`).

Jev is an internal bounded adviser. Automatic semantic constraints remain disabled until the required human-labeled evaluation corpus passes. Reported agent results are distinct from human attestations and runtime-verified evidence.

**Release limits:** live Access/MCP/client adaptation, native Artifacts and Jev smoke gates require verification before production rollout. Hosted mission execution, independent runtime verification, environment promotion and releases are not claimed as delivered by this source-promotion slice. Binary outputs and large source transfers need further artifact transport support; current native inputs are bounded text.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm exec cf build --mode offline
bash demo/scripts/verify-scenario.sh
```

Local checks currently pass with 245 tests, typecheck, lint, offline build and the independent scenario verifier. Live release gates remain separate.

See [product thesis](docs/product-thesis.md), [architecture](docs/architecture.md), [Artifacts model](docs/artifacts-model.md), [native setup](docs/native-setup.md), [delivery plan](docs/PLAN.md), [demo](docs/demo.md) and [progress](docs/PROGRESS.md). Historical demo results are separate from verification of the native flow.
