import { useState } from "react";
import { reportFreshness } from "../core/reconciliation.ts";
import { gitRemotePath } from "../shared/git-access.ts";
import type { AttentionGroup, Proposal, RepositorySnapshot, Workspace } from "../shared/platform.ts";
import { Form } from "./controls.tsx";
import { BackLink, CopyCommand, Dialog, Icon, Pill, Section } from "./design.tsx";
import { WorkspaceUpdateInspection } from "./inspect.tsx";
import { laneIndex } from "./lanes.ts";
import { LaneBullet, LaneMap, LaneStrip, LaneTrack } from "./lanes.tsx";
import { ArchivedRecord } from "./records.tsx";
import type { Execute } from "./source.tsx";
import {
	ACTION_LABELS,
	activityText,
	actorLabel,
	ago,
	attentionItem,
	blockerSummary,
	blockerText,
	canonicalRelation,
	canonicalTarget,
	changeGroups,
	changeStatus,
	ended,
	GROUP_LABELS,
	nextStep,
	overlapGroups,
	overlapsFor,
	ownerName,
	type People,
	RECONCILIATION_GUIDANCE,
	settledInMain,
	short,
	unproposed,
	updateHandoff,
	waitingOn,
	workedBy,
	workspaceStatus,
} from "./status.ts";

/**
 * How the owner updates a behind workspace when they decide to: words for any agent session, or a terminal command.
 * Nothing runs until the owner hands it over; Cruce wakes and messages no one.
 */
export function UpdateHandoff({ w, canonical }: { w: Pick<Workspace, "id" | "title">; canonical?: string }) {
	return (
		<div className="update-handoff">
			<p className="copy-label">When you want it updated, give this to any agent session:</p>
			<CopyCommand text={updateHandoff(w, canonical)} />
			<p className="copy-label">Or attach it in a terminal:</p>
			<CopyCommand text={`cruce resume --server ${location.origin} --workspace ${w.id}`} />
		</div>
	);
}

function ReportAge({ at, now }: { at?: number; now: number }) {
	const report = reportFreshness(at, now);
	return (
		<span>
			{report.state === "unknown"
				? "Report time unavailable"
				: `${report.state === "stale" ? "Stale report" : "Reported"} · ${ago(at!, now)}`}
		</span>
	);
}

type Open = (tab: string, id?: string, filter?: string) => void;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Recorded attachment provenance; it names how the checkout was attached, not what is executing now. */
function attachmentText(w: Workspace) {
	if (w.execution) {
		const by = w.execution.attachedBy;
		return `${cap(w.execution.kind)} attached ${by.kind === "human" && !by.connectionId ? "by" : "through"} ${actorLabel(by)}`;
	}
	if (w.state === "detached") return "No checkout attached";
	if (ended(w)) return workedBy(w);
	return "Waiting for a checkout to attach";
}

/** One line per row; the paths themselves are listed once above the list and in full on the workspace page. */
function OverlapSummary({ overlaps }: { overlaps: ReturnType<typeof overlapsFor> }) {
	const others = new Set(overlaps.flatMap((o) => o.others));
	return (
		<small className="overlap-note" title={overlaps.map((o) => o.path).join(", ")}>
			{overlaps.length === 1 ? "1 reported path" : `${overlaps.length} reported paths`} shared with{" "}
			{others.size === 1 ? [...others][0] : `${others.size} other workspaces`}
		</small>
	);
}

/**
 * What the list means as a whole and what to do next: published work waiting for a proposal, and paths several
 * workspaces report. Advisory only; it proposes nothing on its own and never orders or schedules the work.
 */
function WorkspaceBrief({ view, who, execute }: { view: RepositorySnapshot; who: People; execute: Execute }) {
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const waiting = view.workspaces.flatMap((w) => {
		const artifact = unproposed(view, w);
		return artifact ? [{ w, artifact }] : [];
	});
	const mine = view.permissions.write ? waiting.filter(({ w }) => w.ownerId === who.viewerId) : [];
	const groups = overlapGroups(view);
	if (!waiting.length && !groups.length) return null;
	return (
		<div className="workspace-brief">
			{waiting.length > 0 && (
				<section aria-label="Published work not yet proposed">
					<p>
						<strong>
							{waiting.length} published {waiting.length === 1 ? "revision has" : "revisions have"} no change yet.
						</strong>{" "}
						Publishing retains the exact revision; a human can only review it once it is proposed as a change. Ask the agent to propose it,
						or propose it here.
					</p>
					{mine.length > 0 && (
						<button
							type="button"
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								setError("");
								try {
									for (const { artifact } of mine)
										await execute({ tool: "create_proposal", artifactId: artifact.id, title: artifact.title });
								} catch (e) {
									setError((e as Error).message);
								} finally {
									setBusy(false);
								}
							}}
						>
							{busy ? "Proposing…" : `Propose ${mine.length === 1 ? "this revision" : `all ${mine.length} for review`}`}
						</button>
					)}
					{error && <p role="alert">{error}</p>}
				</section>
			)}
			{groups.slice(0, 3).map((group) => (
				<p key={group.workspaces.join("|")} className="overlap-note">
					{group.paths.length} {group.paths.length === 1 ? "path is" : "paths are"} reported by{" "}
					{group.workspaces.length === view.workspaces.filter((w) => !ended(w)).length
						? `all ${group.workspaces.length} workspaces`
						: group.workspaces.map((id) => view.workspaces.find((w) => w.id === id)?.title ?? "another workspace").join(", ")}
					: {group.paths.slice(0, 6).join(", ")}
					{group.paths.length > 6 ? " and more" : ""}. A heads-up, not a conflict. Whichever change is promoted first moves canonical; the
					others then take a normal Git update, which is where these paths get merged.
				</p>
			))}
		</div>
	);
}

function WorkspaceRow({
	view,
	w,
	open,
	who,
	focused,
	setFocus,
}: {
	view: RepositorySnapshot;
	w: Workspace;
	open: Open;
	who: People;
	focused?: boolean;
	setFocus?: (id?: string) => void;
}) {
	const status = workspaceStatus(w),
		relation = canonicalRelation(view, w),
		overlaps = overlapsFor(view, w),
		waiting = unproposed(view, w),
		item = attentionItem(view, w.id),
		change = view.proposals.filter((p) => p.workspaceId === w.id).sort((a, b) => b.number - a.number)[0];
	return (
		<button
			type="button"
			className={`workspace-row${focused ? " is-focus" : ""}`}
			onClick={() => open("workspaces", w.id)}
			onMouseEnter={() => setFocus?.(w.id)}
			onMouseLeave={() => setFocus?.(undefined)}
			onFocus={() => setFocus?.(w.id)}
			onBlur={() => setFocus?.(undefined)}
		>
			<LaneTrack lane={laneIndex(view).get(w.id)} done={ended(w)} quiet={w.state === "disconnected"} />
			<span className="row-main">
				<strong>{w.title}</strong>
				<small className="row-meta">
					<span className="owner">Owner: {ownerName(w.ownerId, who)}</span>
					<span>{w.state === "disconnected" ? "Not reporting; checkout remains attached" : attachmentText(w)}</span>
					<span>
						<ReportAge at={w.lastReportAt} now={view.asOf ?? Date.now()} />
					</span>
				</small>
				{item && (
					<small className="row-blocker">
						{blockerSummary(item)} · {item.mine ? ACTION_LABELS[item.actions[0]] : waitingOn(item)}
					</small>
				)}
				{waiting && !item && (
					<small className="row-blocker">
						Published {short(waiting.revision)} · no change yet · <span className="next-mine">Propose it for review</span>
					</small>
				)}
				{overlaps.length > 0 && <OverlapSummary overlaps={overlaps} />}
			</span>
			<span className="row-pills">
				<Pill tone={status.tone}>{status.label}</Pill>
				{!ended(w) && <Pill tone={relation.tone}>{relation.label}</Pill>}
				{waiting && !change && <Pill tone="accent">Not proposed</Pill>}
			</span>
			<Icon name="arrow" className="row-arrow" />
		</button>
	);
}

/**
 * A change row leads with the accountable owner, the exact revision and what blocks it. Nested under its workspace it drops
 * the owner and workspace, and a title that only repeats the workspace's stays for screen readers alone.
 */
export function ChangeRow({
	view,
	p,
	open,
	who,
	nested,
}: {
	view: RepositorySnapshot;
	p: Proposal;
	open: Open;
	who: People;
	nested?: boolean;
}) {
	const s = changeStatus(view, p),
		item = attentionItem(view, p.id),
		workspace = view.workspaces.find((w) => w.id === p.workspaceId),
		repeated = nested && workspace?.title.trim() === p.title.trim();
	return (
		<button type="button" className={`change-row${nested ? " nested" : ""}`} onClick={() => open("changes", p.id)}>
			{!nested && <LaneTrack lane={laneIndex(view).get(p.workspaceId)} done={s.key === "promoted"} />}
			<span className="row-number">#{p.number}</span>
			<span className="row-main">
				<strong className={repeated ? "sr-only" : undefined}>{p.title}</strong>
				<small className="row-meta">
					{workspace && !nested && <span className="owner">Owner: {ownerName(workspace.ownerId, who)}</span>}
					<span>
						<code title={p.revision}>{short(p.revision)}</code> on review base <code title={p.base}>{short(p.base)}</code>
					</span>
					{workspace && !nested && <span>{workspace.title}</span>}
				</small>
				{item && (
					<small className="row-blocker">
						{blockerSummary(item)}
						{" · "}
						<span className={item.mine ? "next-mine" : undefined}>{item.mine ? ACTION_LABELS[item.actions[0]] : waitingOn(item)}</span>
					</small>
				)}
			</span>
			<Pill tone={s.tone}>{s.label}</Pill>
			<Icon name="arrow" className="row-arrow" />
		</button>
	);
}

function CloseSuperseded({ view, execute }: { view: RepositorySnapshot; execute: Execute }) {
	const [working, setWorking] = useState(false),
		[error, setError] = useState("");
	const superseded = view.proposals.map((p) => ({ p, status: changeStatus(view, p) })).filter(({ status }) => status.key === "superseded");
	if (!superseded.length || !view.permissions.maintain || !view.permissions.human) return null;
	return (
		<div className="group-actions">
			<button
				type="button"
				disabled={working}
				onClick={() => {
					setWorking(true);
					setError("");
					// One reasoned rejection per change; each keeps its own operation identity.
					void superseded
						.reduce<Promise<unknown>>(
							(chain, { p, status }) => chain.then(() => execute({ tool: "reject_proposal", proposalId: p.id, reason: status.label })),
							Promise.resolve(),
						)
						.catch((e) => setError((e as Error).message))
						.finally(() => setWorking(false));
				}}
			>
				{working ? "Closing…" : `Close ${superseded.length === 1 ? "1 superseded change" : `${superseded.length} superseded changes`}`}
			</button>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}

/** Every blocker for a change, worded from the structured attention projection rather than reason strings. */
function changeBlockers(view: RepositorySnapshot, proposalId: string) {
	const item = attentionItem(view, proposalId);
	if (!item) return "Readiness unavailable";
	return item.blockers.length ? item.blockers.map(blockerText).join(" · ") : "Ready for human promotion";
}

function Reconciliation({ view, open }: { view: RepositorySnapshot; open: Open }) {
	const r = view.reconciliation;
	if (!r) return null;
	return (
		<section className="panel" aria-label="Reconciliation">
			<div className="panel-head">
				<h2>Reconciliation</h2>
				<span>
					Observation {r.observation.state}
					{r.observation.pending ? ` · ${r.observation.pending} checks pending` : ""}
				</span>
			</div>
			<p className="panel-note">
				Accepted <code>{short(r.acceptedRevision)}</code> · Observed canonical{" "}
				<code>{r.observation.canonical?.deleted ? "ref deleted" : short(r.observation.canonical?.revision)}</code>
				{r.observation.lastCheckedAt !== undefined
					? ` · checked ${ago(r.observation.lastCheckedAt, r.asOf)}`
					: " · no complete observation yet"}
				. {r.observation.reason}
			</p>
			<div className="rows">
				{r.workspaces
					.filter((row) => view.workspaces.some((w) => w.id === row.workspaceId))
					.map((row) => {
						const workspace = view.workspaces.find((w) => w.id === row.workspaceId)!;
						const missing = row.incorporationCounts.missing;
						const unknown = row.incorporationCounts.unknown;
						return (
							<button
								type="button"
								className="reconciliation-row"
								key={row.workspaceId}
								aria-label={`Inspect reconciliation for ${workspace.title}`}
								onClick={() => open("workspaces", row.workspaceId)}
							>
								<span className="row-main">
									<strong>{workspace.title}</strong>
									<small>
										{row.basis === "published" ? "Published" : "Baseline only"} <code>{short(row.revision)}</code> ·{" "}
										{canonicalRelation(view, workspace).label}
									</small>
									<small>
										{row.basis === "baseline"
											? "Incorporation unverified before publication"
											: missing
												? `${missing} accepted revisions missing`
												: unknown
													? `${unknown} accepted revisions unverified`
													: row.incorporationCounts.present
														? "Accepted revisions incorporated"
														: "No accepted promotions to compare"}
									</small>
									<small>
										<ReportAge at={row.report.reportedAt} now={r.asOf} />
									</small>
								</span>
							</button>
						);
					})}
			</div>
			{r.proposals.length > 0 && (
				<div className="rows">
					{r.proposals
						.filter((row) => view.proposals.some((p) => p.id === row.proposalId))
						.map((row) => {
							const proposal = view.proposals.find((p) => p.id === row.proposalId)!;
							return (
								<button type="button" className="reconciliation-row" key={row.proposalId} onClick={() => open("changes", row.proposalId)}>
									<span className="row-main">
										<strong>
											#{proposal.number} {proposal.title}
											{row.stale ? " · stale" : ""}
										</strong>
										<small>{changeBlockers(view, row.proposalId)}</small>
									</span>
								</button>
							);
						})}
				</div>
			)}
		</section>
	);
}

/** Owner and canonical-relation filters, kept in the URL so links and Back restore them. */
function matches(view: RepositorySnapshot, w: Workspace, filter: string, viewerId?: string) {
	if (filter === "mine") return w.ownerId === viewerId;
	if (filter === "reconcile") return attentionItem(view, w.id)?.group === "reconciliation";
	if (filter === "unproposed") return !!unproposed(view, w);
	if (filter.startsWith("owner:")) return w.ownerId === filter.slice(6);
	return true;
}

/** Attention groups a change can be filtered by; the attention strip links to them. */
const groupFilters: readonly string[] = ["recovery", "promote", "review", "preparation", "reconciliation"] satisfies AttentionGroup[];

/**
 * The repository's work in one list: each workspace once, with its open changes nested under it in attention order.
 * Workspaces with something to decide come first. Open changes whose workspace has ended keep their own section.
 */
export function WorkspaceList({
	view,
	open,
	who,
	execute,
	filter = "",
}: {
	view: RepositorySnapshot;
	open: Open;
	who: People;
	execute: Execute;
	filter?: string;
}) {
	const [focus, setFocus] = useState<string>();
	const owners = [...new Set(view.workspaces.map((w) => w.ownerId))];
	const group = groupFilters.includes(filter) ? (filter as AttentionGroup) : undefined;
	const active =
		filter === "needs-you" ||
		filter === "mine" ||
		filter === "reconcile" ||
		filter === "unproposed" ||
		group ||
		(filter.startsWith("owner:") && owners.includes(filter.slice(6)))
			? filter
			: "";
	const groups = changeGroups(view);
	const proposal = (id: string) => view.proposals.find((p) => p.id === id);
	const openItems = groups.attention.flatMap(({ items }) => items).filter((item) => proposal(item.id));
	const shownItems = openItems.filter((item) => (active === "needs-you" ? item.mine : group ? item.group === group : true));
	const changesOf = (w: Workspace) =>
		shownItems.filter((item) => proposal(item.id)?.workspaceId === w.id).map((item) => proposal(item.id)!);
	const rank = (w: Workspace) => {
		const items = openItems.filter((item) => proposal(item.id)?.workspaceId === w.id);
		return items.some((item) => item.mine) ? 0 : items.length ? 1 : 2;
	};
	const visible = (w: Workspace) =>
		active === "needs-you"
			? changesOf(w).length > 0 || !!attentionItem(view, w.id)?.mine
			: group
				? changesOf(w).length > 0 || (group === "reconciliation" && attentionItem(view, w.id)?.group === group)
				: matches(view, w, active, who.viewerId);
	const sorted = [...view.workspaces]
		.filter(visible)
		.sort((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
	const live = sorted.filter((w) => !ended(w)),
		done = sorted.filter(ended),
		// A workspace with an open change never folds away; its decision stays in the main list.
		folds = (w: Workspace) => !changesOf(w).length,
		detached = live.filter((w) => w.state === "detached" && folds(w)),
		settled = live.filter((w) => w.state !== "detached" && settledInMain(view, w) && folds(w)),
		attached = live.filter((w) => !detached.includes(w) && !settled.includes(w));
	const liveIds = new Set(view.workspaces.filter((w) => !ended(w)).map((w) => w.id));
	const orphans = shownItems
		.map((item) => proposal(item.id)!)
		.filter((p) => !liveIds.has(p.workspaceId))
		.filter((p) => {
			if (!active || active === "needs-you" || group) return true;
			const w = view.workspaces.find((x) => x.id === p.workspaceId);
			return !!w && matches(view, w, active, who.viewerId);
		});
	const degraded = view.reconciliation?.observation.state === "degraded";
	const filterButton = (value: string, label: string) => (
		<button type="button" aria-pressed={active === value} onClick={() => open("workspaces", undefined, value || undefined)}>
			{label}
		</button>
	);
	return (
		<>
			<section className="panel workspaces-screen">
				<div className="panel-head">
					<h2>{active ? "Matching workspaces" : "Active workspaces"}</h2>
					<span className="panel-count">{live.length}</span>
				</div>
				{view.attention?.items.some((item) => item.group === "reconciliation") && <p className="panel-note">{RECONCILIATION_GUIDANCE}</p>}
				<WorkspaceBrief view={view} who={who} execute={execute} />
				<div className="list-filters">
					<nav className="segmented filters" aria-label="Filter workspaces">
						{filterButton("", "All")}
						{filterButton("needs-you", "Needs you")}
						{filterButton("mine", "Mine")}
						{filterButton("reconcile", "Needs Git update")}
						{filterButton("unproposed", "Not proposed")}
						{group && (
							<button type="button" aria-pressed="true" onClick={() => open("workspaces")}>
								{GROUP_LABELS[group].label} · show all
							</button>
						)}
					</nav>
					{owners.length > 1 && (
						<label className="owner-filter">
							Owner
							<select
								value={active.startsWith("owner:") ? active : ""}
								onChange={(e) => open("workspaces", undefined, e.target.value || undefined)}
							>
								<option value="">Everyone</option>
								{owners.map((id) => (
									<option key={id} value={`owner:${id}`}>
										{ownerName(id, who)}
									</option>
								))}
							</select>
						</label>
					)}
				</div>
				{(active === "needs-you" || group) && (
					<p className="panel-note" role="status">
						Showing {shownItems.length} of {openItems.length} open {openItems.length === 1 ? "change" : "changes"}.
					</p>
				)}
				{attached.length ? (
					<div className="rows">
						{attached.map((w) => (
							<div className="workspace-item" key={w.id}>
								<WorkspaceRow view={view} w={w} open={open} who={who} focused={focus === w.id} setFocus={setFocus} />
								{changesOf(w).length > 0 && (
									<div className={`nested-changes lane-${laneIndex(view).get(w.id) ?? 1}`}>
										{changesOf(w).map((p) => (
											<ChangeRow key={p.id} view={view} p={p} open={open} who={who} nested />
										))}
									</div>
								)}
							</div>
						))}
					</div>
				) : (
					<p className="panel-note">
						{active === "needs-you"
							? "Nothing here needs you right now."
							: active
								? "No active workspaces match this filter."
								: "No active workspaces. One appears when you or an agent starts work through Cruce. Use Clone next to the canonical revision to begin."}
					</p>
				)}
				{orphans.length > 0 && (
					<section className="ended-changes" aria-label="Open changes from ended workspaces">
						<h3>
							Open changes from ended workspaces <span className="panel-count">{orphans.length}</span>
						</h3>
						<div className="rows">
							{orphans.map((p) => (
								<ChangeRow key={p.id} view={view} p={p} open={open} who={who} />
							))}
						</div>
					</section>
				)}
				{settled.length > 0 && (
					<details className="group settled-workspaces" open={active ? true : undefined}>
						<summary>
							{settled.length} already in {view.repository.defaultBranch}
							<span className="muted"> · nothing left to decide, folded away</span>
						</summary>
						<div className="rows">
							{settled.map((w) => (
								<WorkspaceRow key={w.id} view={view} w={w} open={open} who={who} focused={focus === w.id} setFocus={setFocus} />
							))}
						</div>
					</details>
				)}
				{detached.length > 0 && (
					<details className="group detached-workspaces" open={active ? true : undefined}>
						<summary>
							{detached.length} detached {detached.length === 1 ? "workspace" : "workspaces"}
							<span className="muted"> · revisions and changes retained</span>
						</summary>
						<div className="rows">
							{detached.map((w) => (
								<WorkspaceRow key={w.id} view={view} w={w} open={open} who={who} focused={focus === w.id} setFocus={setFocus} />
							))}
						</div>
					</details>
				)}
				{done.length > 0 && (
					<details className="group">
						<summary>
							{done.length} ended {done.length === 1 ? "workspace" : "workspaces"}
						</summary>
						<div className="rows">
							{done.map((w) => (
								<WorkspaceRow key={w.id} view={view} w={w} open={open} who={who} />
							))}
						</div>
					</details>
				)}
				{!active && groups.inactive.length > 0 && (
					<details className="group">
						<summary>
							{groups.inactive.length} superseded {groups.inactive.length === 1 ? "change" : "changes"}
						</summary>
						<CloseSuperseded view={view} execute={execute} />
						<div className="rows">
							{groups.inactive.map((p) => (
								<ChangeRow key={p.id} view={view} p={p} open={open} who={who} />
							))}
						</div>
					</details>
				)}
				{!active && groups.done.length > 0 && (
					<details className="group">
						<summary>
							{groups.done.length} promoted or closed {groups.done.length === 1 ? "change" : "changes"}
						</summary>
						<div className="rows">
							{groups.done.map((p) => (
								<ChangeRow key={p.id} view={view} p={p} open={open} who={who} />
							))}
						</div>
					</details>
				)}
			</section>
			<LaneMap view={view} focus={focus} setFocus={setFocus} open={(id) => open("workspaces", id)} who={who} />
			{view.reconciliation && (
				<details className="group reconciliation-details" open={degraded || active === "reconcile" ? true : undefined}>
					<summary>
						Reconciliation<span className="muted"> · observation {view.reconciliation.observation.state}</span>
					</summary>
					<Reconciliation view={view} open={open} />
				</details>
			)}
		</>
	);
}

/**
 * How this workspace continues through another connection or machine of the same owner, using the existing detach and
 * resume operations. Only pushed commits travel; Cruce cannot see or move unpushed local work.
 */
function ContinuationGuide({ view, w, who }: { view: RepositorySnapshot; w: Workspace; who: People }) {
	const observed = view.reconciliation?.observation.workspaces[w.id];
	if (w.ownerId !== who.viewerId)
		return (
			<Section title="Continue this workspace">
				<p className="side-body continuation">
					Only {ownerName(w.ownerId, who)} can attach this workspace, through any of their authorized connections. Others can inspect it and
					review its changes; transferring ownership is not supported.
				</p>
			</Section>
		);
	return (
		<Section title="Continue this workspace">
			<div className="side-body continuation">
				<p>
					Continuing keeps this workspace's ID, baseline <code title={w.baseRevision}>{short(w.baseRevision)}</code>, fork and history. Only
					pushed commits travel: reported head <code title={w.headRevision}>{short(w.headRevision)}</code>
					{observed && !observed.deleted ? (
						<>
							{observed.revision === w.headRevision ? " matches" : " differs from"} the fork branch observed at{" "}
							<code title={observed.revision}>{short(observed.revision)}</code>
						</>
					) : (
						"; the fork branch has not been observed"
					)}
					{w.publishedRevision ? (
						<>
							; last published <code title={w.publishedRevision}>{short(w.publishedRevision)}</code>.
						</>
					) : (
						"; no published revision."
					)}
				</p>
				<ol className="steps compact">
					{w.execution && (
						<li>
							On the attached checkout, commit and push what should travel, then release it with <code>cruce detach</code> or Release
							checkout below. If that machine is unavailable, its unpushed work cannot be recovered from here.
						</li>
					)}
					<li>
						On the destination, authorize your connection to this repository, then attach a replacement checkout from the fork head:
						<CopyCommand text={`cruce resume --server ${location.origin} --workspace ${w.id}`} />
					</li>
					<li>Reports from the previous checkout are rejected once the replacement is attached.</li>
				</ol>
				<p className="muted">Detaching does not revoke the previous connection's Git access; it can still push if its credentials allow.</p>
			</div>
		</Section>
	);
}

export function WorkspaceDetail({
	view,
	id,
	execute,
	open,
	who,
}: {
	view: RepositorySnapshot;
	id: string;
	execute: Execute;
	open: Open;
	who: People;
}) {
	const w = view.workspaces.find((s) => s.id === id);
	const [error, setError] = useState(""),
		[confirming, setConfirming] = useState(false);
	if (!w) return <ArchivedRecord key={id} id={id} execute={execute} open={open} who={who} missing="This workspace is unavailable." />;
	const status = workspaceStatus(w),
		relation = canonicalRelation(view, w),
		overlaps = overlapsFor(view, w),
		latest = view.proposals.filter((p) => p.workspaceId === w.id).sort((a, b) => b.number - a.number)[0],
		item = attentionItem(view, w.id) ?? (latest && attentionItem(view, latest.id)),
		release = view.executionRelease[w.id],
		deletion = view.workspaceDeletion[w.id],
		changes = view.proposals.filter((p) => p.workspaceId === w.id).sort((a, b) => b.number - a.number),
		published = view.artifacts.filter((a) => a.workspaceId === w.id && a.kind === "source"),
		waiting = view.permissions.write && w.ownerId === who.viewerId ? unproposed(view, w) : undefined,
		activity = view.activity
			.filter((e) => e.ids.includes(w.id))
			.slice(-12)
			.toReversed();
	const observed = view.reconciliation?.observation.workspaces[w.id];
	const run = (cmd: Parameters<Execute>[0]) => {
		setError("");
		void execute(cmd).catch((e) => setError((e as Error).message));
	};
	return (
		<article className="workspace-page detail-page">
			<BackLink label="Workspaces" onClick={() => open("workspaces")} />
			<header className="page-header change-header">
				<div className="page-title">
					<p className="kicker">
						<span>Workspace</span>
						{w.branch && <code>{w.branch}</code>}
					</p>
					<h1>{w.title}</h1>
					<p className="change-meta">
						<LaneBullet lane={laneIndex(view).get(w.id)} />
						<Pill tone={status.tone}>{status.label}</Pill>
						{!ended(w) && <Pill tone={relation.tone}>{relation.label}</Pill>}
						<span className="owner">Owner: {ownerName(w.ownerId, who)}</span>
						<span>{workedBy(w)}</span>
					</p>
					{w.description && <p className="page-lead">{w.description}</p>}
				</div>
			</header>
			<LaneStrip view={view} workspace={w} lane={laneIndex(view).get(w.id) ?? 1} />
			{item && (
				<div className="ws-next">
					<p>
						{blockerSummary(item)}. {nextStep(item)}.{item.group === "reconciliation" && ` ${RECONCILIATION_GUIDANCE}`}
					</p>
					{item.actions.includes("reconcile_with_git") && <UpdateHandoff w={w} canonical={canonicalTarget(item)} />}
				</div>
			)}
			<dl className="facts fact-grid ws-facts">
				<div>
					<dt>Owner</dt>
					<dd>
						{ownerName(w.ownerId, who)}
						<small>
							{attachmentText(w)}
							{w.execution && ` · since ${ago(w.execution.attachedAt)}`}
							{w.state === "disconnected" && " · not reporting"}
						</small>
					</dd>
				</div>
				<div data-fact="baseline">
					<dt>Baseline</dt>
					<dd>
						<code title={w.baseRevision}>{short(w.baseRevision)}</code>
						<small>Fixed starting revision · {ago(w.startedAt)}</small>
					</dd>
				</div>
				<div>
					<dt>Published</dt>
					<dd>
						{w.publishedRevision ? (
							<>
								<code title={w.publishedRevision}>{short(w.publishedRevision)}</code>
								{w.integratedRevision && (
									<small>
										On review base <code title={w.integratedRevision}>{short(w.integratedRevision)}</code>
									</small>
								)}
							</>
						) : (
							<span className="muted">Nothing published yet</span>
						)}
					</dd>
				</div>
				<div>
					<dt>Reported head</dt>
					<dd>
						<code title={w.headRevision}>{short(w.headRevision)}</code>
						<small>
							{w.commits.length} {w.commits.length === 1 ? "commit" : "commits"}, {w.changes.length}{" "}
							{w.changes.length === 1 ? "file" : "files"} · <ReportAge at={w.lastReportAt} now={view.asOf ?? Date.now()} />
							{observed && !observed.deleted && observed.revision !== w.headRevision && " · differs from the observed pushed ref"}
						</small>
					</dd>
				</div>
				<div>
					<dt>Canonical</dt>
					<dd>
						<span className={`ws-relation ${relation.tone}`}>{relation.label}</span>
						<small>{relation.detail}</small>
					</dd>
				</div>
				{observed && (
					<div>
						<dt>Observed pushed ref</dt>
						<dd>
							<code>{observed.deleted ? "ref unavailable" : short(observed.revision)}</code>
							<small>
								<code>{observed.ref}</code> · checked {ago(observed.checkedAt, view.asOf)} · observed, not published
							</small>
						</dd>
					</div>
				)}
				{overlaps.length > 0 && (
					<div className="wide">
						<dt>Overlap</dt>
						<dd>
							{overlaps.map((o) => (
								<span key={o.path} className="overlap-line">
									<code>{o.path}</code> is also changed in {o.others.join(", ")}.
									<small className="muted">
										{o.observedAt === undefined
											? "Report time unavailable."
											: `Reports from ${ago(o.observedAt, view.asOf)}${reportFreshness(o.observedAt, view.asOf ?? Date.now()).state === "stale" ? " · stale reports" : ""}.`}
									</small>
								</span>
							))}
							<small className="muted">Shared files are a heads-up, not a conflict.</small>
						</dd>
					</div>
				)}
				<details className="wide ws-ids">
					<summary>Identifiers</summary>
					<p>
						Workspace <code>{w.id}</code>
						{w.execution && (
							<>
								{" "}
								· machine <code>{w.execution.machineId}</code> · checkout <code>{w.execution.checkoutId}</code>
							</>
						)}
					</p>
				</details>
			</dl>
			{!ended(w) && (relation.key === "behind" || relation.key === "diverged") && <WorkspaceUpdateInspection id={w.id} execute={execute} />}
			<div className="overview">
				<div className="overview-main">
					<Section title="Changes" count={changes.length}>
						{changes.length ? (
							<div className="rows">
								{changes.map((p) => {
									const s = changeStatus(view, p);
									return (
										<button type="button" key={p.id} className="change-row" onClick={() => open("changes", p.id)}>
											<span className="row-number">#{p.number}</span>
											<span className="row-main">
												<strong>{p.title}</strong>
												<small className="row-meta">
													<span>
														<code>{short(p.revision)}</code> on <code>{short(p.base)}</code>
													</span>
												</small>
											</span>
											<Pill tone={s.tone}>{s.label}</Pill>
											<Icon name="arrow" className="row-arrow" />
										</button>
									);
								})}
							</div>
						) : (
							<p className="panel-note">
								{published.length
									? "Published, but not proposed for review yet."
									: "Nothing published yet. Push commits, then publish a revision."}
							</p>
						)}
						{waiting && (
							<Form
								label="Propose for review"
								submit={(d) =>
									execute({ tool: "create_proposal", artifactId: waiting.id, title: String(d.get("title") ?? "").trim() || waiting.title })
								}
							>
								<label>
									Change title
									<input name="title" defaultValue={w.title} required />
								</label>
								<small className="muted">
									Proposes exactly <code title={waiting.revision}>{short(waiting.revision)}</code>. Nothing is promoted until a maintainer
									approves it.
								</small>
							</Form>
						)}
					</Section>
					{w.changes.length > 0 && (
						<details className="group">
							<summary>
								{w.changes.length} reported {w.changes.length === 1 ? "file" : "files"}
							</summary>
							<ul className="file-list">
								{w.changes.map((c) => (
									<li key={c.path}>
										<code>
											{c.previousPath ? `${c.previousPath} → ` : ""}
											{c.path}
										</code>
										<span>
											{c.status}
											{c.binary ? " · binary" : ""}
										</span>
									</li>
								))}
							</ul>
						</details>
					)}
					{activity.length > 0 && (
						<Section title="Activity">
							<ol className="feed">
								{activity.map((e) => (
									<li key={e.id}>
										<time>{ago(e.at)}</time>
										<span>{activityText(e)}</span>
									</li>
								))}
							</ol>
						</Section>
					)}
				</div>
				<aside className="overview-side" aria-label="Checkout and storage">
					{!ended(w) && <ContinuationGuide view={view} w={w} who={who} />}
					<Section title="Checkout and storage">
						<div className="side-body">
							<p>
								{w.execution
									? `Attached to a ${w.execution.kind} through ${actorLabel(w.execution.attachedBy)} since ${ago(w.execution.attachedAt)}.`
									: w.state === "detached"
										? "Not attached to a checkout. Its owner can continue it from another checkout or machine."
										: ended(w)
											? "Ended. Its commits, published revisions and history are kept."
											: "Waiting for a checkout to attach."}
							</p>
							{release?.ready && (
								<button type="button" className="ghost" onClick={() => run({ tool: "detach_workspace", workspaceId: w.id })}>
									Release checkout
								</button>
							)}
							{w.fork?.state === "ready" && (
								<CopyCommand text={`git fetch ${location.origin}${gitRemotePath(view.repository.namespaceId, view.repository.id, w.id)}`} />
							)}
							{w.cleanup && w.cleanup.state !== "complete" && (
								<p role="status">
									{w.cleanup.state === "pending"
										? "Deleting its cloud fork. This finishes on its own."
										: w.retention?.blockers.length
											? "Deletion stopped. Publish the commits listed below, or delete those refs with Git, then delete again."
											: `Deletion stopped. ${w.cleanup.reason ?? "Delete again to retry."}`}
								</p>
							)}
							{w.retention && w.retention.blockers.length > 0 && (
								<section aria-label="Retention blockers">
									{w.retention.blockers.map((blocker) => (
										<p key={blocker}>{blocker}</p>
									))}
									<ul className="file-list">
										{w.retention.refs
											.filter((ref) => !ref.retained)
											.map((ref) => (
												<li key={ref.ref}>
													<code>{ref.ref}</code>
													<code>{short(ref.revision)}</code>
													<span>{ref.reason === "unavailable" ? "retention unavailable" : "not published"}</span>
												</li>
											))}
									</ul>
								</section>
							)}
							{deletion?.ready && (
								<button type="button" className="danger-button" onClick={() => setConfirming(true)}>
									Delete workspace…
								</button>
							)}
							{error && <p role="alert">{error}</p>}
						</div>
					</Section>
				</aside>
			</div>
			{confirming && <DeleteWorkspace w={w} changes={changes} execute={execute} close={() => setConfirming(false)} open={open} />}
		</article>
	);
}

/** One confirmation for the whole cleanup: end, withdraw open changes, release the checkout and delete the fork. */
function DeleteWorkspace({
	w,
	changes,
	execute,
	close,
	open,
}: {
	w: Workspace;
	changes: RepositorySnapshot["proposals"];
	execute: Execute;
	close: () => void;
	open: Open;
}) {
	// Work that reached canonical finished; anything else is abandoned, which withdraws its open changes.
	const cancelled = !changes.some((p) => p.state === "promoted"),
		openChanges = ended(w) ? 0 : changes.filter((p) => p.state === "open").length,
		fork = w.fork && w.fork.state !== "deleted";
	return (
		<Dialog title={`Delete ${w.title}`} close={close}>
			<ul>
				{!ended(w) && <li>Ends the workspace{w.execution ? ` and releases its checkout on ${w.execution.machineId}` : ""}.</li>}
				{openChanges > 0 &&
					(cancelled ? (
						<li>Withdraws {openChanges === 1 ? "its open change" : `its ${openChanges} open changes`}.</li>
					) : (
						<li>Its open {openChanges === 1 ? "change stays" : "changes stay"} open for review.</li>
					))}
				{fork && <li>Deletes its cloud fork. This uses one namespace operation.</li>}
				<li>Published revisions and history stay in History under Earlier work.</li>
				<li>Local files are not touched{w.execution ? "; unpushed work stays on that machine" : ""}.</li>
			</ul>
			{fork && (
				<p className="muted">Commits pushed to the fork but never published stop the fork deletion, so nothing unpublished is lost.</p>
			)}
			<Form
				label="Delete workspace"
				danger
				primary
				cancel={close}
				submit={async () => {
					if (!ended(w)) await execute({ tool: "end_workspace", workspaceId: w.id, cancelled });
					if (fork) await execute(w.cleanup?.command ?? { tool: "cleanup_workspace", workspaceId: w.id });
					close();
					open("workspaces");
				}}
			>
				{null}
			</Form>
		</Dialog>
	);
}
