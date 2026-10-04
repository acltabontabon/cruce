# Controller model

Cruce behaves like a concurrency controller + scheduler + dependency graph + lease manager — not a
chatbot. Everything in this document lives in `src/core` (pure TypeScript, unit-tested).

## Flight lifecycle

```
MISSION → DISCOVERY (read-only) → FLIGHT PLAN → TRAFFIC ANALYSIS → CLEARANCE → EXECUTION
            ↑                                         │                              │
            └──── re-plan (stale) ◄── LANDING of another Flight          PLAN AMENDMENT ─┘
                                                                                     │
                                                    VALIDATION → PUBLISH GATE → LANDING
```

An agent may read before clearance; it may not publish meaningful changes before clearance. Phases:
`queued · provisioning · discovery · planned · executing · publishing · validating · landing · landed ·
failed · lost · cancelled`. Clearance is separate: `clear · partial · hold` (+ `stale` overlay).

## Airspace

Canonical resource ids form a strict hierarchy, so overlap is an ancestor check:

```
m:auth                                               module   (from cruce.json or top-level dirs)
f:src/auth/token-validator.ts                        file / component
s:src/auth/token-validator.ts#TokenValidator         type
s:src/auth/token-validator.ts#TokenValidator.validate member
```

Plans name things loosely (`TokenValidator.validate`, `{component: RefreshTokenRepository}`,
`src/x.ts`); the resolver maps names to ids with the structural index. Ambiguous names resolve to the
smallest enclosing resource that covers all candidates (never under-claim). New symbols resolve under
their owner; a component named after its file resolves to the file (companion types travel with it).

Overlap of two resources: `same`, `contains` (ancestor), `same-file` (distinct symbols in one file —
separate airspace), or `none`.

## Access sets

| Set | Meaning |
|---|---|
| readSet | what the Flight depends on |
| writeSet | what it intends to modify |
| contractSet | what it modifies whose externally observable behaviour or signature changes |
| derived reads | static analysis: a Flight writing a file depends on what that file imports |

## Conflict matrix

| A × B (overlapping) | Level | Severity | Control |
|---|---|---|---|
| read × read | — | — | none |
| read × write | 2 dependency | low | caution (re-validated at landing) |
| read × contract | 3 contract | high | **land-after**: both fly; the reader lands after and re-validates |
| derived read × contract | 2 dependency | medium | land-after |
| write × write | 1 structural | high | **exclusive** |
| write × contract | 1 structural + 3 contract | critical | exclusive |
| contract × contract | 1 | critical | exclusive |
| distinct symbols, same file | 1 | low | caution (textual proximity only) |

Levels: **1** direct structural · **2** dependency · **3** contract · **4** semantic (bounded judge,
advisory or escalated) · **5** actual Git conflict (preflight, after code exists). Prediction (1–4) and
verification (5) are always shown separately: a predicted collision may merge cleanly, and a clean merge
may still be semantically wrong.

Decision order: conflict matrix → static analysis → dependency graph → scheduling policy → bounded
judgment → deep model → human. The model is never asked what the matrix knows.

## Right-of-way

For every exclusive pair, the first rule that distinguishes the Flights decides; every rule yields a
sentence for the explanation:

1. **human override** (`X first`)
2. **priority** (critical > high > normal > low) — a security patch beats a refactor
3. **published work** — never discard work already published in the contested airspace
4. **contract owner** — the Flight changing the contract goes first; the other would rework
5. **declared dependency**
6. **partial capacity** — the Flight with no other work goes first; the one that can keep busy yields
7. **filed first**, then flight id

## Clearance and partial clearance

```
writes(F)  = writeSet ∪ contractSet (resolved)
held(F)    = contested resources where F lost right-of-way  (+ resources touched by a landing while F is stale)
cleared(F) = writes(F) − held(F)
status     = clear (nothing held) · partial (some cleared, some held) · hold (nothing cleared)
```

Partial clearance is the default outcome of a conflict: only the contested airspace waits. Clearance is
held as **leases** (10-minute TTL, renewed by heartbeat); a silent agent's leases expire, the Flight is
marked LOST, its airspace is released, and dependants are re-evaluated. If a lease holder loses
right-of-way before it published anything (e.g. a higher-priority Flight arrives), it **yields** that
airspace.

## Dependency graph and deadlocks

Edges: loser → winner (holds for), reader → contract owner (lands after), declared dependencies.
Kahn's algorithm gives a landing order; Tarjan's SCC finds cycles. A cycle is a **traffic deadlock**: the
highest-priority, earliest-filed Flight in the cycle receives right-of-way on every contested pair inside
it, and the deadlock is raised for human review.

## Publish gate

1. The Flight submits its change (files) on top of its baseline.
2. Cruce rebuilds the commit and computes the real diff (changed line ranges in base coordinates).
3. Each range maps to the innermost symbol of the base version (doc comments included); insertions
   consider the gap they sit in, so a declared new member of a type is allowed.
4. Every touched symbol must be covered by a cleared resource (ancestor-or-equal). New test files are
   allowed alongside cleared work.
5. Approved → 60 s write token → push → revoke. Rejected → the out-of-clearance symbols are returned;
   the agent amends its plan (`request`) or reverts. Three rejections raise attention.
6. A stale Flight cannot publish until it re-plans.

## Landing

Landing requires: a plan, not stale, nothing held, every land-after Flight landed, an approved publish,
passing validation, and a clean Git preflight (non-destructive three-way merge against current canonical).
Landing merges for real, attaches a Git note (intent, plan versions, amendments, coordination decisions,
validation, preflight), pushes canonical, re-indexes it, and re-evaluates every other Flight:

- contract changed under a dependency or planned write → stale (ranked first)
- planned write modified by the landing → stale (re-base)
- declared read modified → stale
- assumptions mentioning the changed contract → "assumption no longer holds"

Stale Flights are refreshed (canonical merged into their repository), re-plan, and receive new clearance.

## Human control (exception-driven)

Per congestion: **accept** (acknowledge), **allow both**, **X first**, **hold both**, **reroute** (ask the
loser to plan around the held airspace), **cancel**. Overrides are recorded, explained in the log, and
undoable (back to automatic coordination). Attention items: deadlocks, repeated gate violations, lost
Flights with dependants, plan timeouts, Git conflicts, escalated semantic findings.

## Bounded judgment

`SemanticFinding` (level 4) is an input to the engine, produced outside it by a `DecisionJudge`
(rule-based by default; a narrow model judge is optional). Findings add explanation or escalate to a
human; they never override deterministic decisions.
