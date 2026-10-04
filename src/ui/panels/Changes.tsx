import { useEffect, useState } from "react";
import type { Flight } from "../../core/domain.ts";
import type { ChangesResponse } from "../../shared/api.ts";
import { Icon } from "../components.tsx";
import { readResponse } from "../connection.ts";
import { short } from "../model.ts";

export function Changes({ projectId, flight, canonical }: { projectId: string; flight: Flight; canonical: string }) {
	const [data, setData] = useState<ChangesResponse | null>(null);
	const [path, setPath] = useState<string | null>(null);
	const [diff, setDiff] = useState<ChangesResponse["file"]>();
	const [error, setError] = useState<string | null>(null);
	const [diffError, setDiffError] = useState<string | null>(null);
	const head = flight.artifact?.head ?? flight.publishes.filter((p) => p.approved).at(-1)?.commit;
	const approved = flight.publishes.some((p) => p.approved);
	const url = `/api/projects/${encodeURIComponent(projectId)}/flights/${encodeURIComponent(flight.id)}/changes`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Git revisions invalidate the cached comparison.
	useEffect(() => {
		setData(null);
		setError(null);
		setPath(null);
		if (!approved) return;
		const abort = new AbortController();
		fetch(url, { signal: abort.signal })
			.then((r) => readResponse<ChangesResponse>(r))
			.then((result) => {
				if (!abort.signal.aborted) setData(result);
			})
			.catch((e) => {
				if (!abort.signal.aborted) setError(e.message);
			});
		return () => abort.abort();
	}, [url, approved, head, canonical, flight.cleanup?.deletedAt]);
	useEffect(() => {
		setDiff(undefined);
		setDiffError(null);
		if (!path) return;
		const abort = new AbortController();
		fetch(`${url}?path=${encodeURIComponent(path)}`, { signal: abort.signal })
			.then((r) => readResponse<ChangesResponse>(r))
			.then((result) => {
				if (!abort.signal.aborted) {
					setData(result);
					setDiff(result.file);
				}
			})
			.catch((e) => {
				if (!abort.signal.aborted) setDiffError(e.message);
			});
		return () => abort.abort();
	}, [url, path]);
	return (
		<section className="detail-section" aria-label="Changes">
			<div className="section-heading">
				<h2>Changes</h2>
				{data && data.files.length > 0 && (
					<span className="diff-totals">
						<span className="add">+{data.additions}</span>
						<span className="remove">−{data.deletions}</span>
						{!data.statsComplete && <span className="muted">text files</span>}
					</span>
				)}
			</div>
			{!approved ? (
				<p className="muted">No published changes. The agent’s plan describes its intended work.</p>
			) : error ? (
				<p className="inline-error" role="alert">
					{error}
				</p>
			) : !data ? (
				<p className="muted">Reading changes…</p>
			) : (
				<>
					<div className="changes-summary">
						{data.files.length} {data.files.length === 1 ? "file" : "files"} changed
						<span className="muted small">
							{data.comparison === "integrated" ? "Integrated into main" : "Published work"} ·{" "}
							<span className="mono">
								{short(data.baseCommit ?? undefined)} → {short(data.headCommit ?? undefined)}
							</span>
						</span>
					</div>
					<div className="changed-files">
						{data.files.map((file) => (
							<div key={file.path}>
								<button
									type="button"
									className={`changed-file${path === file.path ? " selected" : ""}`}
									onClick={() => setPath(path === file.path ? null : file.path)}
									aria-expanded={path === file.path}
								>
									<Icon name="code" />
									<span className="mono">{file.path}</span>
									<span className="file-change-kind">{file.status}</span>
									{file.additions !== null && (
										<span className="diff-totals">
											<span className="add">+{file.additions}</span>
											<span className="remove">−{file.deletions}</span>
										</span>
									)}
									<Icon name="chevron" size={12} />
								</button>
								{path === file.path && (
									<section className="diff-content" aria-label={`Diff for ${file.path}`}>
										{diffError ? (
											<p className="inline-error">{diffError}</p>
										) : !diff ? (
											<p className="muted">Loading diff…</p>
										) : diff.patch === null ? (
											<p className="muted">{diff.reason ?? "Preview unavailable for this file."}</p>
										) : (
											<pre>
												{diff.patch.split("\n").map((line, i) => (
													<span
														key={String(i)}
														className={
															line.startsWith("+") && !line.startsWith("+++")
																? "diff-add"
																: line.startsWith("-") && !line.startsWith("---")
																	? "diff-remove"
																	: line.startsWith("@@")
																		? "diff-hunk"
																		: ""
														}
													>{`${line}\n`}</span>
												))}
											</pre>
										)}
									</section>
								)}
							</div>
						))}
					</div>
				</>
			)}
		</section>
	);
}
