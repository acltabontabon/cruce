# Demo

Two modes share the same controller, Git integration, and Radar:

- **Demo mode** (`project=demo`): three scripted agents, one deterministic story, on real Artifacts.
  Every decision is the controller's; the script only says what each agent *attempts*. Commit ids are
  reproducible across runs.
- **Live mode** (`project=live`): real Claude Code agents — external runners on a developer machine or
  Cloudflare Sandboxes — filing their own Flight Plans.

## Driving the demo

Open https://cruce.acltabontabon.workers.dev (or `pnpm exec cf dev` → http://localhost:5173).

| Control | |
|---|---|
| ▶ / ❚❚ | play / pause (auto-advances with realistic gaps) |
| ⏭ | next step (best for recording: narrate, then step) |
| ⟲ | reset: deletes the Flight repos, returns canonical to the seed commit (rate-limited to 1 / 45 s) |
| 0.5×–3× | speed |
| `main @ sha` | canonical history with Cruce notes |
| hover / click a Flight | isolates its route; context panel shows route, clearance, why, Git |
| click a ringed node | congestion detail: why, right-of-way, traffic plan, controls |

## The story (18 steps)

| # | Step | What Cruce does |
|---|---|---|
| 1 | Three Missions are delegated | F-021 refresh-token rotation, F-022 JWT library migration, F-023 session cleanup |
| 2 | Each Flight gets its own Artifacts fork | `auth-service--f021/22/23` forked from canonical; fork tokens revoked |
| 3 | Discovery | agents read; no airspace claimed yet |
| 4 | F-023 files its plan | independent → **CLEAR** automatically |
| 5 | F-022 files its plan | contract change on `TokenValidator.validate` → **CLEAR** |
| 6 | F-021 files its plan | wants to modify `TokenValidator.validate` and assumes its contract is stable → congestion (L1 structural + L3 contract, critical). **F-022 has right-of-way (contract owner).** F-021 → **PARTIAL CLEARANCE**: ✓ `AuthService.refreshToken`, ✓ `RefreshTokenRepository`, × `TokenValidator.validate` |
| 7 | Flights execute | F-021 keeps working on the cleared parts |
| 8 | F-023 publishes | publish gate approves; 60 s token → push → revoke; tests reported |
| 9 | F-021 tries to publish beyond its clearance | gate **rejects**: `AuthService.logout` is outside the cleared route |
| 10 | F-021 requests airspace | plan amended (+ `AuthService.logout`) → re-evaluated → cleared |
| 11 | F-021 publishes its cleared work | approved (still PARTIAL: validate on hold) |
| 12 | F-022 publishes | approved |
| 13 | **F-022 lands** | preflight clean → real merge into canonical + note → **F-021 STALE**: "TokenValidator.validate contract changed", "assumption no longer holds" |
| 14 | F-023 lands | independent; F-021 unaffected |
| 15 | Cruce refreshes F-021 | canonical merged into `auth-service--f021` (its published work preserved) |
| 16 | F-021 amends its plan (v3) | `TokenValidator.validate` is now a **read** (F-022's ValidationResult carries the token id) → **CLEAR** |
| 17 | F-021 publishes the rotation | approved |
| 18 | F-021 lands | canonical has all three Flights; history + notes show every decision |

Why the sequencing mattered: F-021's final code uses F-022's new `ValidationResult`. Run
`bash demo/scripts/verify-scenario.sh` — F-021's last step **fails its tests on the old baseline** and
passes after F-022 lands. Cruce avoided that rework before any code collided.

## Video script (5–10 min)

1. **The problem (0:00–0:45).** "Parallel agents are easy to isolate — every agent gets its own
   Artifacts repo. Nothing coordinates their *future* work." Show the empty radar and the canonical repo.
2. **Delegate three Missions (0:45–1:30).** Steps 1–3. Point at the three forks in the Artifacts
   namespace and the read-only discovery.
3. **Plans appear (1:30–2:45).** Steps 4–6. F-023 clears instantly ("independent traffic needs no
   human"). F-022 clears. F-021 files — the `validate()` node lights up, the dashed HOLD route appears.
   Click the congestion: *why they intersect*, *right-of-way: contract owner*, *traffic plan*.
   "The platform knew these two agents were about to interfere before they wasted the work."
4. **Partial clearance (2:45–3:45).** Hover F-021: two cleared routes, one held. "It didn't stop F-021.
   It let it work around the contested area." Steps 7–11: the publish gate rejects `logout`, the agent
   amends, the gate approves. Mention tokens: agents never hold write credentials.
5. **Landing changes the airspace (3:45–5:00).** Steps 12–15. F-022 lands: F-021 turns STALE with the
   exact reasons; Cruce refreshes its baseline.
6. **Adaptation (5:00–6:00).** Steps 16–18. Plan v3: validate becomes a read → CLEAR → lands.
7. **Proof (6:00–7:30).** Open `main @ sha` history: merge commits, notes with plan amendments and
   coordination decisions. Run `tools/verify-repo.sh auth-service cruce` (plain git clone of Artifacts,
   15/15 tests). Show the tower log's Artifacts events: token.created → pushed → token.revoked.
8. **Live mode (7:30–9:00).** Three real Claude Code Flights on `project=live` (runner or Sandbox):
   real plans, real congestion, an agent saying "I left these alone… that change is on hold".
9. **Close.** "Artifacts gives every agent its own safe repository. Cruce decides how all of those
   agents should move together."

## Live mode

```sh
export CRUCE_ADMIN_TOKEN=…        # controller token
node runner/cruce-runner.ts --url https://cruce.acltabontabon.workers.dev --project live \
  --title "JWT library migration" --description "…" &
node runner/cruce-runner.ts --url https://cruce.acltabontabon.workers.dev --project live \
  --title "Refresh-token rotation" --description "…" &
node runner/cruce-runner.ts --url https://cruce.acltabontabon.workers.dev --project live \
  --title "List a user's sessions" --description "…" --priority low &
```

Each runner launches a Flight (fork), clones it read-only, and runs `claude -p` with a restricted tool
allowlist (edits, `cruce`, tests). The agent files its plan with the `cruce` CLI, works inside its
clearance, requests airspace when it needs more, and Cruce publishes, validates, sequences, and lands.
Live behaviour depends on the model; the deterministic demo is the reliable recording path.
