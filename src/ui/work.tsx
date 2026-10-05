import { useState } from "react";
import { gitRemotePath } from "../shared/git-access.ts";
import type { RepositorySnapshot, Workspace } from "../shared/platform.ts";
import { Pill } from "./design.tsx";
import { WorkspaceUpdateInspection } from "./inspect.tsx";
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

type Open = (tab: string, id?: string) => void;

function WorkspaceRow({ view, w, open }: { view: RepositorySnapshot; w: Workspace; open: Open }) {
	const status = workspaceStatus(w),
		relation = canonicalRelation(view, w),
		overlaps = overlapsFor(view, w),
		change = view.proposals.filter((p) => p.workspaceId === w.id).sort((a, b) => b.number - a.number)[0];
	const changeLabel = change && changeStatus(view, change);
	return (
		<button type="button" className="workspace-row" onClick={() => open("workspaces", w.id)}>
			<span className="row-main">
				<strong>{w.title}</strong>
				<small>
					{workedBy(w)} ·{" "}
					{w.state === "active" || w.state === "disconnected" ? `reported ${ago(w.lastActivity)}` : `started ${ago(w.startedAt)}`}
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
		</button>
	);
}

export function WorkspaceList({ view, open }: { view: RepositorySnapshot; open: Open }) {
	const sorted = [...view.workspaces].sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
	const live = sorted.filter((w) => !ended(w)),
		done = sorted.filter(ended);
	return (
		<section className="workspaces-screen">
			{live.length ? (
				<div className="rows">
					{live.map((w) => (
						<WorkspaceRow key={w.id} view={view} w={w} open={open} />
					))}
				</div>
			) : (
				<p className="empty">
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
		<article className="workspace-page">
			<button type="button" className="text-button back" onClick={() => open("workspaces")}>
				← Workspaces
			</button>
			<header className="change-header">
				<span className="row-pills">
					<Pill tone={status.tone}>{status.label}</Pill>
					{!ended(w) && <Pill tone={relation.tone}>{relation.label}</Pill>}
				</span>
				<h1>{w.title}</h1>
				<p className="change-meta">{workedBy(w)}</p>
				{w.description && <p>{w.description}</p>}
			</header>
			<dl className="facts">
				<dt>Started from</dt>
				<dd>
					<code title={w.baseRevision}>{short(w.baseRevision)}</code> · {ago(w.startedAt)} · fixed for the life of the workspace
				</dd>
				<dt>Latest reported head</dt>
				<dd>
					<code title={w.headRevision}>{short(w.headRevision)}</code>
					{w.branch && (
						<>
							{" "}
							on <code>{w.branch}</code>
						</>
					)}{" "}
					· {w.commits.length} {w.commits.length === 1 ? "commit" : "commits"}, {w.changes.length}{" "}
					{w.changes.length === 1 ? "file" : "files"} reported
				</dd>
				<dt>Canonical</dt>
				<dd>{relation.detail}</dd>
				{overlaps.length > 0 && (
					<>
						<dt>Overlap</dt>
						<dd>
							{overlaps.map((o) => (
								<span key={o.path} className="overlap-line">
									<code>{o.path}</code> is also changed in {o.others.join(", ")}.
								</span>
							))}
							<small className="muted">Shared files are a heads-up, not a conflict.</small>
						</dd>
					</>
				)}
			</dl>
			{!ended(w) && relation.key === "behind" && <WorkspaceUpdateInspection id={w.id} execute={execute} />}
			<h2>Changes</h2>
			{changes.length ? (
				<div className="rows">
					{changes.map((p) => {
						const s = changeStatus(view, p);
						return (
							<button type="button" key={p.id} className="change-row" onClick={() => open("changes", p.id)}>
								<Pill tone={s.tone}>{s.label}</Pill>
								<span className="row-main">
									<strong>
										{p.title} <span className="number">#{p.number}</span>
									</strong>
									<small>
										<code>{short(p.revision)}</code> on <code>{short(p.base)}</code>
									</small>
								</span>
							</button>
						);
					})}
				</div>
			) : (
				<p className="muted">
					{published.length
						? "Published, but not proposed for review yet."
						: "Nothing published yet. Push commits, then publish a revision."}
				</p>
			)}
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
								</code>{" "}
								· {c.status}
								{c.binary ? " · binary" : ""}
							</li>
						))}
					</ul>
				</details>
			)}
			<h2>Checkout and storage</h2>
			<div className="settings-card">
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
					<button type="button" onClick={() => run({ tool: "detach_workspace", workspaceId: w.id })}>
						Release checkout
					</button>
				)}
				{w.fork && (
					<>
						<p>
							Workspace fork {w.fork.state === "ready" ? "is available" : w.fork.state === "deleting" ? "is being deleted" : "was deleted"}.
							{w.fork.state === "ready" && (
								<>
									{" "}
									Fetch it with{" "}
									<code>
										git fetch {location.origin}
										{gitRemotePath(view.repository.namespaceId, view.repository.id, w.id)}
									</code>
								</>
							)}
						</p>
						{view.permissions.maintain && view.permissions.human && w.fork.state !== "deleted" && (
							<div className="fork-actions">
								<button
									type="button"
									disabled={!cleanup?.ready}
									title={cleanup?.reasons.join("; ")}
									onClick={() => run({ tool: "cleanup_workspace", workspaceId: w.id })}
								>
									{w.fork.state === "deleting" ? "Check fork deletion" : "Delete fork"}
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
			{activity.length > 0 && (
				<>
					<h2>Activity</h2>
					<ol className="activity">
						{activity.map((e) => (
							<li key={e.id}>
								<time>{ago(e.at)}</time>
								<span>{activityText(e)}</span>
							</li>
						))}
					</ol>
				</>
			)}
		</article>
	);
}
