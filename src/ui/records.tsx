import { useEffect, useRef, useState } from "react";
import type { ActivityEvent, ArchiveBundle, Artifact, RepositorySnapshot } from "../shared/platform.ts";
import { Form, short, time, value } from "./controls.tsx";
import { BackLink, Icon, PageHeader } from "./design.tsx";
import type { Execute } from "./inspect.tsx";
import { SkeletonPage } from "./loading.tsx";
import { actorLabel, ago, ownerName, type People } from "./status.ts";

export function RetainedRecordRow({ record: a, open }: { record: Artifact; open: (id: string) => void }) {
	return (
		<button type="button" className="retained-row" onClick={() => open(a.id)}>
			<span className="row-main">
				<strong>{a.title}</strong>
				<small className="row-meta">
					<code>{short(a.revision)}</code>
					<span>{actorLabel(a.actor)}</span>
					<span>{a.trust === "reported" ? "reported" : "confirmed by a person"}</span>
				</small>
			</span>
			<Icon name="arrow" className="row-arrow" />
		</button>
	);
}
function RecordInspection({ record, execute }: { record: Artifact; execute: Execute }) {
	const id = record.id;
	const [content, setContent] = useState<string>(),
		[lineage, setLineage] =
			useState<
				{
					type: string;
					record: {
						id: string;
						kind?: "source" | "evidence";
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
	const load = async (kind: "artifact" | "lineage" | "stored") => {
		const current = ++ticket.current;
		setError("");
		try {
			const result = await execute(
				kind === "lineage"
					? { tool: "get_lineage", subjectId: id }
					: kind === "stored"
						? { tool: "inspect_source", sourceView: "artifact", artifactId: id }
						: { tool: "read_artifact", artifactId: id },
			);
			if (current !== ticket.current) return;
			if (kind === "lineage") setLineage(result as NonNullable<typeof lineage>);
			else
				setContent(
					(result as { content?: string }).content ??
						(result as { reason?: string }).reason ??
						(record.kind === "source"
							? "This published revision retains exact Git objects. Use Browse source to inspect its files."
							: "Evidence content is unavailable."),
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
					{record.kind === "source" ? "Read revision" : "Read evidence"}
				</button>
			</div>
			{error && <p role="alert">{error}</p>}
			{record.kind === "evidence" && (
				<details>
					<summary>Inspect stored evidence</summary>
					<p className="muted">Uses cloud storage and one namespace resource operation.</p>
					<button type="button" onClick={() => void load("stored")}>
						Load stored evidence
					</button>
				</details>
			)}
			{content && <pre>{content}</pre>}
			{lineage && (
				<ol className="lineage">
					{lineage.map(({ type, record }) => (
						<li key={`${type}:${record.id}`}>
							<span className="eyebrow">{type === "artifact" ? (record.kind === "source" ? "published revision" : "evidence") : type}</span>
							<strong>{record.title ?? record.summary ?? record.state ?? record.id}</strong>
							<p>
								{record.actor ? actorLabel(record.actor as { name: string; kind: "agent" }) : ""} ·{" "}
								<code>{short(record.revision ?? record.headRevision)}</code>
							</p>
						</li>
					))}
				</ol>
			)}
		</>
	);
}
export function RetainedRecordDetail({
	id,
	view,
	execute,
	open,
}: {
	id: string;
	view: RepositorySnapshot;
	execute: Execute;
	open: (tab: string, id?: string) => void;
}) {
	const a = view.artifacts.find((a) => a.id === id);

	if (!a) return <p className="empty">Retained record unavailable.</p>;
	return (
		<section className="record-detail">
			<header className="page-header">
				<div className="page-title">
					<p className="kicker">
						<span>{a.kind === "source" ? "Published revision" : "Evidence"}</span>
						<span>{a.trust === "reported" ? "reported" : "confirmed by a person"}</span>
					</p>
					<h1>{a.title}</h1>
					<p className="change-meta">
						<span>Produced by {actorLabel(a.actor)}</span>
						<span>{time(a.at)}</span>
					</p>
				</div>
			</header>
			<p className="page-lead">
				{a.kind === "source"
					? "Publication preserves this exact source for review; approval and acceptance are separate decisions."
					: "Evidence about this exact revision. Reported evidence is a participant's claim; Cruce does not run checks."}
			</p>
			<dl className="fact-grid">
				<div>
					<dt>Revision</dt>
					<dd>
						<code>{a.revision}</code>
					</dd>
				</div>
				<div>
					<dt>Workspace</dt>
					<dd>
						<button type="button" className="text-button" onClick={() => open("workspaces", a.workspaceId)}>
							{view.workspaces.find((s) => s.id === a.workspaceId)?.title ?? "View workspace"}
						</button>
					</dd>
				</div>
				{a.baseRevision && (
					<div>
						<dt>Review base</dt>
						<dd>
							<code>{a.baseRevision}</code>
						</dd>
					</div>
				)}
			</dl>
			<details className="group">
				<summary>Storage details</summary>
				<dl className="facts">
					<dt>Storage</dt>
					<dd>{a.storage.repository}</dd>
					<dt>Content hash</dt>
					<dd>
						<code>{a.contentHash}</code>
					</dd>
				</dl>
			</details>
			<div className="actions">
				{a.kind === "evidence" &&
					view.artifacts
						.filter((source) => source.kind === "source" && source.workspaceId === a.workspaceId && source.revision === a.revision)
						.map((source) => (
							<button type="button" className="text-button" key={source.id} onClick={() => open("history", source.id)}>
								View revision →
							</button>
						))}
				{view.proposals
					.filter((p) =>
						a.kind === "source"
							? p.artifactId === a.id
							: p.revision === a.revision &&
								(p.workspaceId === a.workspaceId ||
									view.verifications.some((v) => v.proposalId === p.id && v.revision === p.revision && v.artifactId === a.id)),
					)
					.map((p) => (
						<button type="button" className="text-button" key={p.id} onClick={() => open("changes", p.id)}>
							View change #{p.number} →
						</button>
					))}
			</div>
			<RecordInspection key={id} record={a} execute={execute} />
			{view.permissions.write && a.kind === "source" && !view.proposals.some((p) => p.artifactId === a.id) && (
				<Form label="Propose for review" submit={(d) => execute({ tool: "create_proposal", artifactId: a.id, title: value(d, "title") })}>
					<label>
						Change title
						<input name="title" defaultValue={a.title} required />
					</label>
				</Form>
			)}
		</section>
	);
}

export function RetainedActivity({ execute }: { execute: Execute }) {
	const [page, setPage] = useState<{ items: ActivityEvent[]; cursor?: string }>(),
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
			const result = (await execute({ tool: "get_activity", cursor: page?.cursor })) as { items: ActivityEvent[]; cursor?: string };
			if (current === ticket.current) setPage(result);
		} catch (failure) {
			if (current === ticket.current) setError((failure as Error).message);
		} finally {
			if (current === ticket.current) setLoading(false);
		}
	};
	return (
		<details className="group">
			<summary>Retained activity</summary>
			<p className="muted">All recorded activity is kept. Browse from the oldest event, one page at a time.</p>
			{page && (
				<ol className="feed">
					{page.items.map((event) => (
						<li key={event.id}>
							<time>{time(event.at)}</time>
							<span>{event.summary}</span>
						</li>
					))}
				</ol>
			)}
			{(!page || page.cursor) && (
				<button type="button" className="ghost" disabled={loading} onClick={() => void load()}>
					{loading ? "Loading…" : error ? "Retry activity" : page ? "Next activity page" : "Browse retained activity"}
				</button>
			)}
			{page && !page.cursor && <p className="muted">End of retained activity.</p>}
			{error && <p role="alert">{error}</p>}
		</details>
	);
}

function bundleSummary(bundle: ArchiveBundle) {
	const promoted = bundle.proposals.filter((p) => p.state === "promoted").length,
		rejected = bundle.proposals.filter((p) => p.state === "rejected").length;
	if (!bundle.proposals.length) return bundle.workspace.state === "cancelled" ? "Cancelled, nothing proposed" : "Ended, nothing proposed";
	return [promoted && `${promoted} promoted`, rejected && `${rejected} rejected`].filter(Boolean).join(" · ");
}

/** Finished work that left the live repository view, newest first, one bounded page at a time. */
export function EarlierWork({ execute, total, open, who }: { execute: Execute; total: number; open: (id: string) => void; who: People }) {
	const [pages, setPages] = useState<ArchiveBundle[]>([]),
		[cursor, setCursor] = useState<string>(),
		[loaded, setLoaded] = useState(false),
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
			const result = (await execute({ tool: "get_archive", cursor })) as { items: ArchiveBundle[]; cursor?: string };
			if (current !== ticket.current) return;
			setPages((items) => [...items, ...result.items]);
			setCursor(result.cursor);
			setLoaded(true);
		} catch (failure) {
			if (current === ticket.current) setError((failure as Error).message);
		} finally {
			if (current === ticket.current) setLoading(false);
		}
	};
	if (!total) return <p className="panel-note">Ended workspaces move here once their forks are cleaned up.</p>;
	return (
		<>
			{pages.length > 0 && (
				<div className="rows">
					{pages.map((bundle) => (
						<button type="button" className="retained-row" key={bundle.workspace.id} onClick={() => open(bundle.workspace.id)}>
							<span className="row-main">
								<strong>{bundle.workspace.title}</strong>
								<small className="row-meta">
									<span>{ownerName(bundle.workspace.ownerId, who)}</span>
									<span>{bundleSummary(bundle)}</span>
									<span>ended {ago(bundle.workspace.endedAt ?? bundle.archivedAt)}</span>
								</small>
							</span>
							<Icon name="arrow" className="row-arrow" />
						</button>
					))}
				</div>
			)}
			{(!loaded || cursor) && (
				<button type="button" className="ghost" disabled={loading} onClick={() => void load()}>
					{loading ? "Loading…" : error ? "Retry earlier work" : loaded ? "Show more earlier work" : "Show earlier work"}
				</button>
			)}
			{error && <p role="alert">{error}</p>}
		</>
	);
}

/** Read-only record of finished work, found by any ID it contains. */
export function ArchivedRecord({
	id,
	execute,
	open,
	who,
	missing,
}: {
	id: string;
	execute: Execute;
	open: (tab: string, id?: string) => void;
	who: People;
	missing: string;
}) {
	const [bundle, setBundle] = useState<ArchiveBundle | null>(),
		[error, setError] = useState("");
	const ticket = useRef(0),
		run = useRef(execute);
	run.current = execute;
	useEffect(() => {
		const current = ++ticket.current;
		setBundle(undefined);
		setError("");
		run.current({ tool: "get_archive", subjectId: id }).then(
			(result) => current === ticket.current && setBundle(result as ArchiveBundle | null),
			(failure: Error) => current === ticket.current && setError(failure.message),
		);
		return () => {
			ticket.current++;
		};
	}, [id]);
	if (error) return <p role="alert">{error}</p>;
	if (bundle === undefined) return <SkeletonPage label="Loading record" />;
	if (bundle === null) return <p className="empty">{missing}</p>;
	const w = bundle.workspace;
	return (
		<article className="detail-page">
			<BackLink label="History" onClick={() => open("history")} />
			<PageHeader kicker={<span>Earlier work · {ownerName(w.ownerId, who)}</span>} title={w.title}>
				<p className="muted">
					{w.state === "cancelled" ? "Cancelled" : "Completed"} {w.endedAt ? ago(w.endedAt) : ""}. Its fork was cleaned up; these records
					are kept read-only.
				</p>
			</PageHeader>
			<dl className="facts">
				<dt>Baseline</dt>
				<dd>
					<code>{short(w.baseRevision)}</code>
				</dd>
				<dt>Last reported head</dt>
				<dd>
					<code>{short(w.headRevision)}</code>
				</dd>
			</dl>
			{bundle.proposals.length > 0 && (
				<section aria-label="Changes">
					<h2>Changes</h2>
					<ul className="feed">
						{bundle.proposals.map((p) => (
							<li key={p.id}>
								<code>{short(p.revision)}</code>
								<span>
									#{p.number} {p.title} · {p.state}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
			{bundle.artifacts.length > 0 && (
				<section aria-label="Published revisions and evidence">
					<h2>Published revisions and evidence</h2>
					<ul className="feed">
						{bundle.artifacts.map((a) => (
							<li key={a.id}>
								<code>{short(a.revision)}</code>
								<span>
									{a.title} · {a.kind === "source" ? "published revision" : "evidence"} · {actorLabel(a.actor)}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
			{bundle.promotions.length > 0 && (
				<section aria-label="Promotions">
					<h2>Promotions</h2>
					<ul className="feed">
						{bundle.promotions.map((p) => (
							<li key={p.id}>
								<code>{short(p.to)}</code>
								<span>
									{p.state === "complete" ? "Promoted" : "Promotion failed"} from <code>{short(p.from)}</code> by {actorLabel(p.actor)}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</article>
	);
}
