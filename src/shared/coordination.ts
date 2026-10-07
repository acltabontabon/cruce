import type { Artifact, GitRelation, RepositorySnapshot } from "./platform.ts";

/** Presentation-only projection of an already-authorized snapshot for namespace and home lists. Never fetches source. */

export interface RepositorySummary {
	id: string;
	active: number;
	overlaps: number;
	latestArtifact?: Artifact;
	/** What needs a person: changes awaiting review or ready to promote, stale changes and workspaces behind canonical. */
	attention: { review: number; ready: number; stale: number; behind: number };
	/** The open changes behind those counts, newest first and capped, so Home can name each decision. */
	changes: { id: string; number: number; title: string; status: "review" | "ready" | "stale"; revision: string; actor?: string }[];
	/** Live workspaces as drawn on Home: relation to canonical and whether the attached checkout stopped reporting. */
	lanes: { relation: GitRelation; quiet: boolean }[];
}
const LIST_LIMIT = 8;
export function repositorySummary(snapshot: RepositorySnapshot): RepositorySummary {
	// A change whose workspace proposed something newer is superseded noise, not stale work needing attention.
	const open = snapshot.proposals.filter(
		(p) => p.state === "open" && !snapshot.proposals.some((later) => later.workspaceId === p.workspaceId && later.number > p.number),
	);
	const status = (id: string): RepositorySummary["changes"][number]["status"] | undefined => {
		const readiness = snapshot.readiness[id];
		if (!readiness) return undefined;
		return !readiness.checks.current ? "stale" : readiness.ready ? "ready" : "review";
	};
	const live = snapshot.workspaces.filter((w) => !["completed", "cancelled"].includes(w.state));
	const relation = (id: string) => snapshot.reconciliation?.workspaces.find((row) => row.workspaceId === id)?.relation;
	return {
		id: snapshot.repository.id,
		active: snapshot.workspaces.filter((w) => w.state === "active").length,
		overlaps: snapshot.overlaps.length,
		latestArtifact: snapshot.artifacts.at(-1),
		attention: {
			review: open.filter((p) => status(p.id) === "review").length,
			ready: open.filter((p) => status(p.id) === "ready").length,
			stale: open.filter((p) => status(p.id) === "stale").length,
			behind: live.filter((w) => relation(w.id) === "behind").length,
		},
		changes: open
			.flatMap((p) => {
				const s = status(p.id);
				return s
					? [
							{
								id: p.id,
								number: p.number,
								title: p.title,
								status: s,
								revision: p.revision,
								actor: snapshot.artifacts.find((a) => a.id === p.artifactId)?.actor.name,
							},
						]
					: [];
			})
			.sort((a, b) => b.number - a.number)
			.slice(0, LIST_LIMIT),
		lanes: live
			.toSorted((a, b) => a.startedAt - b.startedAt)
			.slice(0, LIST_LIMIT)
			.map((w) => ({ relation: relation(w.id) ?? "unknown", quiet: w.state === "disconnected" })),
	};
}
