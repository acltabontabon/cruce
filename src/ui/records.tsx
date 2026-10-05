import { useEffect, useRef, useState } from "react";
import type { Artifact, RepositorySnapshot } from "../shared/platform.ts";
import { Form, short, time, value } from "./controls.tsx";
import type { Execute } from "./inspect.tsx";

export function RetainedRecordRow({ record: a, open }: { record: Artifact; open: (id: string) => void }) {
	return (
		<button type="button" className="retained-row" onClick={() => open(a.id)}>
			<strong>{a.title}</strong>
			<span>
				{a.kind === "source" ? "Published revision" : "Evidence"} · <code>{short(a.revision)}</code>
			</span>
			<small>
				{a.actor.name} · {a.trust.replaceAll("_", " ")}
			</small>
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
	const load = async (kind: "artifact" | "lineage") => {
		const current = ++ticket.current;
		setError("");
		try {
			const result = await execute(kind === "lineage" ? { tool: "get_lineage", subjectId: id } : { tool: "read_artifact", artifactId: id });
			if (current !== ticket.current) return;
			if (kind === "lineage") setLineage(result as NonNullable<typeof lineage>);
			else
				setContent(
					(result as { content?: string }).content ??
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
			{content && <pre>{content}</pre>}
			{lineage && (
				<ol className="lineage">
					{lineage.map(({ type, record }) => (
						<li key={`${type}:${record.id}`}>
							<span className="eyebrow">{type === "artifact" ? (record.kind === "source" ? "published revision" : "evidence") : type}</span>
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
		<section>
			<p className="eyebrow">
				{a.kind === "source" ? "Published revision" : "Evidence"} · {a.trust.replaceAll("_", " ")}
			</p>
			<h2 className="detail-title">{a.title}</h2>
			<p className="muted">
				{a.kind === "source"
					? "Publication preserves this exact source for review; approval and acceptance are separate decisions."
					: "Evidence concerns this exact revision. Its trust describes who supplied or attested the claim."}
			</p>
			<p>
				Produced by {a.actor.name} · {time(a.at)}
			</p>
			<dl>
				<dt>Revision</dt>
				<dd>
					<code>{a.revision}</code>
				</dd>
				<dt>Workspace</dt>
				<dd>
					<button type="button" className="text-button" onClick={() => open("work", a.workspaceId)}>
						{view.workspaces.find((s) => s.id === a.workspaceId)?.title ?? "View workspace"}
					</button>
				</dd>
				{a.baseRevision && (
					<>
						<dt>Review base</dt>
						<dd>
							<code>{a.baseRevision}</code>
						</dd>
					</>
				)}
			</dl>
			<details>
				<summary>Storage details</summary>
				<dl>
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
							<button type="button" className="text-button" key={source.id} onClick={() => open("code", source.id)}>
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
						<button type="button" className="text-button" key={p.id} onClick={() => open("work", p.id)}>
							View change #{p.number} →
						</button>
					))}
			</div>
			<RecordInspection key={id} record={a} execute={execute} />
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
