import { useState } from "react";
import { gitRemotePath } from "../shared/git-access.ts";
import type { Artifact, Command, RepositorySnapshot } from "../shared/platform.ts";
import { count, Empty, Form, short, time, value } from "./controls.tsx";
import { ArtifactInspection, WorkspaceUpdateInspection } from "./inspect.tsx";
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
export function WorkspaceDetail({ view, id, execute }: { view: RepositorySnapshot; id: string; execute: Execute }) {
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
			<details>
				<summary>Execution details</summary>
				{s.fork ? (
					<>
						<p>Artifacts fork · {s.fork.state}</p>
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
export function ArtifactRow({ artifact: a, open }: { artifact: Artifact; open: (id: string) => void }) {
	return (
		<button type="button" className="artifact-row" onClick={() => open(a.id)}>
			<strong>{a.title}</strong>
			<span>
				{a.kind} · <code>{short(a.revision)}</code>
			</span>
			<small>
				{a.actor.name} · {a.trust.replaceAll("_", " ")}
			</small>
		</button>
	);
}
export type Execute = (cmd: Partial<Command> & { tool: string }) => Promise<unknown>;
export function ArtifactDetail({ id, view, execute }: { id: string; view: RepositorySnapshot; execute: Execute }) {
	const a = view.artifacts.find((a) => a.id === id);

	if (!a) return <p className="empty">Artifact unavailable.</p>;
	return (
		<section>
			<p className="eyebrow">
				{a.kind} artifact · {a.trust.replaceAll("_", " ")}
			</p>
			<h2 className="detail-title">{a.title}</h2>
			<dl>
				<dt>Revision</dt>
				<dd>
					<code>{a.revision}</code>
				</dd>
				<dt>Workspace</dt>
				<dd>{view.workspaces.find((s) => s.id === a.workspaceId)?.title}</dd>
				{a.baseRevision && (
					<>
						<dt>Review base</dt>
						<dd>
							<code>{a.baseRevision}</code>
						</dd>
					</>
				)}
				<dt>Storage</dt>
				<dd>{a.storage.repository}</dd>
				<dt>Content hash</dt>
				<dd>
					<code>{a.contentHash}</code>
				</dd>
			</dl>
			<ArtifactInspection key={id} id={id} execute={execute} />
			{view.permissions.write && a.kind === "source" && (
				<Form label="Propose change" submit={(d) => execute({ tool: "create_proposal", artifactId: a.id, title: value(d, "title") })}>
					<label>
						Change title
						<input name="title" defaultValue={a.title} required />
					</label>
				</Form>
			)}
		</section>
	);
}
