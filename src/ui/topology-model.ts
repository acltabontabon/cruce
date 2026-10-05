import type { RepositorySnapshot, Workspace } from "../shared/platform.ts";

/** Who is advancing the workspace now: the attached execution's actor, else its creator. A label, not an identity claim. */
export const workingActor = (w: Workspace) => w.execution?.attachedBy ?? w.createdBy;

/** Lanes describe recorded work, not a reconstructed Git DAG. */
export function topologyModel(view: RepositorySnapshot, limit = 6) {
	const ordered = [...view.workspaces].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	const current = ordered.filter((w) => !["completed", "cancelled"].includes(w.state));
	const visible = current.slice(0, limit);
	return {
		canonical: view.sourceHead,
		total: current.length,
		lanes: visible.map((workspace) => ({
			workspace,
			publications: view.artifacts.filter((a) => a.kind === "source" && a.workspaceId === workspace.id),
			promotions: view.promotions.filter(
				(p) =>
					p.state === "complete" &&
					view.proposals.some((c) => c.id === p.proposalId && c.workspaceId === workspace.id && c.revision === p.to),
			),
		})),
		intersections: view.overlaps,
	};
}
