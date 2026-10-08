import { useEffect, useRef, useState } from "react";
import type { Command } from "../shared/platform.ts";
import { SkeletonLines } from "./loading.tsx";
import { short } from "./status.ts";

export type Execute = (cmd: Partial<Command> & { tool: string }) => Promise<unknown>;

/** Explicit storage operations are separate from cache-only coordination reads. */
function StoredSource({ revision, execute }: { revision: string; execute: Execute }) {
	const [paths, setPaths] = useState<string[]>(),
		[file, setFile] = useState<{ path: string; content: string | null; reason?: string }>(),
		[history, setHistory] = useState<{ commits: { oid: string; message: string }[]; truncated: boolean }>(),
		[error, setError] = useState(""),
		[status, setStatus] = useState("");
	const ticket = useTicket();
	const load = async (kind: "files" | "history" | "recover", path?: string) => {
		const current = ++ticket.current;
		setError("");
		setStatus("Loading stored source…");
		try {
			const result = await execute(
				kind === "recover" ? { tool: "recover_source", revision } : { tool: "inspect_source", revision, sourceView: kind, path },
			);
			if (current !== ticket.current) return;
			if (kind === "recover") setStatus("Source recovered. Browse files or commit history above to read the local cache.");
			else if (kind === "history") {
				setHistory(result as NonNullable<typeof history>);
				setPaths(undefined);
				setFile(undefined);
				setStatus("");
			} else {
				const source = result as { paths?: string[]; file?: NonNullable<typeof file> };
				if (source.paths) {
					setPaths(source.paths);
					setFile(undefined);
				}
				if (source.file) setFile(source.file);
				setHistory(undefined);
				setStatus("");
			}
		} catch (e) {
			if (current === ticket.current) {
				setError((e as Error).message);
				setStatus("");
			}
		}
	};
	return (
		<details>
			<summary>Inspect stored source</summary>
			<p className="muted">
				Each request uses cloud storage and one namespace resource operation. History follows first parents; it does not show every merge
				ancestor.
			</p>
			<div className="actions">
				<button type="button" onClick={() => void load("files")}>
					List stored files
				</button>
				<button type="button" onClick={() => void load("history")}>
					Stored history
				</button>
				<button type="button" onClick={() => void load("recover")}>
					Recover source cache
				</button>
			</div>
			{status && <p role="status">{status}</p>}
			{error && <p role="alert">{error}</p>}
			{paths && (
				<div className="source-browser">
					<nav aria-label="Stored repository files">
						{paths.map((path) => (
							<button type="button" key={path} className={file?.path === path ? "selected" : ""} onClick={() => void load("files", path)}>
								{path}
							</button>
						))}
					</nav>
					<section>
						<h3>{file?.path ?? "Select a stored file"}</h3>
						{file?.content !== null && file?.content !== undefined ? (
							<pre>{file.content}</pre>
						) : (
							<p className="muted">{file?.reason ?? "Choose a file on the left."}</p>
						)}
					</section>
				</div>
			)}
			{history && (
				<>
					<p className="muted">First-parent history{history.truncated ? " · first 30 commits" : ""}</p>
					<ol className="commit-history">
						{history.commits.map((c) => (
							<li key={c.oid}>
								<code>{short(c.oid)}</code>
								<strong>{c.message}</strong>
							</li>
						))}
					</ol>
				</>
			)}
		</details>
	);
}

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
			<StoredSource key={revision} revision={revision} execute={execute} />
			{loading && <SkeletonLines label="Loading revision" />}
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
