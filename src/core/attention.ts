import type {
	AttentionAction,
	AttentionBlocker,
	AttentionGroup,
	AttentionItem,
	AttentionView,
	Proposal,
	RepositorySnapshot,
} from "../shared/platform.ts";

/** Blocker precedence: the first blocker present is the primary reason and decides the item's group. */
const PRECEDENCE: AttentionBlocker["kind"][] = [
	"promotion_unsettled",
	"promotion_unrecorded",
	"base_stale",
	"canonical_relation",
	"ancestry_missing",
	"evidence_failed",
	"evidence_missing",
	"evidence_reported",
	"concern",
	"approval_required",
	// Repository-wide conditions come last: review stays useful while they are reconciled.
	"canonical_discrepancy",
	"promotion_pending",
];
const GROUP: Record<AttentionBlocker["kind"], AttentionGroup> = {
	promotion_unsettled: "recovery",
	promotion_unrecorded: "recovery",
	canonical_discrepancy: "recovery",
	promotion_pending: "recovery",
	base_stale: "reconciliation",
	canonical_relation: "reconciliation",
	ancestry_missing: "reconciliation",
	evidence_failed: "preparation",
	evidence_missing: "preparation",
	evidence_reported: "review",
	concern: "review",
	approval_required: "review",
};
/** Suggested reading order; a usability hypothesis that never sequences execution or promotes anything. */
export const ATTENTION_ORDER: AttentionGroup[] = ["recovery", "promote", "review", "preparation", "reconciliation"];

/** A change is current when no later change from its workspace exists; older ones are superseded, not stale work. */
export function currentChanges(snapshot: Pick<RepositorySnapshot, "proposals">) {
	return snapshot.proposals.filter(
		(p) => !snapshot.proposals.some((later) => later.workspaceId === p.workspaceId && later.number > p.number),
	);
}

function changeBlockers(snapshot: RepositorySnapshot, p: Proposal): AttentionBlocker[] {
	if (p.state === "promoting") return [{ kind: "promotion_unsettled" }];
	if (p.state === "promoted") return [{ kind: "promotion_unrecorded" }];
	const readiness = snapshot.readiness[p.id];
	if (!readiness) return [];
	const { checks } = readiness;
	const blockers: AttentionBlocker[] = [];
	if (!checks.current) blockers.push({ kind: "base_stale", base: p.base, canonical: checks.canonical });
	for (const e of checks.evidence) {
		if (e.failed) blockers.push({ kind: "evidence_failed", check: e.kind });
		else if (!e.trusted) blockers.push({ kind: e.reported ? "evidence_reported" : "evidence_missing", check: e.kind });
	}
	if (checks.concerns) blockers.push({ kind: "concern", count: checks.concerns });
	if (!checks.approved) blockers.push({ kind: "approval_required" });
	const observed = snapshot.observedCanonical;
	if (observed && (observed.deleted || observed.revision !== snapshot.sourceHead)) blockers.push({ kind: "canonical_discrepancy" });
	if (checks.blockedByPromotion) blockers.push({ kind: "promotion_pending" });
	return blockers;
}

function sorted(blockers: AttentionBlocker[]) {
	return blockers.toSorted((a, b) => PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind));
}

/**
 * What this viewer may do about the item's primary group. Maintain authority never makes another user's owner
 * work available, and agents or paired terminals never receive console decisions.
 */
function viewerActions(
	snapshot: RepositorySnapshot,
	group: AttentionGroup,
	blockers: AttentionBlocker[],
	owner: boolean,
	proposalId?: string,
): AttentionAction[] {
	const decide = snapshot.permissions.approve;
	const actions = new Set<AttentionAction>();
	if (group === "recovery") {
		const primary = blockers[0]?.kind;
		if ((primary === "promotion_unsettled" || primary === "promotion_unrecorded") && proposalId && snapshot.promotionRecovery[proposalId])
			actions.add("reconcile_promotion");
	} else if (group === "promote") {
		if (decide) actions.add("promote");
	} else if (group === "review") {
		for (const b of blockers.filter((b) => GROUP[b.kind] === "review")) {
			if (!decide) continue;
			actions.add(b.kind === "evidence_reported" ? "attest_evidence" : b.kind === "concern" ? "resolve_concern" : "approve");
		}
	} else if (owner) actions.add(group === "preparation" ? "prepare_revision" : "reconcile_with_git");
	return actions.size ? [...actions] : ["inspect"];
}

/** Read-only attention projection over one authorized snapshot. It reads no source and writes nothing. */
export function attentionView(snapshot: RepositorySnapshot, viewerId: string): AttentionView {
	const owners = new Map(snapshot.workspaces.map((w) => [w.id, w]));
	const items: AttentionItem[] = [];
	const covered = new Set<string>();
	for (const p of currentChanges(snapshot)) {
		const unrecorded = p.state === "promoted" && !!snapshot.promotionRecovery[p.id];
		if (p.state !== "open" && p.state !== "promoting" && !unrecorded) continue;
		const workspace = owners.get(p.workspaceId);
		if (!workspace) continue;
		covered.add(workspace.id);
		const blockers = sorted(changeBlockers(snapshot, p));
		const ready = !!snapshot.readiness[p.id]?.ready && p.state === "open";
		// Readiness is the controller's verdict; a change is only ready to promote when it says so.
		const group: AttentionGroup = blockers.length ? GROUP[blockers[0].kind] : ready ? "promote" : "review";
		const owner = workspace.ownerId === viewerId && snapshot.permissions.write;
		const actions = viewerActions(snapshot, group, blockers, owner, p.id);
		items.push({
			subject: "change",
			id: p.id,
			number: p.number,
			title: p.title,
			workspaceId: workspace.id,
			ownerId: workspace.ownerId,
			revision: p.revision,
			base: p.base,
			group,
			blockers,
			actions,
			mine: actions.some((a) => a !== "inspect"),
			at: p.at,
		});
	}
	let ancestryUnavailable = 0;
	for (const row of snapshot.reconciliation?.workspaces ?? []) {
		const workspace = owners.get(row.workspaceId);
		if (!workspace || ["completed", "cancelled"].includes(workspace.state)) continue;
		if (row.relation === "unknown") ancestryUnavailable++;
		if (covered.has(workspace.id)) continue;
		const blockers: AttentionBlocker[] = [];
		// A published revision behind canonical is already contained in it; only an unpublished baseline still needs merging.
		if (row.relation === "diverged" || row.relation === "unrelated" || (row.relation === "behind" && row.basis === "baseline"))
			blockers.push({ kind: "canonical_relation", relation: row.relation, canonical: row.canonicalRevision });
		if (row.incorporationCounts.missing) blockers.push({ kind: "ancestry_missing", count: row.incorporationCounts.missing });
		if (!blockers.length) continue;
		const owner = workspace.ownerId === viewerId && snapshot.permissions.write;
		const actions = viewerActions(snapshot, "reconciliation", blockers, owner);
		items.push({
			subject: "workspace",
			id: workspace.id,
			title: workspace.title,
			workspaceId: workspace.id,
			ownerId: workspace.ownerId,
			revision: row.revision,
			base: row.canonicalRevision,
			basis: row.basis,
			group: "reconciliation",
			blockers,
			actions,
			mine: actions.some((a) => a !== "inspect"),
			at: workspace.startedAt,
		});
	}
	items.sort(
		(a, b) =>
			ATTENTION_ORDER.indexOf(a.group) - ATTENTION_ORDER.indexOf(b.group) ||
			b.at - a.at ||
			(b.number ?? 0) - (a.number ?? 0) ||
			a.id.localeCompare(b.id),
	);
	return { asOf: snapshot.asOf ?? 0, viewerId, items, ancestryUnavailable };
}
