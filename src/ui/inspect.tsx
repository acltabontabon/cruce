import { useEffect, useRef, useState } from "react";
import type { ChangesResponse } from "../shared/api.ts";
import type { Command, RepositorySnapshot } from "../shared/platform.ts";
export type Execute = (cmd: Partial<Command> & { tool: string }) => Promise<unknown>;
const short = (s?: string) => s?.slice(0, 8) ?? "—";
export function ArtifactInspection({ id, execute }: { id: string; execute: Execute }) {
	const [content, setContent] = useState<string>(),
		[lineage, setLineage] =
			useState<
				{
					type: string;
					record: {
						id: string;
						title?: string;
						revision?: string;
						headRevision?: string;
						actor?: { name: string };
						state?: string;
						summary?: string;
					};
				}[]
			>(),
		[error, setError] = useState("");
	const ticket = useRef(0);
	useEffect(
		() => () => {
			ticket.current++;
		},
		[],
	);
	const load = async (kind: "artifact" | "lineage") => {
		const current = ++ticket.current;
		setError("");
		try {
			const result = await execute(kind === "lineage" ? { tool: "get_lineage", subjectId: id } : { tool: "read_artifact", artifactId: id });
			if (current !== ticket.current) return;
			if (kind === "lineage") setLineage(result as NonNullable<typeof lineage>);
			else
				setContent(
					(result as { content?: string }).content ?? "This source artifact contains exact Git objects. Inspect its revision in Code.",
				);
		} catch (e) {
			if (current === ticket.current) setError((e as Error).message);
		}
	};
	return (
		<>
			<div className="actions">
				<button type="button" onClick={() => void load("lineage")}>
					Trace lineage
				</button>
				<button type="button" onClick={() => void load("artifact")}>
					Read artifact
				</button>
			</div>
			{error && <p role="alert">{error}</p>}
			{content && <pre>{content}</pre>}
			{lineage && (
				<ol className="lineage">
					{lineage.map(({ type, record }) => (
						<li key={`${type}:${record.id}`}>
							<span className="eyebrow">{type}</span>
							<strong>{record.title ?? record.summary ?? record.state ?? record.id}</strong>
							<p>
								{record.actor?.name} · <code>{short(record.revision ?? record.headRevision)}</code>
							</p>
						</li>
					))}
				</ol>
			)}
		</>
	);
}
export function Code({ view, execute, proposalId }: { view: RepositorySnapshot; execute: Execute; proposalId: string }) {
	const proposal = view.proposals.find((p) => p.id === proposalId),
		[revision, setRevision] = useState(
			proposal?.revision ?? view.sourceHead ?? view.artifacts.find((a) => a.kind === "source")?.revision ?? "",
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
			<h2>Observed refs</h2>
			{view.refs.length ? (
				view.refs.slice(-20).map((r) => (
					<p key={`${r.ref}:${r.revision}:${r.at}`}>
						<code>
							{r.ref} · {short(r.revision)}
						</code>{" "}
						· {r.trust} · {new Date(r.at).toLocaleString()}
					</p>
				))
			) : (
				<p className="empty">No external refs reported.</p>
			)}
		</>
	);
}
