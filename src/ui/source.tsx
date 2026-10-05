import { useEffect, useRef, useState } from "react";
import type { ChangesResponse } from "../shared/api.ts";
import type { Command } from "../shared/platform.ts";
import { short } from "./status.ts";

export type Execute = (cmd: Partial<Command> & { tool: string }) => Promise<unknown>;

/** Ignore responses that arrive after a newer request or after unmount. */
function useTicket() {
	const ticket = useRef(0);
	useEffect(
		() => () => {
			ticket.current++;
		},
		[],
	);
	return ticket;
}

/** Files changed between a change's exact base and revision, loaded as soon as the review opens. */
export function ChangeDiff({ base, revision, execute }: { base: string; revision: string; execute: Execute }) {
	const [diff, setDiff] = useState<ChangesResponse>(),
		[error, setError] = useState(""),
		[loading, setLoading] = useState(false);
	const ticket = useTicket();
	const load = async (path?: string) => {
		const current = ++ticket.current;
		setLoading(true);
		setError("");
		try {
			const result = (await execute({ tool: "get_diff", baseRevision: base, revision, path })) as ChangesResponse;
			if (current !== ticket.current) return;
			setDiff(result);
			// Open the first changed file straight away rather than asking for a click.
			if (!path && !result.file && result.files[0]) void load(result.files[0].path);
		} catch (e) {
			if (current === ticket.current) setError((e as Error).message);
		} finally {
			if (current === ticket.current) setLoading(false);
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per exact revision pair.
	useEffect(() => {
		void load();
	}, [base, revision]);
	return (
		<section className="diff-view" aria-label="Files changed">
			{error && (
				<p role="alert">
					{error}{" "}
					<button type="button" className="text-button" onClick={() => void load()}>
						Retry
					</button>
				</p>
			)}
			{!diff && loading && <p className="muted">Loading changed files…</p>}
			{diff && (
				<div className="source-browser">
					<nav aria-label="Changed files">
						{diff.files.map((f) => (
							<button type="button" key={f.path} className={diff.file?.path === f.path ? "selected" : ""} onClick={() => void load(f.path)}>
								{f.path}
								<small>
									{f.status}
									{f.binary ? " · binary" : ` · +${f.additions ?? "?"} −${f.deletions ?? "?"}`}
								</small>
							</button>
						))}
						{!diff.files.length && <p className="muted">No file changes.</p>}
					</nav>
					<section>
						<h3>{diff.file?.path ?? "Select a file to see its changes"}</h3>
						{diff.file?.patch ? (
							<pre className="patch">{diff.file.patch}</pre>
						) : (
							<p className="muted">{diff.file?.reason ?? "Choose a file on the left."}</p>
						)}
					</section>
				</div>
			)}
		</section>
	);
}

/** Read-only files and history at one exact revision. */
export function RevisionBrowser({
	revision: initial,
	execute,
	editable = false,
}: {
	revision: string;
	execute: Execute;
	editable?: boolean;
}) {
	const [revision, setRevision] = useState(initial),
		[files, setFiles] = useState<Record<string, string>>(),
		[selected, setSelected] = useState(""),
		[history, setHistory] = useState<{ oid: string; message: string; author: string; at: number }[]>(),
		[error, setError] = useState(""),
		[loading, setLoading] = useState(false);
	const ticket = useTicket();
	const load = async (kind: "source" | "history") => {
		const current = ++ticket.current;
		setLoading(true);
		setError("");
		try {
			const result = await execute({ tool: kind === "source" ? "get_source" : "get_history", revision });
			if (current !== ticket.current) return;
			if (kind === "source") {
				const source = (result as { files: Record<string, string> }).files;
				setFiles(source);
				setSelected(Object.keys(source)[0] ?? "");
				setHistory(undefined);
			} else {
				setHistory(result as NonNullable<typeof history>);
				setFiles(undefined);
			}
		} catch (e) {
			if (current === ticket.current) setError((e as Error).message);
		} finally {
			if (current === ticket.current) setLoading(false);
		}
	};
	return (
		<section className="revision-browser">
			<div className="revision-toolbar">
				{editable ? (
					<label>
						Revision
						<input value={revision} onChange={(e) => setRevision(e.target.value)} spellCheck={false} />
					</label>
				) : (
					<p>
						Revision <code title={revision}>{short(revision)}</code>
					</p>
				)}
				<div className="actions">
					<button type="button" onClick={() => void load("source")}>
						Browse files
					</button>
					<button type="button" onClick={() => void load("history")}>
						Commit history
					</button>
				</div>
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
						<h3>{selected}</h3>
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
		</section>
	);
}
