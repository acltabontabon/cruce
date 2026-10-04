# Product thesis

## The bottleneck moved

**Human era.** A person writes code; Git versions it. The unit of change is one author's commit.

**Team era.** Many people write code at once; branches, pull requests, review, and merge keep them from
stepping on each other. Coordination is mostly social and happens *after* the work: in review, in merge
conflicts, in "oh, you changed that too?".

**Agent era.** One developer delegates five, twenty, a hundred tasks to autonomous coding agents.
Isolation becomes cheap and abundant: every agent gets its own sandbox, its own clone, its own
repository (Cloudflare Artifacts makes a repository per task the natural unit). Execution is no longer
scarce.

What becomes scarce is **coordination**. Agents work in parallel on an evolving shared system, fast, and
without the hallway conversations that let human teams notice collisions early. They cannot all edit
blindly and reconcile later: merge conflicts are the *cheapest* failure; the expensive one is the change
that merges cleanly and is wrong, because it was built on an assumption another agent just invalidated.

Cruce exists for this new bottleneck. Its core question:

> **Who is about to change what, why — and should they be allowed to proceed simultaneously?**

## Isolation is not coordination

A worktree (or a branch, or a fork) can tell you that Agent A has its own working directory. It cannot
tell you:

- Agent A intends to replace `TokenValidator`'s contract.
- Agent B assumes that contract stays stable.
- Agent C is changing a schema Agent B depends on.
- Agent D could safely do 80% of its task while it waits for Agent A.
- Agent E should go before Agent F.
- Agent G just discovered it needs to enter airspace another agent is changing.

Shared *awareness* ("A and B both touch `TokenValidator`") is useful but passive. Cruce is *active*:

```
F-022  JWT migration        → CLEAR           (it changes the contract: it goes first)
F-021  Refresh-token rotation → PARTIAL CLEARANCE
         ✓ AuthService.refreshToken   ✓ RefreshTokenRepository
         × TokenValidator.validate    (hold: F-022 has right-of-way)
F-023  Session cleanup       → CLEAR           (independent)

F-022 lands → F-021's assumption is stale → baseline refreshed → F-021 re-plans
            → TokenValidator.validate is now a *read* → F-021 CLEAR → lands
```

The agents never had to collide first.

## Why air traffic control

The metaphor maps to real mechanics, not decoration:

| ATC | Cruce |
|---|---|
| Flight | one agent's attempt at a Mission, in its own Artifacts repository |
| Flight plan | the read / write / contract sets an agent files after discovery |
| Airspace | modules, files, types, symbols, contracts |
| Clearance | permission to write specific airspace, held as an expiring lease |
| Hold | contested airspace waits; the rest of the route continues |
| Right-of-way | explainable rules: priority, completed work, contract ownership, dependencies |
| Plan amendment | the route changed mid-flight; traffic is re-evaluated |
| Landing | integration into the canonical repository; it changes the airspace for everyone else |

## Principles

- **Algorithms where the problem is deterministic; models only for narrow judgment; humans for
  consequential ambiguity.** No model decides whether two writes to one symbol collide.
- **Maximum safe parallelism.** Independent Flights are cleared immediately; partial clearance keeps work
  moving; sequencing is chosen to avoid rework.
- **Exception-driven.** The developer is not asked to approve every plan — only decisions that need a human.
- **Git stays the source of truth.** Cruce predicts congestion before code exists; Git verifies
  integration after it exists. The two are shown separately.

Isolation is becoming commodity infrastructure. The interesting problem is what happens after one
developer can launch a hundred agents: someone — or something — has to decide who goes first, who can
proceed simultaneously, who should hold, who can work partially, whose assumptions are now stale, and
which changes are safe to integrate. That is Cruce.
