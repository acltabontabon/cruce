import type { RepositorySnapshot } from "../shared/platform.ts";

/** Lanes describe recorded work, not a reconstructed Git DAG. */
export function topologyModel(view: RepositorySnapshot, limit = 6) {
	const ordered = [...view.workspaces].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	const writers = ordered.filter((w) => w.mode === "write");
	const current = writers.filter((w) => !["completed", "cancelled"].includes(w.state));
	const visible = current.slice(0, limit);
	return {
		canonical: view.sourceHead,
		total: current.length,
		observers: ordered.filter((w) => w.mode === "read" && !["completed", "cancelled"].includes(w.state)),
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
