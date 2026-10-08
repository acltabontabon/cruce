import type { RepositorySnapshot, Workspace } from "../shared/platform.ts";
import { canonicalRelation, changeStatus, ended, overlapsFor, type Status, settledInMain, workedBy } from "./status.ts";

/** Lane colours cycle through six tokens; a workspace keeps its colour for as long as it exists. */
export const LANE_COLOURS = 6;

export interface TrunkNode {
	revision: string;
	/** The change whose promotion produced this revision, when Cruce recorded one. */
	change?: number;
	/** Lane of the workspace the promoted change came from. */
	lane?: number;
	/** The recorded promotion that produced this revision; revisions that predate Cruce's records have none. */
	promotion?: { id: string; at: number };
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
	/** Already in canonical: through this workspace's own promoted change, or carried by another workspace's. */
	settled?: "own" | "other";
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
		add({
			revision: promotion.to,
			change: proposal?.number,
			lane: proposal && lanes.get(proposal.workspaceId),
			promotion: { id: promotion.id, at: promotion.at },
		});
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
		settled: settledInMain(view, w),
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

/** What Cruce recorded about one workspace over time. Presence, relation and overlaps are current facts and stay out of it. */
export interface LaneHistory {
	id: string;
	startedAt: number;
	/** Revisions the workspace reported or published, each at its earliest recorded sighting. */
	revisions: { revision: string; at: number }[];
	publications: { revision: string; at: number }[];
	change?: {
		number: number;
		revision: string;
		at: number;
		approvedAt?: number;
		promotion?: { id: string; to: string; at: number };
	};
	/** Last heartbeat or report; a quiet lane stops being solid here. */
	lastSeen: number;
}

/** Reported heads, publications, the latest change and its promotion, from records the snapshot already carries. */
export function laneHistory(view: RepositorySnapshot, w: Workspace): LaneHistory {
	const seen = new Map<string, number>();
	const see = (revision: string | undefined, at: number | undefined) => {
		if (!revision || at === undefined || revision === w.baseRevision) return;
		const earlier = seen.get(revision);
		if (earlier === undefined || at < earlier) seen.set(revision, at);
	};
	for (const e of view.activity) if (e.kind === "changes_reported" && e.ids[0] === w.id) see(e.ids[1], e.at);
	const publications = view.artifacts
		.filter((a) => a.kind === "source" && a.workspaceId === w.id)
		.toSorted((a, b) => a.at - b.at)
		.map((a) => ({ revision: a.revision, at: a.at }));
	for (const p of publications) see(p.revision, p.at);
	// Current revisions without a recorded sighting take the last report time, or the start when none was recorded.
	for (const revision of [w.publishedRevision, w.headRevision])
		if (revision && !seen.has(revision)) see(revision, w.lastReportAt ?? w.startedAt);
	const latest = view.proposals.filter((p) => p.workspaceId === w.id).toSorted((a, b) => b.number - a.number)[0];
	const promotion = latest && view.promotions.find((p) => p.proposalId === latest.id && p.state === "complete");
	const approvals = latest?.reviews.filter((r) => r.outcome === "approve" && r.revision === latest.revision && !r.resolution) ?? [];
	return {
		id: w.id,
		startedAt: w.startedAt,
		revisions: [...seen].map(([revision, at]) => ({ revision, at })).toSorted((a, b) => a.at - b.at),
		publications,
		change: latest && {
			number: latest.number,
			revision: latest.revision,
			at: latest.at,
			approvedAt: approvals.length ? Math.min(...approvals.map((r) => r.at)) : undefined,
			promotion: promotion && { id: promotion.id, to: promotion.to, at: promotion.at },
		},
		lastSeen: Math.max(w.startedAt, w.lastActivity),
	};
}

/** Idle gaps longer than this are drawn as a break on the time axis. */
export const AXIS_BREAK = 6 * 3_600_000;

/**
 * Recorded time, compressed for reading. Every mark keeps its own slot in recorded order, so simultaneous records stay
 * apart, and the space between slots grows with the logarithm of the time between them. Marks without a recorded time
 * sit at the origin, before Cruce's history. Positions run from 0 to 1, where 1 is now.
 */
export interface TimeAxis {
	now: number;
	/** Position of a mark by key; undefined for an unknown key. */
	slot(key: string): number | undefined;
	/** Position of a recorded time. */
	at(time: number): number;
	/** Recorded time at a position, for replay. */
	time(pos: number): number;
	ticks: { pos: number; at: number }[];
	breaks: { pos: number; gap: number }[];
}

export function timeAxis(marks: { key: string; at?: number }[], now: number): TimeAxis {
	const step = (gap: number) => 1 + Math.min(9, 1.6 * Math.log1p(Math.max(0, gap) / 60_000));
	const timed = marks.filter((m): m is { key: string; at: number } => m.at !== undefined).toSorted((a, b) => a.at - b.at);
	const raw = new Map<string, number>(),
		anchors: { at: number; cum: number }[] = [],
		gaps: { cum: number; gap: number }[] = [];
	let cum = 0,
		last: number | undefined;
	for (const m of timed) {
		const gap = last === undefined ? 0 : m.at - last;
		cum += last === undefined ? 1.5 : step(gap);
		if (gap > AXIS_BREAK) gaps.push({ cum: cum - step(gap) / 2, gap });
		if (!raw.has(m.key)) raw.set(m.key, cum);
		anchors.push({ at: m.at, cum });
		last = m.at;
	}
	const end = Math.max(now, last ?? now);
	if (last !== undefined && end - last > AXIS_BREAK) gaps.push({ cum: cum + step(end - last) / 2, gap: end - last });
	cum += step(last === undefined ? 0 : end - last);
	const total = cum;
	for (const m of marks) if (m.at === undefined && !raw.has(m.key)) raw.set(m.key, 0);
	const points = [...anchors, { at: end, cum: total }];
	const at = (time: number) => {
		if (!anchors.length) return 1;
		if (time <= points[0].at) return points[0].cum / total;
		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1],
				b = points[i];
			if (time <= b.at) return (b.at === a.at ? a.cum : a.cum + ((time - a.at) / (b.at - a.at)) * (b.cum - a.cum)) / total;
		}
		return 1;
	};
	const time = (pos: number) => {
		const c = Math.max(0, Math.min(1, pos)) * total;
		if (!anchors.length || c <= points[0].cum) return points[0]?.at ?? end;
		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1],
				b = points[i];
			if (c <= b.cum) return a.at + ((c - a.cum) / (b.cum - a.cum)) * (b.at - a.at);
		}
		return end;
	};
	const ticks: { pos: number; at: number }[] = [];
	for (const p of anchors) if (!ticks.some((t) => t.at === p.at)) ticks.push({ pos: p.cum / total, at: p.at });
	return {
		now: end,
		slot: (key) => {
			const c = raw.get(key);
			return c === undefined ? undefined : c / total;
		},
		at,
		time,
		ticks,
		breaks: gaps.map((g) => ({ pos: g.cum / total, gap: g.gap })),
	};
}

/** Axis marks for every live workspace and recorded promotion, so toggling folded lanes never moves the others. */
export function repositoryAxis(view: RepositorySnapshot, histories: LaneHistory[], now: number) {
	const marks: { key: string; at?: number }[] = [];
	for (const node of trunk(view)) marks.push({ key: `main:${node.revision}`, at: node.promotion?.at });
	for (const h of histories) {
		marks.push({ key: `start:${h.id}`, at: h.startedAt });
		for (const r of h.revisions) marks.push({ key: `rev:${h.id}:${r.revision}`, at: r.at });
	}
	return timeAxis(marks, now);
}
