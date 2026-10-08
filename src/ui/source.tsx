import { useEffect, useRef, useState } from "react";
import type { ChangesResponse } from "../shared/api.ts";
import type { Command } from "../shared/platform.ts";
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

/** Colour for one unified-diff line: additions, removals, hunk headers and file headers. */
const patchLine = (line: string) =>
	line.startsWith("+++") || line.startsWith("---") || line.startsWith("===") || line.startsWith("Index:")
		? "meta"
		: line.startsWith("@@")
			? "hunk"
			: line.startsWith("+")
				? "add"
				: line.startsWith("-")
					? "del"
					: "";

type Range = { base: string; revision: string };
function FileButton({ file, selected, onClick }: { file: ChangesResponse["files"][number]; selected: boolean; onClick: () => void }) {
	return (
		<button type="button" className={selected ? "selected" : ""} onClick={onClick}>
			{file.path}
			<small>
				{file.status}
				{file.binary ? " · binary" : ` · +${file.additions ?? "?"} −${file.deletions ?? "?"}`}
			</small>
		</button>
	);
}
const changedPaths = async (execute: Execute, range: Range) =>
	new Set(
		((await execute({ tool: "get_diff", baseRevision: range.base, revision: range.revision })) as ChangesResponse).files.map((f) => f.path),
	);

/**
 * Files changed between two exact retained revisions, loaded as soon as the review opens. With `ownWork` (a diff from an earlier reviewed revision), files whose
 * content now equals canonical and that were never part of either revision's own work are grouped as canonical's:
 * already reviewed there. Everything else, including own edits that were dropped, stays in front of the reviewer.
 */
export function ChangeDiff({
	base,
	revision,
	execute,
	ownWork,
}: {
	base: string;
	revision: string;
	execute: Execute;
	ownWork?: { current: Range; earlier: Range };
}) {
	const [diff, setDiff] = useState<ChangesResponse>(),
		[fromCanonical, setFromCanonical] = useState<Set<string>>(new Set()),
		[error, setError] = useState(""),
		[loading, setLoading] = useState(false);
	const [stored, setStored] = useState(false);
	const ticket = useTicket();
	const load = async (path?: string, fromStorage = stored) => {
		const current = ++ticket.current;
		setLoading(true);
		setError("");
		try {
			const [result, own] = await Promise.all([
				execute({
					tool: fromStorage ? "inspect_source" : "get_diff",
					...(fromStorage ? { sourceView: "diff" as const } : {}),
					baseRevision: base,
					revision,
					path,
				}) as Promise<ChangesResponse>,
				// Grouping reads the bounded local cache only; a stored diff is shown ungrouped rather than spend more operations.
				!path && ownWork && !fromStorage
					? Promise.all([changedPaths(execute, ownWork.current), changedPaths(execute, ownWork.earlier)])
					: undefined,
			]);
			if (current !== ticket.current) return;
			setDiff(result);
			setStored(fromStorage);
			// A file request keeps the grouping its file list was loaded with.
			const canonical = new Set(own ? result.files.filter((f) => !own[0].has(f.path) && !own[1].has(f.path)).map((f) => f.path) : []);
			if (!path) setFromCanonical(canonical);
			// Open the first changed file straight away rather than asking for a click.
			const first = result.files.find((f) => !canonical.has(f.path)) ?? result.files[0];
			if (!path && !result.file && first) void load(first.path, fromStorage);
		} catch (e) {
			if (current === ticket.current) setError((e as Error).message);
		} finally {
			if (current === ticket.current) setLoading(false);
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per exact revision pair.
	useEffect(() => {
		setStored(false);
		void load(undefined, false);
	}, [base, revision]);
	return (
		<section className="diff-view" aria-label="Files changed">
			<details>
				<summary>Inspect stored diff</summary>
				<p className="muted">Each request uses cloud storage and one namespace resource operation, and may recover retained Git objects.</p>
				<button type="button" onClick={() => void load(undefined, true)}>
					Load stored diff
				</button>
			</details>
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
						{diff.files
							.filter((f) => !fromCanonical.has(f.path))
							.map((f) => (
								<FileButton key={f.path} file={f} selected={diff.file?.path === f.path} onClick={() => void load(f.path)} />
							))}
						{fromCanonical.size > 0 && (
							<details className="canonical-files">
								<summary>
									{fromCanonical.size === 1 ? "1 file" : `${fromCanonical.size} files`} from canonical, already reviewed there
								</summary>
								{diff.files
									.filter((f) => fromCanonical.has(f.path))
									.map((f) => (
										<FileButton key={f.path} file={f} selected={diff.file?.path === f.path} onClick={() => void load(f.path)} />
									))}
							</details>
						)}
						{!diff.files.length && <p className="muted">No file changes.</p>}
					</nav>
					<section>
						<h3>{diff.file?.path ?? "Select a file to see its changes"}</h3>
						{diff.files
							.filter((file) => file.path === diff.file?.path)
							.map((file) => (
								<p className="muted" key={file.path}>
									{file.before?.mode !== file.after?.mode && (
										<>
											Mode {file.before?.mode ?? "absent"} → {file.after?.mode ?? "absent"}.{" "}
										</>
									)}
									{(file.before?.type === "commit" || file.after?.type === "commit") && (
										<>
											Submodule {file.before?.oid ?? "absent"} → {file.after?.oid ?? "absent"}.
										</>
									)}
								</p>
							))}
						{diff.file?.patch ? (
							<pre className="patch">
								{diff.file.patch.split("\n").map((line, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: patch lines are static and may repeat.
									<span key={i} className={patchLine(line)}>
										{line}
										{"\n"}
									</span>
								))}
							</pre>
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
			<StoredSource key={revision} revision={revision} execute={execute} />
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
