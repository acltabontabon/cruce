# 0014 — Review notes on exact revisions

**Status:** Accepted 2026-10-09

## Context

A change can be blocked only by a whole-change concern: one reason attached to one exact revision. Reviewers can't point at the line they mean, and the owner's agent has no structured way to learn what the reviewer asked for. When the owner publishes and proposes a fixed revision, the new change starts with no reviews, so an unresolved concern silently disappears with the revision it named.

People already work this way with forges: the reviewer comments on lines, the author (now usually an agent) addresses them, replies and pushes again, and the reviewer resolves. A local worktree plus an orchestrator can't provide that across sessions, machines and tools, because nothing durable records what was asked, on which exact revision, and whether a human accepted the answer.

## Decision

**Review notes.** A repository writer, human or agent, can add a note to an open change. A note names the change's exact revision under review and is either a **concern**, which blocks promotion until a human resolves it, or a **comment**, which never blocks. A note may be **anchored** to one line: a path, a 1-based line number, the exact revision that line belongs to (the change's revision, its review base, or a revision earlier in the same change thread) and the line's text. Anchors let any comparison place the note, and show it as outdated when that line no longer exists. Notes and replies are immutable records with their actor and time. They are never edited or deleted, only resolved.

**Threads follow supersession, not revisions.** When a workspace proposes a newer change, the older open change is superseded and records which change superseded it. The newest change in that chain inherits every unresolved note. A concern keeps blocking the newest change until a human resolves it, so republishing can't drop one. Approval and evidence still name one exact revision and never carry over. A change closed by a human, withdrawn by cancellation or promoted ends its thread.

**Replies and citations.** Any repository writer can reply once per message (no nested threads). A reply may cite a published revision of the same workspace, for example the revision that addresses the note. A citation is a pointer for the reviewer, never proof. A note is **awaiting the reviewer** when its latest reply comes from the workspace owner, through the console or any of the owner's connections. Otherwise it is **awaiting the owner**.

**Resolution stays human.** Only an authenticated console human with Maintain resolves a note, with a reason, under the same authority as resolving any concern ([ADR 0006](0006-qualified-approval-and-publication-recovery.md)). Agents and paired terminals can add notes and reply, but never resolve. Readiness counts unresolved concern notes on the thread together with unresolved whole-change concerns. The console raises concerns as notes, anchored or not.

**Agents pull. Cruce never pushes.**

- `get_review_notes` (`cruce:read`) returns the note thread of a workspace's open change: each note's kind, anchor, replies, whom it awaits and whether it is resolved, plus the current revision. It is a pure coordination read.
- `add_review_note` and `reply_review_note` (`change:write`) let an agent leave a note or answer one. `resolve_review_note` is console-only.
- The local bridge's coordination context, which it already appends to tool responses, exposes as the `repository_coordination` resource and prints from the `cruce hint` prompt hook, names the caller's own changes that have notes awaiting the owner. An agent learns about them on its own next call or the user's next prompt.
- The MCP server offers an `address_review_notes` prompt the user can run from their tool. It is fixed instruction text, not a stored prompt.

The agent then works the way it already does for canonical updates. It reads the notes, changes the code with Git where it agrees, verifies, pushes, publishes and proposes the new exact revision, and replies on each note, citing that revision or explaining why it disagrees. The human checks the answer in the console and resolves, or replies.

Cruce does not message, wake, schedule or assign agents, store prompts or conversations, send notifications, or decide whether an answer is correct.

**Bounds.** A change thread holds at most 200 notes, a note at most 20 replies, a note or reply body at most 2,000 characters, and an anchored line's text at most 500 characters. Notes live on their change and move to archive bundles with it.

## Consequences

Reviewers can point at lines, owners' agents can find and answer them without a human relaying text, and an unresolved concern survives every republish until a human resolves it. Promotion still needs fresh human approval of the exact revision, trusted evidence and every concern resolved.

Whole-change `review_proposal` concerns keep their per-revision meaning for existing clients. The console no longer creates them. Anchors are matched by line number and text, never by diff heuristics, so a note on a heavily rewritten line shows as outdated rather than being moved to a guessed line.

This extends the review model in the [domain model](../domain-model.md). It changes no authority: who may write, approve, resolve and promote is unchanged.
