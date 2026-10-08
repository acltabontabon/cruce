import type { Authority, RepositoryLifecycleView, RepositoryState } from "../shared/platform.ts";
import { DomainError } from "./errors.ts";

export function repositoryOwner(a: Authority) {
	if (a.actor.kind !== "human" || a.actor.connectionId || a.role !== "owner") throw new DomainError(403, "Human namespace owner required");
}
/** Finishing work is explicit; disconnected executions still block repository retirement. */
export function repositoryLifecycleView(state: RepositoryState, a: Authority, pendingResources = false): RepositoryLifecycleView {
	const blockers: string[] = [];
	if (state.workspaces.some((w) => !["completed", "cancelled"].includes(w.state)))
		blockers.push("End all workspaces, including disconnected work.");
	if (state.proposals.some((p) => ["open", "promoting"].includes(p.state))) blockers.push("Close all open changes.");
	if (state.promotions.some((p) => ["prepared", "uncertain"].includes(p.state))) blockers.push("Recover unfinished promotions.");
	if (pendingResources) blockers.push("Recover unfinished resource operations.");
	return {
		state: state.repository.lifecycle?.state ?? "active",
		owner: a.actor.kind === "human" && !a.actor.connectionId && a.role === "owner",
		blockers,
	};
}
