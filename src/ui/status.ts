import { ATTENTION_ORDER } from "../core/attention.ts";
import type {
	ActivityEvent,
	Actor,
	AttentionAction,
	AttentionBlocker,
	AttentionGroup,
	AttentionItem,
	Proposal,
	RepositorySnapshot,
	Workspace,
} from "../shared/platform.ts";

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
/** Recorded provenance of how the workspace was started and attached; never a claim about what is executing now. */
export function workedBy(w: Workspace) {
	const started = actorLabel(w.createdBy),
		now = actorLabel(workingActor(w));
	return started === now ? `Started through ${started}` : `Started through ${started} · attached through ${now}`;
}

/** Identity data the console may show: people of the namespace and the viewer's stable user ID. */
export interface People {
	viewerId?: string;
	people?: { id: string; name: string }[];
}
/** The accountable human, from authorized identity data keyed by stable user ID. Never a tool or connection name. */
export function ownerName(ownerId: string, who: People) {
	const person = who.people?.find((p) => p.id === ownerId);
	if (ownerId === who.viewerId) return person ? `${person.name} (you)` : "You";
	return person?.name ?? "Owner name unavailable";
}

/** Separates the responsible human from the producing connection: "through Codex, Maya's connection". */
export function throughConnection(actor: Actor, who: People) {
	const tool = actorLabel(actor);
	if (actor.kind === "human" && !actor.connectionId) return `by ${tool}`;
	const person = who.people?.find((p) => p.id === actor.userId)?.name;
	return `through ${tool}, ${actor.userId === who.viewerId ? "your" : person ? `${person}'s` : "the owner's"} connection`;
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
		// A published revision behind canonical is contained in it; only a baseline behind, or diverged work, needs merging.
		const contained = relation.relation === "behind" && relation.basis === "published";
		const reconcile = relation.relation === "diverged" || (relation.relation === "behind" && !contained);
		return {
			key: relation.relation,
			label: labels[relation.relation],
			tone:
				reconcile || relation.relation === "unrelated" ? "warning" : relation.relation === "unknown" || contained ? "neutral" : "success",
			detail: `${relation.basis === "published" ? "Published revision" : "Baseline"} ${short(relation.revision)} compared with canonical ${short(relation.canonicalRevision)}.${
				reconcile
					? ` Canonical moved to ${short(relation.canonicalRevision)}; reconcile with Git and publish for fresh review.`
					: contained
						? " Canonical already contains the published revision."
						: relation.relation === "unknown"
							? " Ancestry is unavailable, so whether reconciliation is needed is unknown."
							: ""
			}`,
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

/**
 * The exact published source revision of a live workspace that no change proposes yet. Publishing retains work; only a
 * proposal asks for review, so this is the gap between "finished" and "waiting on a human".
 */
export function unproposed(view: RepositorySnapshot, w: Workspace) {
	if (ended(w) || !w.publishedRevision) return undefined;
	if (!["ahead", "diverged", "unknown"].includes(canonicalRelation(view, w).key)) return undefined;
	if (view.proposals.some((p) => p.workspaceId === w.id && p.revision === w.publishedRevision)) return undefined;
	return view.artifacts
		.filter((a) => a.workspaceId === w.id && a.kind === "source" && a.revision === w.publishedRevision)
		.sort((a, b) => b.at - a.at)[0];
}

/** Reported paths grouped by the exact set of workspaces sharing them, so five scaffold files read as one note, not twenty. */
export function overlapGroups(view: RepositorySnapshot) {
	const groups = new Map<string, { workspaces: string[]; paths: string[] }>();
	for (const o of view.overlaps) {
		const key = [...o.workspaces].sort().join("|");
		const group = groups.get(key) ?? { workspaces: [...o.workspaces].sort(), paths: [] };
		group.paths.push(o.surface);
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => b.workspaces.length - a.workspaces.length || b.paths.length - a.paths.length);
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const GROUP_LABELS: Record<AttentionGroup, Status> = {
	recovery: { key: "recovery", label: "Operation needs attention", tone: "danger" },
	promote: { key: "promote", label: "Ready to promote", tone: "success" },
	review: { key: "review", label: "Needs human review", tone: "accent" },
	preparation: { key: "preparation", label: "Needs preparation", tone: "warning" },
	reconciliation: { key: "reconciliation", label: "Needs Git update", tone: "warning" },
};
export const RECONCILIATION_GUIDANCE =
	"An authorized agent or the owner can update the workspace with Git, verify the result and publish it for fresh review. Human approval is required before promotion. This status does not establish merge conflicts.";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Plain wording for one structured blocker; exact revisions stay inspectable through `title` attributes in the views. */
export function blockerText(b: AttentionBlocker) {
	switch (b.kind) {
		case "promotion_unsettled":
			return "Promotion not settled; check its exact remote outcome";
		case "promotion_unrecorded":
			return "Canonical updated; the promotion record is unfinished";
		case "base_stale":
			return `Change based on ${short(b.base)}; accepted canonical is ${short(b.canonical)}`;
		case "canonical_relation":
			return b.relation === "behind"
				? `Canonical moved to ${short(b.canonical)} since this baseline`
				: b.relation === "diverged"
					? `Diverged from canonical ${short(b.canonical)}`
					: "Unrelated to canonical history";
		case "ancestry_missing":
			return `${plural(b.count, "accepted revision")} missing from published ancestry`;
		case "evidence_failed":
			return `${cap(b.check)} failing for this revision`;
		case "evidence_missing":
			return `Required ${b.check} evidence missing`;
		case "evidence_reported":
			return `${cap(b.check)} reported passing; human attestation required`;
		case "concern":
			return `${plural(b.count, "unresolved concern")}`;
		case "approval_required":
			return "Human approval required for this revision";
		case "canonical_discrepancy":
			return "Observed canonical differs from accepted history";
		case "promotion_pending":
			return "Another promotion must be reconciled first";
	}
}
/** One primary reason, then how many more blockers remain; the checklist keeps every blocker visible. */
export function blockerSummary(item: Pick<AttentionItem, "blockers" | "group" | "revision">) {
	const [primary, ...rest] = item.blockers;
	const reason = primary ? blockerText(primary) : `Every check passed for ${short(item.revision)}`;
	return rest.length ? `${reason} · ${plural(rest.length, "more blocker")}` : reason;
}
export const ACTION_LABELS: Record<AttentionAction, string> = {
	reconcile_promotion: "Reconcile promotion",
	promote: "Promote",
	attest_evidence: "Attest evidence",
	resolve_concern: "Resolve concern",
	approve: "Approve",
	prepare_revision: "Prepare revision",
	reconcile_with_git: "Update from canonical",
	inspect: "Inspect",
};
/** Who an item is waiting on when the viewer has no eligible action: an authority class, never an assigned person. */
export function waitingOn(item: AttentionItem) {
	if (item.blockers[0]?.kind === "promotion_unsettled" || item.blockers[0]?.kind === "promotion_unrecorded")
		return "Waiting on the maintainer who promoted it";
	if (item.blockers[0]?.kind === "canonical_discrepancy" || item.blockers[0]?.kind === "promotion_pending")
		return "Waiting on canonical reconciliation";
	if (item.group === "reconciliation") return "Waiting on the owner or their authorized agent";
	return item.group === "preparation" ? "Waiting on the owner" : "Waiting on a maintainer";
}
/** The sentence that says what happens next for this viewer, from the item's eligible actions. */
export function nextStep(item: AttentionItem) {
	switch (item.actions[0]) {
		case "reconcile_promotion":
			return "Reconcile the interrupted promotion before anything else is promoted";
		case "promote":
			return `Promote ${short(item.revision)}; canonical moves to exactly this revision`;
		case "attest_evidence":
			return "Inspect the reported evidence and attest what you checked";
		case "resolve_concern":
			return "Resolve the review concerns with a reason";
		case "approve":
			return `Approve ${short(item.revision)} if it should be promoted`;
		case "prepare_revision":
			return item.blockers.some((b) => b.kind === "evidence_failed")
				? "Fix the failure in your tools, publish a repaired revision and propose it"
				: "Record the required evidence through your tools, or publish a repaired revision";
		case "reconcile_with_git":
			if (item.blockers.some((b) => b.kind === "canonical_relation" && b.relation === "unrelated"))
				return "Inspect the unrelated Git histories in the workspace before choosing how to reconcile them";
			return item.subject === "change"
				? `Merge canonical ${short(item.blockers.flatMap((b) => (b.kind === "base_stale" ? [b.canonical] : []))[0])} with Git in the workspace, verify, push, publish and propose the new revision`
				: "Merge canonical with Git in the workspace, verify, push and publish for fresh review";
		default:
			return waitingOn(item);
	}
}
export function attentionItem(view: RepositorySnapshot, subjectId: string) {
	return view.attention?.items.find((item) => item.id === subjectId);
}

/** Lifecycle status of a change; open, current changes take their label from the attention projection. */
export function changeStatus(view: RepositorySnapshot, p: Proposal): Status & { detail: string } {
	if (p.state === "promoted") {
		const promotion = view.promotions.find((x) => x.proposalId === p.id && x.state === "complete");
		return { key: "promoted", label: "Promoted", tone: "success", detail: `In canonical as ${short(promotion?.to ?? p.revision)}.` };
	}
	if (p.state === "rejected") return { key: "rejected", label: "Closed", tone: "neutral", detail: "Closed without promotion." };
	if (p.state === "promoting")
		return {
			key: "promoting",
			label: "Promotion not settled",
			tone: "danger",
			detail: "Canonical may be updating; check the exact outcome.",
		};
	const later = view.proposals.filter((other) => other.workspaceId === p.workspaceId && other.number > p.number);
	if (later.length) {
		const newest = later.reduce((a, b) => (a.number > b.number ? a : b));
		return {
			key: "superseded",
			label: `Superseded by #${newest.number}`,
			tone: "neutral",
			detail: "Its workspace proposed a newer revision.",
		};
	}
	const item = attentionItem(view, p.id);
	if (!item)
		return { key: "unavailable", label: "Status unavailable", tone: "neutral", detail: "Readiness for this change is unavailable." };
	return { ...GROUP_LABELS[item.group], detail: blockerSummary(item) };
}

/** Current changes grouped by next action, then superseded and finished changes kept discoverable below. */
export function changeGroups(view: RepositorySnapshot) {
	const items = (view.attention?.items ?? []).filter((item) => item.subject === "change");
	const groups = {
		attention: ATTENTION_ORDER.map((group) => ({ group, items: items.filter((item) => item.group === group) })),
		inactive: [] as Proposal[],
		done: [] as Proposal[],
	};
	for (const p of [...view.proposals].sort((a, b) => b.number - a.number)) {
		const key = changeStatus(view, p).key;
		if (key === "promoted" || key === "rejected") groups.done.push(p);
		else if (key === "superseded") groups.inactive.push(p);
	}
	return groups;
}

/** Repository-level counts from the attention projection; knowledge gaps are counted apart from confirmed work. */
export function attention(view: RepositorySnapshot) {
	const items = view.attention?.items ?? [];
	const live = view.workspaces.filter((w) => !ended(w));
	const count = (group: AttentionGroup, subject: AttentionItem["subject"] = "change") =>
		items.filter((item) => item.group === group && item.subject === subject).length;
	return {
		recovery: count("recovery"),
		promote: count("promote"),
		review: count("review"),
		preparation: count("preparation"),
		reconcileChanges: count("reconciliation"),
		reconcileWorkspaces: count("reconciliation", "workspace"),
		mine: items.filter((item) => item.mine).length,
		ancestryUnavailable: view.attention?.ancestryUnavailable ?? 0,
		overlaps: view.overlaps.length,
		unproposed: live.filter((w) => unproposed(view, w)).length,
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
