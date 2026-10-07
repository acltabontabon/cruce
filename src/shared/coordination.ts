import type { Artifact, RepositorySnapshot } from "./platform.ts";

/** Presentation-only projection of an already-authorized snapshot for namespace and home lists. Never fetches source. */

export interface RepositorySummary {
	id: string;
	active: number;
	overlaps: number;
	latestArtifact?: Artifact;
	/** What needs a person: changes awaiting review or ready to promote, stale changes and workspaces behind canonical. */
	attention: { review: number; ready: number; stale: number; behind: number };
}
export function repositorySummary(snapshot: RepositorySnapshot): RepositorySummary {
	// A change whose workspace proposed something newer is superseded noise, not stale work needing attention.
	const open = snapshot.proposals.filter(
		(p) => p.state === "open" && !snapshot.proposals.some((later) => later.workspaceId === p.workspaceId && later.number > p.number),
	);
	return {
		id: snapshot.repository.id,
		active: snapshot.workspaces.filter((w) => w.state === "active").length,
		overlaps: snapshot.overlaps.length,
		latestArtifact: snapshot.artifacts.at(-1),
		attention: {
			review: open.filter((p) => snapshot.readiness[p.id]?.checks.current && !snapshot.readiness[p.id]?.ready).length,
			ready: open.filter((p) => snapshot.readiness[p.id]?.ready).length,
			stale: open.filter((p) => snapshot.readiness[p.id] && !snapshot.readiness[p.id].checks.current).length,
			behind: snapshot.workspaces.filter(
				(w) =>
					!["completed", "cancelled"].includes(w.state) &&
					snapshot.reconciliation?.workspaces.some((row) => row.workspaceId === w.id && row.relation === "behind"),
			).length,
		},
	};
}
