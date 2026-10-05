import type { Artifact, Overlap, RepositorySnapshot, Workspace } from "./platform.ts";

/** Presentation-only projection of an already-authorized snapshot. Never fetches source. */
export interface CoordinationTopology {
	workspaces: Pick<Workspace, "id" | "state">[];
	intersections: Pick<Overlap, "id" | "workspaces">[];
}
export interface RepositorySummary {
	id: string;
	active: number;
	overlaps: number;
	latestArtifact?: Artifact;
	topology: CoordinationTopology;
}
export function repositorySummary(snapshot: RepositorySnapshot): RepositorySummary {
	return {
		id: snapshot.repository.id,
		active: snapshot.workspaces.filter((w) => w.state === "active").length,
		overlaps: snapshot.overlaps.length,
		latestArtifact: snapshot.artifacts.at(-1),
		topology: {
			workspaces: snapshot.workspaces.map(({ id, state }) => ({ id, state })),
			intersections: snapshot.overlaps.map(({ id, workspaces }) => ({ id, workspaces: [...workspaces] })),
		},
	};
}
