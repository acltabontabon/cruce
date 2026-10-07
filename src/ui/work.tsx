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
	activityText,
	actorLabel,
	ago,
	canonicalRelation,
	changeStatus,
	ended,
	overlapsFor,
	short,
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

type Open = (tab: string, id?: string) => void;

function WorkspaceRow({
	view,
	w,
	open,
	focused,
	setFocus,
}: {
	view: RepositorySnapshot;
	w: Workspace;
	open: Open;
	focused?: boolean;
	setFocus?: (id?: string) => void;
}) {
	const status = workspaceStatus(w),
		relation = canonicalRelation(view, w),
		overlaps = overlapsFor(view, w),
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
					<span>{workedBy(w)}</span>
					<span>
						<ReportAge at={w.lastReportAt} now={view.asOf ?? Date.now()} />
					</span>
				</small>
				{overlaps.length > 0 && (
					<small className="overlap-note">
						Shares {overlaps.map((o) => o.path).join(", ")} with {[...new Set(overlaps.flatMap((o) => o.others))].join(", ")}
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
										<small>{row.readiness.reasons.join(" · ") || "Ready for human promotion"}</small>
									</span>
								</button>
							);
						})}
				</div>
			)}
		</section>
	);
}

export function WorkspaceList({ view, open }: { view: RepositorySnapshot; open: Open }) {
	const [focus, setFocus] = useState<string>();
	const sorted = [...view.workspaces].sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
	const live = sorted.filter((w) => !ended(w)),
		done = sorted.filter(ended);
	return (
		<>
			<LaneMap view={view} focus={focus} setFocus={setFocus} open={(id) => open("workspaces", id)} />
			<section className="panel workspaces-screen">
				<div className="panel-head">
					<h2>Active workspaces</h2>
					<span className="panel-count">{live.length}</span>
				</div>
				{live.length ? (
					<div className="rows">
						{live.map((w) => (
							<WorkspaceRow key={w.id} view={view} w={w} open={open} focused={focus === w.id} setFocus={setFocus} />
						))}
					</div>
				) : (
					<p className="panel-note">
						No active workspaces. One appears when you or an agent starts work through Cruce. Use Connect an agent to begin.
					</p>
				)}
				{done.length > 0 && (
					<details className="group">
						<summary>
							{done.length} ended {done.length === 1 ? "workspace" : "workspaces"}
						</summary>
						<div className="rows">
							{done.map((w) => (
								<WorkspaceRow key={w.id} view={view} w={w} open={open} />
							))}
						</div>
					</details>
				)}
			</section>
			<Reconciliation view={view} open={open} />
		</>
	);
}

export function WorkspaceDetail({ view, id, execute, open }: { view: RepositorySnapshot; id: string; execute: Execute; open: Open }) {
	const w = view.workspaces.find((s) => s.id === id);
	const [error, setError] = useState("");
	if (!w) return <p className="empty">This workspace is unavailable.</p>;
	const status = workspaceStatus(w),
		relation = canonicalRelation(view, w),
		overlaps = overlapsFor(view, w),
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
						<span>{workedBy(w)}</span>
					</p>
					{w.description && <p className="page-lead">{w.description}</p>}
				</div>
			</header>
			<LaneStrip view={view} workspace={w} lane={laneIndex(view).get(w.id) ?? 1} />
			<dl className="facts fact-grid">
				<div>
					<dt>Started from</dt>
					<dd>
						<code title={w.baseRevision}>{short(w.baseRevision)}</code> · {ago(w.startedAt)} · fixed for the life of the workspace
					</dd>
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
			{!ended(w) && relation.key === "behind" && <WorkspaceUpdateInspection id={w.id} execute={execute} />}
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
					<Section title="Checkout and storage">
						<div className="side-body">
							<p>
								{w.execution
									? `Attached to a ${w.execution.kind} through ${actorLabel(w.execution.attachedBy)} since ${ago(w.execution.attachedAt)}.`
									: w.state === "detached"
										? `Not attached to a checkout. Continue it anywhere with cruce resume --workspace ${w.id}.`
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
