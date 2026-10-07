import { attentionView } from "../core/attention.ts";
import type { Artifact, AttentionGroup, AttentionItem, GitRelation, RepositorySnapshot } from "./platform.ts";

/** Presentation-only projection of an already-authorized snapshot for namespace and home lists. Never fetches source. */

export interface RepositorySummary {
	id: string;
	active: number;
	overlaps: number;
	latestArtifact?: Artifact;
	/**
	 * Attention items per group, the number this viewer can act on, and live workspaces whose ancestry is unknown.
	 * Derived from the same controller projection the repository views render.
	 */
	attention: Record<AttentionGroup, number> & { mine: number; total: number; ancestryUnavailable: number };
	/** The viewer's actionable items first, then the rest, capped; `attention.total` says how many exist. */
	items: AttentionItem[];
	/** Live workspaces as drawn on Home: relation to canonical and whether the attached checkout stopped reporting. */
	lanes: { relation: GitRelation; quiet: boolean }[];
}
export const SUMMARY_LIMIT = 8;
export function repositorySummary(snapshot: RepositorySnapshot): RepositorySummary {
	const attention = snapshot.attention ?? attentionView(snapshot, "");
	const live = snapshot.workspaces.filter((w) => !["completed", "cancelled"].includes(w.state));
	const relation = (id: string) => snapshot.reconciliation?.workspaces.find((row) => row.workspaceId === id)?.relation;
	const count = (group: AttentionGroup) => attention.items.filter((item) => item.group === group).length;
	return {
		id: snapshot.repository.id,
		active: snapshot.workspaces.filter((w) => w.state === "active").length,
		overlaps: snapshot.overlaps.length,
		latestArtifact: snapshot.artifacts.at(-1),
		attention: {
			recovery: count("recovery"),
			promote: count("promote"),
			review: count("review"),
			preparation: count("preparation"),
			reconciliation: count("reconciliation"),
			mine: attention.items.filter((item) => item.mine).length,
			total: attention.items.length,
			ancestryUnavailable: attention.ancestryUnavailable,
		},
		items: [...attention.items.filter((item) => item.mine), ...attention.items.filter((item) => !item.mine)].slice(0, SUMMARY_LIMIT),
		lanes: live
			.toSorted((a, b) => a.startedAt - b.startedAt)
			.slice(0, SUMMARY_LIMIT)
			.map((w) => ({ relation: relation(w.id) ?? "unknown", quiet: w.state === "disconnected" })),
	};
}
