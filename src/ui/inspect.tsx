import { useEffect, useRef, useState } from "react";
import type { ChangesResponse } from "../shared/api.ts";
import type { Command, RepositorySnapshot, WorkspaceUpdateDetails } from "../shared/platform.ts";
import { RetainedRecordDetail, RetainedRecordRow } from "./records.tsx";
export type Execute = (cmd: Partial<Command> & { tool: string }) => Promise<unknown>;
const short = (s?: string) => s?.slice(0, 8) ?? "—";
export function WorkspaceUpdateInspection({ id, execute }: { id: string; execute: Execute }) {
	const [updates, setUpdates] = useState<WorkspaceUpdateDetails>(),
		[error, setError] = useState(""),
		[loading, setLoading] = useState(false);
	const ticket = useRef(0);
	useEffect(
		() => () => {
			ticket.current++;
		},
		[],
	);
	const load = async () => {
		const current = ++ticket.current;
		setLoading(true);
		setError("");
		try {
			const result = await execute({ tool: "get_workspace_updates", workspaceId: id });
			if (current === ticket.current) setUpdates(result as WorkspaceUpdateDetails);
		} catch (e) {
			if (current === ticket.current) setError((e as Error).message);
		} finally {
			if (current === ticket.current) setLoading(false);
		}
	};
	return (
		<>
			<button type="button" onClick={() => void load()} disabled={loading}>
				{loading ? "Inspecting updates…" : "Inspect upstream changes"}
			</button>
			{error && <p role="alert">{error}</p>}
			{updates && (
				<div>
					<p>
						{updates.available
							? `Published history: ${updates.comparison}`
							: "Upstream source is unavailable until committed source is published."}
					</p>
					{updates.changes.length > 0 && (
						<ul>
							{updates.changes.map((f) => (
								<li key={f.path}>
									<code>{f.path}</code> · {f.status}
									{f.binary ? " · binary" : ""}
									{updates.overlappingPaths.includes(f.path) ? " · overlaps reported workspace work" : ""}
								</li>
							))}
						</ul>
					)}
					{updates.overlappingPaths.length > 0 && (
						<p>Path overlap is advisory. Resolve integration with Git and verify the resulting revision.</p>
					)}
				</div>
			)}
		</>
	);
}
export function Code({
	view,
	execute,
	id,
	open,
}: {
	view: RepositorySnapshot;
	execute: Execute;
	id: string;
	open: (tab: string, id?: string) => void;
}) {
	const publication = view.artifacts.find((a) => a.kind === "source" && a.id === id),
		publications = view.artifacts.filter((a) => a.kind === "source"),
		proposal = view.proposals.find((p) => p.id === id || p.artifactId === publication?.id),
		[revision, setRevision] = useState(
			publication?.revision ?? proposal?.revision ?? view.sourceHead ?? view.artifacts.find((a) => a.kind === "source")?.revision ?? "",
		);
	const [files, setFiles] = useState<Record<string, string>>(),
		[selected, setSelected] = useState(""),
		[history, setHistory] = useState<{ oid: string; message: string; author: string; at: number }[]>(),
		[diff, setDiff] = useState<ChangesResponse>(),
		[error, setError] = useState(""),
		[loading, setLoading] = useState(false);
	const ticket = useRef(0);
	useEffect(
		() => () => {
			ticket.current++;
		},
		[],
	);
	const load = async (kind: "source" | "history" | "diff", path?: string) => {
		const current = ++ticket.current;
		setLoading(true);
		setError("");
		try {
			const result = await execute(
				kind === "diff"
					? { tool: "get_diff", baseRevision: proposal!.base, revision: proposal!.revision, path }
					: { tool: kind === "source" ? "get_source" : "get_history", revision },
			);
			if (current !== ticket.current) return;
			if (kind === "source") {
				const source = (result as { files: Record<string, string> }).files;
				setFiles(source);
				setSelected(Object.keys(source)[0] ?? "");
				setHistory(undefined);
				setDiff(undefined);
			}
			if (kind === "history") {
				setHistory(result as NonNullable<typeof history>);
				setFiles(undefined);
				setDiff(undefined);
			}
			if (kind === "diff") {
				setDiff(result as ChangesResponse);
				setFiles(undefined);
				setHistory(undefined);
			}
		} catch (e) {
			if (current === ticket.current) setError((e as Error).message);
		} finally {
			if (current === ticket.current) setLoading(false);
		}
	};
	return (
		<>
			<h1>Code</h1>
			{publication ? (
				<>
					<button type="button" className="text-button" onClick={() => open("code")}>
						← All published revisions
					</button>
					<RetainedRecordDetail id={publication.id} view={view} execute={execute} open={open} />
				</>
			) : proposal ? (
				<>
					<button type="button" className="text-button" onClick={() => open("work", proposal.id)}>
						← Back to change
					</button>
					<p className="muted">
						Change #{proposal.number} · {proposal.title}
					</p>
				</>
			) : (
				<section>
					<h2>Published revisions</h2>
					{id && <p role="status">This revision is unavailable.</p>}
					{publications.length ? (
						publications.map((a) => <RetainedRecordRow key={a.id} record={a} open={(id) => open("code", id)} />)
					) : (
						<p className="empty">
							No published revisions yet. Push committed source from your workspace, then publish its exact revision for review.
						</p>
					)}
				</section>
			)}
			{!view.sourceAvailable ? (
				<p className="empty">
					Source unavailable. Local registration preserves your remote and does not upload source. Publish a committed revision to inspect
					code here.
				</p>
			) : (
				<>
					<label>
						Revision
						<input value={revision} onChange={(e) => setRevision(e.target.value)} />
					</label>
					<div className="actions">
						<button type="button" onClick={() => void load("source")}>
							Browse source
						</button>
						<button type="button" onClick={() => void load("history")}>
							Commit history
						</button>
						{proposal && (
							<button type="button" onClick={() => void load("diff")}>
								Change diff
							</button>
						)}
					</div>
					{loading && <p role="status">Loading revision…</p>}
					{error && <p role="alert">{error}</p>}
					{files && (
						<div className="source-browser">
							<nav aria-label="Repository files">
								{Object.keys(files).map((path) => (
									<button type="button" className={selected === path ? "selected" : ""} key={path} onClick={() => setSelected(path)}>
										{path}
									</button>
								))}
							</nav>
							<section>
								<h2>{selected}</h2>
								<pre>{files[selected]}</pre>
							</section>
						</div>
					)}
					{history && (
						<ol className="commit-history">
							{history.map((commit) => (
								<li key={commit.oid}>
									<code>{short(commit.oid)}</code>
									<strong>{commit.message}</strong>
									<small>
										{commit.author} · {new Date(commit.at * 1000).toLocaleString()}
									</small>
								</li>
							))}
						</ol>
					)}
					{diff && (
						<div className="source-browser">
							<nav aria-label="Changed files">
								{diff.files.map((f) => (
									<button type="button" key={f.path} onClick={() => void load("diff", f.path)}>
										{f.path}
										<small>
											{f.status}
											{f.binary ? " · binary" : ` · +${f.additions ?? "?"} −${f.deletions ?? "?"}`}
										</small>
									</button>
								))}
							</nav>
							<section>
								<h2>{diff.file?.path ?? "Select a changed file"}</h2>
								{diff.file?.patch ? (
									<pre className="patch">{diff.file.patch}</pre>
								) : (
									<p className="empty">{diff.file?.reason ?? "Diffs compare exact uploaded revisions."}</p>
								)}
							</section>
						</div>
					)}
				</>
			)}
		</>
	);
}
