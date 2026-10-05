# 0002 — Workspace ownership and execution attachment

**Status:** Accepted, 2026-10-06 · **Owner of the resulting state:** [domain model](../domain-model.md#workspace-identity)

## Context

A workspace is meant to be the durable unit of concurrent Git work. The implementation contradicted that in three ways:

1. `Workspace.actor` was the creating actor, and an agent actor is one OAuth connection (`agent-<connectionId>`). Every write required the same actor *and* connection. So a workspace started by one Claude Code connection could not be advanced by Codex, by a new connection of the same user, or by that user in the console.
2. `attach_workspace` rejected any execution context other than the first one ("execution context is immutable"). A workspace could not move to another checkout or machine.
3. Each `cruce mcp` bridge process discarded workspace state that was not in a Cruce-owned worktree. In practice a workspace's useful life ended with its agent session.

## Decision

- **Ownership.** A workspace has an `ownerId`, the user who owns it, and a `createdBy` actor, kept as provenance only. Authority over the workspace (attach, detach, report, push to its fork, publish, propose, end, and cleanup by an agent) belongs to the owner through any of that user's authorized connections, subject to scopes and current grants. Each operation records the actor that performed it.
- **Execution attachment.** `Workspace.execution` is the single current attachment, recording the local context plus `attachedBy` and `attachedAt`. Attaching while a different context is attached is rejected. The owner must first detach explicitly with `detach_workspace`. Detaching clears the attachment and moves the workspace to `detached`; the fork, baseline, revisions and provenance remain. Attaching again from another checkout returns it to `active` and reuses the existing fork.
- **Reports are bound to the attachment.** `heartbeat` and `report_change` name the attached execution context. Reports from any other context are rejected, so a stale bridge on an old machine cannot overwrite the current state.
- **Local continuation.** `cruce resume --workspace ID` creates a Cruce-owned worktree, configures the fork remote and fast-forwards to the workspace's pushed branch head. Only pushed revisions travel; Git is the transport. `cruce detach` releases the local lock and the server attachment while keeping the worktree.
- **Paired terminals** stay bound to one workspace. Renewal reuses the terminal connection that created the workspace.

## Rejected alternatives

- **Keep per-connection ownership and add hand-off.** This preserves the coupling of work to a session. A connection is how an actor authenticates, not who owns work.
- **Allow any number of simultaneous attachments.** This would make reported state ambiguous and invite two machines writing one fork. One attachment at a time keeps "who is advancing this now" answerable.
- **Release attachments automatically on presence expiry.** This would let elapsed time transfer ownership of a locked checkout. Detaching must be explicit.

## Consequences

- Breaking contract change: `Workspace.actor` is replaced by `ownerId` and `createdBy`, `execution` gains `attachedBy`/`attachedAt`, `detached` joins the lifecycle, and `heartbeat`/`report_change` require `execution`. There is no compatibility reader.
- Several tools of the same user may operate in one attached checkout. That is the user's local choice, and provenance records which actor did what.
- Transferring a workspace to a *different* developer is not supported yet. It needs an explicit authority model (roadmap: multi-user collaboration).
- A push from an old machine after re-attachment is still accepted by the fork if the owner's credentials allow it. Non-forced Git history rules and publication ancestry checks protect retained history. Tying fork pushes to the current attachment would require execution identity in Git transport and is not done.
