import type { Authority, RepositoryLifecycleView, RepositoryState } from "../shared/platform.ts";
import { DomainError } from "./errors.ts";

export function repositoryOwner(a: Authority) {
	if (a.actor.kind !== "human" || a.actor.connectionId || a.role !== "owner") throw new DomainError(403, "Human namespace owner required");
}
/**
 * Archive preserves history, so it waits until all work is explicitly finished, including disconnected work.
 * Permanent deletion is the owner's decision to end everything with the repository: live workspaces, attached or
 * detached, and open changes end with it. Deletion still waits for in-flight promotions and provider operations.
 */
export function repositoryLifecycleView(state: RepositoryState, a: Authority, pendingResources = false): RepositoryLifecycleView {
	const live = state.workspaces.filter((w) => !["completed", "cancelled"].includes(w.state)),
		open = state.proposals.filter((p) => p.state === "open");
	const deletionBlockers: string[] = [];
	if (state.proposals.some((p) => p.state === "promoting") || state.promotions.some((p) => ["prepared", "uncertain"].includes(p.state)))
		deletionBlockers.push("Recover unfinished promotions.");
	if (pendingResources) deletionBlockers.push("Recover unfinished resource operations.");
	const blockers = [
		...(live.length ? ["End all workspaces, including disconnected work."] : []),
		...(open.length || state.proposals.some((p) => p.state === "promoting") ? ["Close all open changes."] : []),
		...deletionBlockers,
	];
	return {
		state: state.repository.lifecycle?.state ?? "active",
		owner: a.actor.kind === "human" && !a.actor.connectionId && a.role === "owner",
		blockers,
		deletionBlockers,
		unfinished: { workspaces: live.length, attached: live.filter((w) => w.execution).length, changes: open.length },
	};
}
