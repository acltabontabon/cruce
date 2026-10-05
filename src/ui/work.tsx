import { useState } from "react";
import { gitRemotePath } from "../shared/git-access.ts";
import type { Command, RepositorySnapshot } from "../shared/platform.ts";
import { count, Empty, short, time } from "./controls.tsx";
import { WorkspaceUpdateInspection } from "./inspect.tsx";
import { RetainedRecordRow } from "./records.tsx";
export function Workspaces({ view, open, all = false }: { view: RepositorySnapshot; open: (id: string) => void; all?: boolean }) {
	const workspaces = view.workspaces
		.filter((s) => all || ["active", "preparing", "disconnected"].includes(s.state))
		.sort((a, b) => Number(b.actor.kind === "agent") - Number(a.actor.kind === "agent"));
	return workspaces.length ? (
		<div className="workspace-list">
			{workspaces.map((s) => (
				<button type="button" key={s.id} onClick={() => open(s.id)}>
					<span className={`presence ${s.state}`} />
					<span>
						<strong>{s.actor.name}</strong>
						<small className={`actor-kind ${s.actor.kind}`}>{s.actor.kind}</small>
					</span>
					<span>
						{s.title}
						<small>
							<code>{s.branch ?? "No ref"}</code> · +{count(s.commits.length, "commit")} · {count(s.changes.length, "file")}
						</small>
					</span>
					<span>
						{s.state}
						{view.workspaceUpdates[s.id]?.status === "available" && <small>Upstream updates available</small>}
						<small>Last observed {time(s.lastActivity)}</small>
					</span>
				</button>
			))}
		</div>
	) : (
		<Empty>No active workspaces. Workspaces appear when you or an agent begins work through the local bridge.</Empty>
	);
}
export function WorkspaceDetail({
	view,
	id,
	execute,
	open,
}: {
	view: RepositorySnapshot;
	id: string;
	execute: Execute;
	open: (tab: string, id?: string) => void;
}) {
	const s = view.workspaces.find((s) => s.id === id)!;
	const updates = view.workspaceUpdates[id];
	const [cleanupError, setCleanupError] = useState("");
	return (
		<section>
			<p className="eyebrow">Workspace · independent work</p>
			<h1>{s.title}</h1>
			<p>
				{s.actor.name} · {s.mode} · {s.state}
			</p>
			<p className="provenance-origin">
				Started from <code>{s.baseRevision}</code>
			</p>
			<p className="provenance-head">
				Reported head <code>{s.headRevision}</code>
			</p>
			<p>
				{updates.status === "unknown"
					? "Upstream revision unavailable"
					: updates.status === "current"
						? "Upstream matches the workspace baseline"
						: "Upstream updates available"}
				{updates.revision && (
					<>
						{" "}
						· <code>{short(updates.revision)}</code> · {updates.trust}
					</>
				)}
			</p>
			{updates.status === "available" && (
				<p>Fetch canonical with Git, merge when ready and verify before publishing. Your starting revision stays fixed.</p>
			)}
			<WorkspaceUpdateInspection key={`${id}:${updates.revision}:${s.headRevision}:${view.version}`} id={id} execute={execute} />
			{s.integratedRevision && (
				<p>
					Last integrated upstream <code>{s.integratedRevision}</code>
				</p>
			)}

			{s.context && <p>{s.context}</p>}
			<h2>Reported changes</h2>
			{!s.changes.length && <p className="muted">No file changes reported.</p>}
			<ul>
				{s.changes.map((c) => (
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
			{(["source", "evidence"] as const).map((kind) => (
				<section key={kind}>
					<h2>{kind === "source" ? "Published revisions" : "Revision evidence"}</h2>
					{view.artifacts
						.filter((a) => a.workspaceId === id && a.kind === kind)
						.map((a) => (
							<RetainedRecordRow key={a.id} record={a} open={(id) => open(kind === "source" ? "code" : "work", id)} />
						))}
					{!view.artifacts.some((a) => a.workspaceId === id && a.kind === kind) && (
						<p className="empty">{kind === "source" ? "No published revisions yet." : "No revision evidence stored yet."}</p>
					)}
				</section>
			))}
			<details>
				<summary>Execution details</summary>
				{s.fork ? (
					<>
						<p>Workspace fork · {s.fork.state}</p>
						{s.fork.state === "ready" && (
							<pre>
								<code>{`git fetch ${location.origin}${gitRemotePath(view.repository.namespaceId, view.repository.id, s.id)}`}</code>
							</pre>
						)}
						{view.permissions.human && view.permissions.maintain && s.fork.state !== "deleted" && (
							<button
								type="button"
								disabled={!view.forkCleanup[s.id]?.ready}
								title={view.forkCleanup[s.id]?.reasons.join("; ")}
								onClick={() =>
									void execute({ tool: "cleanup_workspace", workspaceId: s.id }).catch((error) => setCleanupError(error.message))
								}
							>
								{s.fork.state === "deleting" ? "Check fork deletion" : "Clean up retained fork"}
							</button>
						)}
					</>
				) : (
					<p>No hosted fork provisioned</p>
				)}
				{cleanupError && <p role="alert">{cleanupError}</p>}
				<p>
					{s.execution?.kind ?? "Awaiting attachment"} · {s.execution?.id ?? ""}
				</p>
				{s.fork?.name && (
					<p>
						Hosted storage <code>{s.fork.name}</code>
					</p>
				)}
				<p>
					{s.commits.length} reported commits · {time(s.startedAt)}
				</p>
			</details>
		</section>
	);
}
export function Activity({ view }: { view: RepositorySnapshot }) {
	return (
		<section>
			<h2>Recent activity</h2>
			{view.activity.length ? (
				<ol className="activity">
					{view.activity
						.slice(-20)
						.toReversed()
						.map((e) => (
							<li key={e.id}>
								<time>{time(e.at)}</time>
								<span>{e.summary}</span>
							</li>
						))}
				</ol>
			) : (
				<Empty>No activity yet.</Empty>
			)}
		</section>
	);
}
export type Execute = (cmd: Partial<Command> & { tool: string }) => Promise<unknown>;
