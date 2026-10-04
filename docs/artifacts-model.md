# Artifacts model

Cloudflare Artifacts is the canonical home of every Cruce project's Git state. Cruce is structurally aware of it: refs, commits, ancestry, trees, changed files, diffs, merges and forks. External hosting (GitHub, GitLab) is future import/export/mirroring only.

```text
project-<id>                       canonical repository; main = accepted source (one per project)
  │  promotion = non-forced advance of main to a proposal's exact revision
  ├─ project-<id>-baseline-<sha16> immutable snapshot of an accepted revision
  │     └─ project-<id>--w-<n>     one fork per mission workspace (agent commits land here)
  ├─ project-<id>--evidence        immutable evidence artifacts (typed reports, preview checks)
  └─ project-<id>--deploy          deployment state, in the project's resource account:
                                   main = production, cruce/proposal-<N> = Worker Preview
```

- **Canonical revision**: the head of `main` in the canonical repository, tracked by the Control Tower and re-verified on Artifacts push events. Movement made outside Cruce is reported as `unexpected_revision`, never accepted silently.
- **Mission ↔ workspace**: `start_mission` pins the mission's base to an accepted revision (the canonical head, or an ancestor in accepted history) and forks a workspace from an immutable baseline snapshot. Tool handoff keeps the same fork; experiments get their own missions and forks.
- **Revision as anchor**: source artifacts record the exact commit, its parent, the commits in `base..revision` and the number of changed files. Evidence artifacts, verifications, reviews, promotions and deployments all name a revision.
- **Proposal**: exact base and proposed revision, workspace repository, commit and file counts. A newer proposal from the same mission supersedes the open one.
- **Verification**: always targets the proposal's exact revision; trust is reported, human attested, or runtime verified.
- **Deployment**: the deploy repository mirrors deployment state only. Cruce pushes the exact revision; Workers Builds builds it; Cruce records build, URL and its own smoke checks. Production can move back to an earlier accepted revision (rollback) without rewriting accepted history.

## Credentials

| Token | Scope | TTL | Holder | Revoked |
|---|---|---|---|---|
| `create()` / `fork()` initial token | write | ~1 year / 24 h | — | immediately |
| Git operation token (fetch / push / promote / deploy) | read or write | 60 s | Control Tower | right after the operation |
| Connected-account API token | Workers Builds read, Scripts read, Artifacts edit | owner-defined | sealed in the project's Durable Object | on disconnect (and at Cloudflare) |

Agents never receive Artifacts write tokens. Local agents publish commits as Git packs through Cruce MCP; Cruce verifies and pushes them. Source checkout and refresh use Cruce's export of real Git objects.

## Immutability and retention

Accepted history is never force-pushed. Export preserves real Git objects. Workspace forks and evidence are retained after missions complete: execution completion is not permission to delete historical artifacts. Ownership (repository description and source) is checked before writing or deleting resources.

## Deterministic demo (`/demo`)

The following documents the demo's Flight forks, Git notes, deterministic landing and ownership-safe cleanup.

Cruce is built around Cloudflare Artifacts' premise: create isolated Git repositories at the scale of
projects, sessions, tasks, and agents; persist the code *and the context* agents produce; fork many
isolated repositories from a common starting point; compare and merge results later.

```
                 cruce/auth-service            ← canonical project repository (accepted state)
                        │  common baseline
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
 auth-service--f021  auth-service--f022  auth-service--f023     ← one fork per Flight
   (own history, refs, tokens, lifecycle, Git notes)
```

Namespaces: `cruce-dev` (local development), `cruce` (production). Repository names follow the Artifacts
rules (letters, digits, `.`, `_`, `-`). Humans see `F-021 · Refresh-token rotation`, not repo names.

## Canonical repository

- Created through the Workers binding (`env.ARTIFACTS.create`) on first use of a project; the ~1-year token
  returned by `create()` is revoked immediately.
- Seeded by Cruce with a reproducible baseline commit (fixed author/committer timestamps in demo mode).
- Only Cruce writes to it: landings are merge commits pushed with a 60-second write token.
- Cruce keeps a mirror in its Durable Object (bare isomorphic-git workspace on SQLite) and fetches
  incrementally with 60-second read tokens.

## Flight repositories

- `repo.fork(name, { defaultBranchOnly: true })` from canonical when the Flight is provisioned; the 24-hour
  write token returned by `fork()` is revoked immediately.
- Cruce stores: repository id, namespace, name, remote URL, base commit, fork source, created time, head.
- Demo agents are scripted; no agent holds a token.

## Token lifecycle

| Token | Scope | TTL | Holder | Revoked |
|---|---|---|---|---|
| `create()` / `fork()` initial token | write | ~1 year / 24 h | — | immediately |
| Git operation token (fetch / push / land / refresh) | read or write | 60 s | Cruce (Durable Object) | right after the operation |

Artifacts emits `token.created` / `token.revoked` events for each; Cruce records them in its audit log, so
every publish shows up as *token.created(write) → pushed → token.revoked*.

## Publish → push

1. The scripted agent sends `{ parent, files, message }`.
2. Cruce rebuilds the commit in its workspace from the parent tree + files (same commit id when the agent
   supplies its own metadata) and computes the real diff.
3. The publish gate maps changed line ranges to symbols and checks them against the current clearance.
4. Approved → 60 s write token → push to the Flight repo (`main`) and `refs/notes/cruce` → revoke.

## Git notes (`refs/notes/cruce`)

Flight commits carry `kind: "flight-commit"` notes (Flight, mission, agent, plan version, baseline, plan objective,
clearance at publish time, gate verdict, touched airspace). Landing merge commits carry `kind: "landing"`
notes: task, plan objective, plan amendments with reasons, the coordination decisions that affected the Flight
(clearance changes, holds, yields, overrides, staleness), congestion and right-of-way, validation result,
and the preflight (merge-base, clean, baseline behind). No secrets, tokens, or transcripts.

Notes are pushed explicitly (`refs/notes/cruce:refs/notes/cruce`) alongside the branch; verify with:

```sh
git fetch origin 'refs/notes/cruce:refs/notes/cruce' && git notes --ref=cruce show HEAD
```

## Events

| Subscription | Source | Events | Created |
|---|---|---|---|
| account | `artifacts` | `repo.created`, `repo.forked`, `repo.deleted`, `repo.imported` | once (setup) |
| per repository | `artifacts.repo` + `namespace` + `repo_name` | `pushed`, `token.created`, `token.revoked` | canonical at bootstrap; each Flight at provisioning; removed by durable Flight cleanup |

Destination: queue `cruce-artifact-events` → Worker `queue()` → filtered by namespace → routed by repo
name (`<repo>` or `<repo>--fNNN`) to the project's ControlTower → deduplicated by
`(type, repo, after|tokenId, eventTimestamp)`. A `pushed` event on a Flight repo confirms (or, if it does
not match an approved publish, flags) the push; pushes to canonical confirm landings.

## Landing and refresh

- **Preflight**: non-destructive three-way merge of the Flight head into the latest canonical in the
  workspace (`merge-base`, conflicts, changed paths, whether the Flight's baseline is behind).
- **Land**: real merge commit on canonical + landing note → pushed (branch + notes) → canonical re-indexed
  → other Flights re-evaluated.
- **Refresh** (stale Flight): canonical is merged into the Flight's branch and pushed to the Flight repo, so
  the agent's published work is preserved and it re-plans on the new baseline.

## Import (onboarding existing repositories)

The binding supports `env.ARTIFACTS.import({ source: { url, branch, depth }, target: { name } })`; a project
can start from any HTTPS Git remote and Flights fork from the imported canonical. The MVP ships with a
seeded demo repository; import is a straightforward extension of `ArtifactsHost.ensure`.

## Cost discipline

Artifacts bills repository operations and storage. Cruce keeps operations low: incremental fetches into a
persistent workspace, remote URLs cached, one fork per Flight, short-lived tokens only when needed, demo
resets rate-limited (one per 45 s per project). Cleanup adds canonical verification, token revocation,
repository deletion, and subscription removal; retry batches and reconciliation pages are bounded.

## Flight lifecycle

Landed repositories are deleted after canonical commits and notes are verified. Unsuccessful Flights
retain published work for 24 hours, with an explicit keep-for-recovery override. Execution resources
and tokens are released immediately. A durable ownership ledger survives resets and interrupted
provisioning; alarms retry failed cleanup and reconcile owned resources daily. See
[Flight resource cleanup](flight-cleanup.md) for recovery, migration, and review behavior.
