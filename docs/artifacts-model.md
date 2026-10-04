# Artifacts model

Cruce is built around Cloudflare Artifacts' premise: create isolated Git repositories at the scale of
projects, sessions, tasks, and agents; persist the code *and the context* agents produce; fork many
isolated repositories from a common starting point; compare and merge results later.

```
                 cruce/auth-service            ← canonical project repository (accepted state)
                        │  common baseline
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
 auth-service--f021  auth-service--f022  auth-service--f023     ← one fork per Flight
   (own history, refs, tokens, lifecycle, sandbox, Git notes)
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
- The Flight's agent (sandbox or external runner) gets **read** access only:
  - Sandbox: the `Outbound` egress policy injects a cached 15-minute read token into `git-upload-pack`
    requests for *this* repository; `git-receive-pack` is refused; the sandbox never sees the token.
  - External runner: `checkout` returns a 15-minute read token, used per command via
    `git -c http.extraHeader="Authorization: Bearer …"` (never stored in a remote or config).

## Token lifecycle

| Token | Scope | TTL | Holder | Revoked |
|---|---|---|---|---|
| `create()` / `fork()` initial token | write | ~1 year / 24 h | — | immediately |
| Git operation token (fetch / push / land / refresh) | read or write | 60 s | Cruce (Durable Object) | right after the operation |
| Sandbox / runner read token | read | 15 min | Cruce egress / runner | on expiry (cached 12 min) |

Artifacts emits `token.created` / `token.revoked` events for each; Cruce records them in its audit log, so
every publish shows up as *token.created(write) → pushed → token.revoked*.

## Publish → push

1. The agent leaves its change uncommitted (sandbox) or sends `{ parent, files, message }` (runner).
2. Cruce rebuilds the commit in its workspace from the parent tree + files (same commit id when the agent
   supplies its own metadata) and computes the real diff.
3. The publish gate maps changed line ranges to symbols and checks them against the current clearance.
4. Approved → 60 s write token → push to the Flight repo (`main`) and `refs/notes/cruce` → revoke.
5. The agent resyncs to Cruce's commit (`git fetch` + `reset`) before continuing.

## Git notes (`refs/notes/cruce`)

Flight commits carry `kind: "flight-commit"` notes (Flight, mission, agent, plan version, baseline, intent,
clearance at publish time, gate verdict, touched airspace). Landing merge commits carry `kind: "landing"`
notes: task, intent, plan amendments with reasons, the coordination decisions that affected the Flight
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
| per repository | `artifacts.repo` + `namespace` + `repo_name` | `pushed`, `token.created`, `token.revoked` | canonical at bootstrap; each Flight at provisioning; removed on reset |

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
resets rate-limited (one per 45 s per project). A full demo run is on the order of fifty operations.
