import { useState } from "react";
import { reportFreshness } from "../core/reconciliation.ts";
import { gitRemotePath } from "../shared/git-access.ts";
import type { RepositorySnapshot, Workspace } from "../shared/platform.ts";
import { BackLink, CopyCommand, Icon, Pill, Section } from "./design.tsx";
import { WorkspaceUpdateInspection } from "./inspect.tsx";
import { laneIndex } from "./lanes.ts";
import { LaneBullet, LaneMap, LaneStrip, LaneTrack } from "./lanes.tsx";
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
	changeStatus,
	ended,
	nextStep,
	overlapsFor,
	ownerName,
	type People,
	short,
	waitingOn,
	workedBy,
	workspaceStatus,
} from "./status.ts";

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
const CRUCE = "/path/to/cruce";

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
		item = attentionItem(view, w.id),
		change = view.proposals.filter((p) => p.workspaceId === w.id).sort((a, b) => b.number - a.number)[0];
	const changeLabel = change && changeStatus(view, change);
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
				{overlaps.length > 0 && (
					<small className="overlap-note">
						Shares reported paths {overlaps.map((o) => o.path).join(", ")} with {[...new Set(overlaps.flatMap((o) => o.others))].join(", ")}
					</small>
				)}
			</span>
			<span className="row-pills">
				<Pill tone={status.tone}>{status.label}</Pill>
				{!ended(w) && <Pill tone={relation.tone}>{relation.label}</Pill>}
				{change && changeLabel && <Pill tone={changeLabel.tone}>{`#${change.number} ${changeLabel.label}`}</Pill>}
			</span>
			<Icon name="arrow" className="row-arrow" />
		</button>
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
	if (filter.startsWith("owner:")) return w.ownerId === filter.slice(6);
	return true;
}

export function WorkspaceList({ view, open, who, filter = "" }: { view: RepositorySnapshot; open: Open; who: People; filter?: string }) {
	const [focus, setFocus] = useState<string>();
	const owners = [...new Set(view.workspaces.map((w) => w.ownerId))];
	const active =
		filter === "mine" || filter === "reconcile" || (filter.startsWith("owner:") && owners.includes(filter.slice(6))) ? filter : "";
	const sorted = [...view.workspaces]
		.filter((w) => matches(view, w, active, who.viewerId))
		.sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
	const live = sorted.filter((w) => !ended(w)),
		done = sorted.filter(ended);
	return (
		<>
			<LaneMap view={view} focus={focus} setFocus={setFocus} open={(id) => open("workspaces", id)} who={who} />
			<section className="panel workspaces-screen">
				<div className="panel-head">
					<h2>{active ? "Matching workspaces" : "Active workspaces"}</h2>
					<span className="panel-count">{live.length}</span>
				</div>
				<div className="list-filters">
					<nav className="segmented filters" aria-label="Filter workspaces">
						<button type="button" aria-pressed={!active} onClick={() => open("workspaces")}>
							All
						</button>
						<button type="button" aria-pressed={active === "mine"} onClick={() => open("workspaces", undefined, "mine")}>
							Mine
						</button>
						<button type="button" aria-pressed={active === "reconcile"} onClick={() => open("workspaces", undefined, "reconcile")}>
							Needs reconciliation
						</button>
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
				{live.length ? (
					<div className="rows">
						{live.map((w) => (
							<WorkspaceRow key={w.id} view={view} w={w} open={open} who={who} focused={focus === w.id} setFocus={setFocus} />
						))}
					</div>
				) : (
					<p className="panel-note">
						{active
							? "No active workspaces match this filter."
							: "No active workspaces. One appears when you or an agent starts work through Cruce. Use Connect an agent to begin."}
					</p>
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
			</section>
			<Reconciliation view={view} open={open} />
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
						<CopyCommand text={`node ${CRUCE}/runner/cruce.mjs resume --server ${location.origin} --workspace ${w.id}`} />
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
	const [error, setError] = useState("");
	if (!w) return <p className="empty">This workspace is unavailable.</p>;
	const status = workspaceStatus(w),
		relation = canonicalRelation(view, w),
		overlaps = overlapsFor(view, w),
		latest = view.proposals.filter((p) => p.workspaceId === w.id).sort((a, b) => b.number - a.number)[0],
		item = attentionItem(view, w.id) ?? (latest && attentionItem(view, latest.id)),
		release = view.executionRelease[w.id],
		cleanup = view.forkCleanup[w.id],
		changes = view.proposals.filter((p) => p.workspaceId === w.id).sort((a, b) => b.number - a.number),
		published = view.artifacts.filter((a) => a.workspaceId === w.id && a.kind === "source"),
		activity = view.activity
			.filter((e) => e.ids.includes(w.id))
			.slice(-12)
			.toReversed();
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
			<dl className="facts fact-grid">
				<div>
					<dt>Owner</dt>
					<dd>
						{ownerName(w.ownerId, who)} · accountable for this work · workspace ID <code>{w.id}</code>
					</dd>
					<dt>Current attachment</dt>
					<dd>
						{w.execution ? (
							<>
								{attachmentText(w)} · since {ago(w.execution.attachedAt)} · machine <code>{w.execution.machineId}</code>, checkout{" "}
								<code>{w.execution.checkoutId}</code>
							</>
						) : (
							attachmentText(w)
						)}
						{w.state === "disconnected" && " · not reporting; checkout remains attached"}
					</dd>
				</div>
				<div>
					<dt>Baseline</dt>
					<dd>
						<code title={w.baseRevision}>{short(w.baseRevision)}</code> · {ago(w.startedAt)} · fixed starting revision
					</dd>
					<dt>Published</dt>
					<dd>
						{w.publishedRevision ? (
							<>
								<code title={w.publishedRevision}>{short(w.publishedRevision)}</code>
								{w.integratedRevision && (
									<>
										{" "}
										against review base <code title={w.integratedRevision}>{short(w.integratedRevision)}</code>
									</>
								)}
							</>
						) : (
							"No published revision"
						)}
					</dd>
					{item && (
						<>
							<dt>Decision state</dt>
							<dd>
								{blockerSummary(item)}. {nextStep(item)}.
							</dd>
						</>
					)}
				</div>
				<div>
					<dt>Observed pushed ref</dt>
					<dd>
						{view.reconciliation?.observation.workspaces[w.id] ? (
							<>
								<code>{view.reconciliation.observation.workspaces[w.id].ref}</code> ·{" "}
								<code>
									{view.reconciliation.observation.workspaces[w.id].deleted
										? "ref unavailable"
										: short(view.reconciliation.observation.workspaces[w.id].revision)}
								</code>{" "}
								· checked {ago(view.reconciliation.observation.workspaces[w.id].checkedAt, view.asOf)} · observed, not published
							</>
						) : (
							"Not yet observed"
						)}
					</dd>
					<dt>Report freshness</dt>
					<dd>
						<ReportAge at={w.lastReportAt} now={view.asOf ?? Date.now()} />
					</dd>
					<dt>Latest reported head</dt>
					<dd>
						<code title={w.headRevision}>{short(w.headRevision)}</code> · {w.commits.length} {w.commits.length === 1 ? "commit" : "commits"}
						, {w.changes.length} {w.changes.length === 1 ? "file" : "files"} reported
						{view.reconciliation?.observation.workspaces[w.id] &&
							!view.reconciliation.observation.workspaces[w.id].deleted &&
							view.reconciliation.observation.workspaces[w.id].revision !== w.headRevision &&
							" · differs from the observed pushed ref"}
					</dd>
				</div>
				<div>
					<dt>Canonical</dt>
					<dd>{relation.detail}</dd>
				</div>
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
							{w.fork && (
								<>
									<p>
										Workspace fork{" "}
										{w.fork.state === "ready" ? "is available" : w.fork.state === "deleting" ? "is being deleted" : "was deleted"}.
									</p>
									{w.cleanup && (
										<p role="status">
											{w.cleanup.state === "pending"
												? `Authorized cleanup will recover automatically. Attempt ${w.cleanup.attempts}.`
												: (w.cleanup.reason ?? "Authorized cleanup completed.")}
										</p>
									)}
									{w.retention && (
										<section aria-label="Retention blockers">
											<p>
												Last checked {ago(w.retention.checkedAt)}.{" "}
												{w.retention.complete ? "Ref inventory complete." : "Ref inventory incomplete."}
											</p>
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
															<span>{ref.reason === "unavailable" ? "retention unavailable" : "not retained"}</span>
														</li>
													))}
											</ul>
										</section>
									)}
									{w.fork.state === "ready" && (
										<div>
											<button type="button" className="ghost" onClick={() => run({ tool: "inspect_retention", workspaceId: w.id })}>
												Inspect retention
											</button>
											<small className="muted">Checks cloud storage using one namespace operation. Inspection never deletes a fork.</small>
										</div>
									)}
									{w.fork.state === "ready" && (
										<CopyCommand
											text={`git fetch ${location.origin}${gitRemotePath(view.repository.namespaceId, view.repository.id, w.id)}`}
										/>
									)}
									{view.permissions.maintain && view.permissions.human && w.fork.state !== "deleted" && (
										<div className="fork-actions">
											<button
												type="button"
												className="ghost"
												disabled={!cleanup?.ready || (!!w.cleanup && !w.cleanup.command)}
												title={cleanup?.reasons.join("; ")}
												onClick={() => run(w.cleanup?.command ?? { tool: "cleanup_workspace", workspaceId: w.id })}
											>
												{w.cleanup?.state === "blocked"
													? "Retry authorized deletion"
													: w.fork.state === "deleting"
														? "Check fork deletion"
														: "Delete fork"}
											</button>
											<small className="muted">
												{!cleanup?.ready && cleanup?.reasons.length
													? `${cleanup.reasons.join(". ")}.`
													: "Deletion only proceeds when every fork ref is already retained. Published revisions and history stay."}
											</small>
										</div>
									)}
								</>
							)}
							{error && <p role="alert">{error}</p>}
						</div>
					</Section>
				</aside>
			</div>
		</article>
	);
}
