import type { ActivityEvent, Actor, Proposal, RepositorySnapshot, Workspace } from "../shared/platform.ts";

/** Plain-language presentation of controller-derived state. These helpers decide wording, never authority. */
export type Tone = "accent" | "success" | "warning" | "danger" | "neutral";
export interface Status {
	key: string;
	label: string;
	tone: Tone;
}

export const short = (s?: string) => s?.slice(0, 8) ?? "—";

export function ago(at: number, now = Date.now()) {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.round(h / 24);
	return d < 30 ? `${d} d ago` : new Date(at).toLocaleDateString();
}

/** The actor advancing the workspace now: the attached execution's actor, else its creator. A label, not an identity claim. */
export const workingActor = (w: Workspace) => w.execution?.attachedBy ?? w.createdBy;
/** Tool names come from each client's OAuth registration ("Cruce codex bridge"); show the tool, not the plumbing. */
export function actorLabel(actor?: Pick<Actor, "name" | "kind">) {
	if (!actor) return "Unknown";
	const bridge = /^Cruce (.+?) bridge$/i.exec(actor.name);
	if (!bridge) return actor.name;
	const tool = bridge[1].toLowerCase();
	return tool === "claude" ? "Claude Code" : tool === "codex" ? "Codex" : tool === "cursor" ? "Cursor" : bridge[1];
}
export function workedBy(w: Workspace) {
	const started = actorLabel(w.createdBy),
		now = actorLabel(workingActor(w));
	return started === now ? started : `Started in ${started} · continued in ${now}`;
}

export const ended = (w: Workspace) => w.state === "completed" || w.state === "cancelled";

export function workspaceStatus(w: Workspace): Status {
	switch (w.state) {
		case "active":
			return { key: "active", label: "Active", tone: "success" };
		case "disconnected":
			return { key: "disconnected", label: "Not reporting", tone: "warning" };
		case "detached":
			return { key: "detached", label: "Detached", tone: "neutral" };
		case "preparing":
			return { key: "preparing", label: "Setting up", tone: "neutral" };
		case "completed":
			return { key: "completed", label: "Completed", tone: "neutral" };
		default:
			return { key: "cancelled", label: "Cancelled", tone: "neutral" };
	}
}

export function canonicalRelation(view: RepositorySnapshot, w: Workspace): Status & { detail: string } {
	const relation = view.reconciliation?.workspaces.find((row) => row.workspaceId === w.id);
	if (relation) {
		const labels = {
			unknown: "Ancestry unavailable",
			current: "Up to date",
			ahead: "Ahead of canonical",
			behind: "Behind canonical",
			diverged: "Diverged from canonical",
			unrelated: "Unrelated to canonical",
		};
		return {
			key: relation.relation,
			label: labels[relation.relation],
			tone: ["behind", "diverged"].includes(relation.relation) ? "warning" : relation.relation === "unknown" ? "neutral" : "success",
			detail: `${relation.basis === "published" ? "Published revision" : "Baseline"} ${short(relation.revision)} compared with canonical ${short(relation.canonicalRevision)}.${["behind", "diverged"].includes(relation.relation) ? ` Canonical moved to ${short(relation.canonicalRevision)}; reconcile with Git and publish for fresh review.` : ""}`,
		};
	}
	const updates = view.workspaceUpdates[w.id];
	if (!updates || updates.status === "unknown")
		return { key: "unknown", label: "Canonical unavailable", tone: "neutral", detail: "Canonical revision is unavailable." };
	if (updates.status === "available")
		return {
			key: "unknown",
			label: "Canonical moved",
			tone: "warning",
			detail: "Inspect published ancestry to determine whether reconciliation is needed.",
		};
	return { key: "current", label: "Up to date", tone: "success", detail: "Built on the current canonical revision." };
}

/** Other present workspaces touching the same reported paths. Advisory: shared paths are not conflicts. */
export function overlapsFor(view: RepositorySnapshot, w: Workspace) {
	return view.overlaps
		.filter((o) => o.workspaces.includes(w.id))
		.map((o) => ({
			path: o.surface,
			observedAt: o.observedAt,
			others: o.workspaces.filter((id) => id !== w.id).map((id) => view.workspaces.find((x) => x.id === id)?.title ?? "another workspace"),
		}));
}

export function changeStatus(view: RepositorySnapshot, p: Proposal): Status & { detail: string } {
	if (p.state === "promoted") {
		const promotion = view.promotions.find((x) => x.proposalId === p.id && x.state === "complete");
		return { key: "promoted", label: "Promoted", tone: "success", detail: `In canonical as ${short(promotion?.to ?? p.revision)}.` };
	}
	if (p.state === "rejected") return { key: "rejected", label: "Closed", tone: "neutral", detail: "Closed without promotion." };
	if (p.state === "promoting")
		return { key: "promoting", label: "Promotion in progress", tone: "warning", detail: "Canonical is being updated." };
	const later = view.proposals.filter((other) => other.workspaceId === p.workspaceId && other.number > p.number);
	if (later.length) {
		const newest = later.reduce((a, b) => (a.number > b.number ? a : b));
		return {
			key: "superseded",
			label: `Superseded by #${newest.number}`,
			tone: "neutral",
			detail: "Its workspace published a newer revision.",
		};
	}
	const readiness = view.readiness[p.id];
	if (readiness && !readiness.checks.current)
		return {
			key: "stale",
			label: "Stale",
			tone: "warning",
			detail: `Canonical moved to ${short(readiness.checks.canonical)}. The workspace must merge it and publish a new revision.`,
		};
	if (readiness?.checks.concerns)
		return { key: "concerns", label: "Has concerns", tone: "danger", detail: "A reviewer raised a concern that needs a resolution." };
	if (readiness?.ready) return { key: "ready", label: "Ready to promote", tone: "success", detail: "Every check passed." };
	return { key: "review", label: "Needs review", tone: "accent", detail: "Waiting for your review." };
}

/** Changes grouped by what a person should do: act now, ignore unless curious, or done. */
export function changeGroups(view: RepositorySnapshot) {
	const groups = { attention: [] as Proposal[], inactive: [] as Proposal[], done: [] as Proposal[] };
	for (const p of [...view.proposals].sort((a, b) => b.number - a.number)) {
		const key = changeStatus(view, p).key;
		if (key === "promoted" || key === "rejected") groups.done.push(p);
		else if (key === "stale" || key === "superseded") groups.inactive.push(p);
		else groups.attention.push(p);
	}
	return groups;
}

export function attention(view: RepositorySnapshot) {
	const statuses = view.proposals.map((p) => changeStatus(view, p).key);
	const live = view.workspaces.filter((w) => !ended(w));
	return {
		review: statuses.filter((k) => k === "review" || k === "concerns").length,
		ready: statuses.filter((k) => k === "ready").length,
		stale: statuses.filter((k) => k === "stale").length,
		behind: live.filter((w) => canonicalRelation(view, w).key === "behind").length,
		overlaps: view.overlaps.length,
		quiet: live.filter((w) => w.state === "disconnected").length,
	};
}

/** The completed promotion that produced the current canonical revision, if Cruce recorded one. */
export function lastPromotion(view: RepositorySnapshot) {
	return view.promotions.filter((p) => p.state === "complete").sort((a, b) => b.at - a.at)[0];
}

/** Activity summaries are stored terse ("Bounded retry policy"); say what happened and who did it. */
export function activityText(e: Pick<ActivityEvent, "kind" | "summary" | "actor">) {
	const who = actorLabel(e.actor),
		summary = e.summary.replaceAll(e.actor.name, who);
	switch (e.kind) {
		case "artifact_published":
			return `${who} published ${summary}`;
		case "change_proposed":
			return `${who} proposed ${summary}`;
		case "verification_recorded":
			return `${who} recorded a check: ${summary}`;
		case "source_promoted":
			return `${who} promoted ${summary} to canonical`;
		case "review_resolved":
			return `${who} resolved a concern: ${summary}`;
		case "change_rejected":
			return `${who} closed a change: ${summary}`;
		default:
			return summary;
	}
}
