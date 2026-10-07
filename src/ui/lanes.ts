import type { RepositorySnapshot, Workspace } from "../shared/platform.ts";
import { canonicalRelation, changeStatus, ended, overlapsFor, type Status, workedBy } from "./status.ts";

/** Lane colours cycle through six tokens; a workspace keeps its colour for as long as it exists. */
export const LANE_COLOURS = 6;

export interface TrunkNode {
	revision: string;
	/** The change whose promotion produced this revision, when Cruce recorded one. */
	change?: number;
	/** Lane of the workspace the promoted change came from. */
	lane?: number;
}
export interface Lane {
	id: string;
	title: string;
	/** Accountable user; the map shows their name, never a tool label, as the lane's person. */
	ownerId: string;
	worked: string;
	lane: number;
	/** Index of the baseline on the trunk; undefined when the baseline is not a recorded canonical revision. */
	baseline?: number;
	baseRevision: string;
	head: string;
	commits: number;
	published?: string;
	change?: { id: string; number: number; status: Status };
	relation: Status;
	quiet: boolean;
	detached: boolean;
	presence: string;
	shared: string[];
}

/** Stable lane colour for every workspace, live or ended, ordered by when it started. */
export function laneIndex(view: RepositorySnapshot) {
	const order = view.workspaces.toSorted((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	return new Map(order.map((w, i) => [w.id, (i % LANE_COLOURS) + 1]));
}

/** Canonical as Cruce recorded it: each completed promotion's target in order, ending at the accepted head. */
export function trunk(view: RepositorySnapshot): TrunkNode[] {
	const lanes = laneIndex(view);
	const nodes: TrunkNode[] = [];
	const add = (node: TrunkNode) => {
		if (!node.revision) return;
		const at = nodes.findIndex((n) => n.revision === node.revision);
		if (at === -1) nodes.push(node);
		else nodes[at] = { ...nodes[at], ...node };
	};
	const promotions = view.promotions.filter((p) => p.state === "complete").toSorted((a, b) => a.at - b.at);
	for (const promotion of promotions) {
		add({ revision: promotion.from });
		const proposal = view.proposals.find((p) => p.id === promotion.proposalId);
		add({ revision: promotion.to, change: proposal?.number, lane: proposal && lanes.get(proposal.workspaceId) });
	}
	if (view.sourceHead) add({ revision: view.sourceHead });
	return nodes;
}

/** Live workspaces drawn as lanes from their baseline. Presentation only: relation and readiness come from the snapshot. */
export function lanes(view: RepositorySnapshot): Lane[] {
	const colours = laneIndex(view),
		nodes = trunk(view);
	return view.workspaces
		.filter((w) => !ended(w))
		.toSorted((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
		.map((w) => toLane(view, w, colours.get(w.id) ?? 1, nodes));
}

function toLane(view: RepositorySnapshot, w: Workspace, lane: number, nodes: TrunkNode[]): Lane {
	const latest = view.proposals.filter((p) => p.workspaceId === w.id).toSorted((a, b) => b.number - a.number)[0];
	const at = nodes.findIndex((n) => n.revision === w.baseRevision);
	return {
		id: w.id,
		title: w.title,
		ownerId: w.ownerId,
		worked: workedBy(w),
		lane,
		baseline: at === -1 ? undefined : at,
		baseRevision: w.baseRevision,
		head: w.headRevision,
		commits: w.commits.length,
		published: w.publishedRevision,
		change: latest && { id: latest.id, number: latest.number, status: changeStatus(view, latest) },
		relation: canonicalRelation(view, w),
		quiet: w.state !== "active" || !w.execution,
		detached: w.state === "detached",
		presence:
			w.state === "detached"
				? "detached"
				: w.state === "preparing"
					? "preparing"
					: w.state === "active" && w.execution
						? "connected"
						: "quiet",
		shared: overlapsFor(view, w).map((o) => o.path),
	};
}
