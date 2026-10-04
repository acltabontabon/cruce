import { useState } from "react";
import { type Execute, href, label, READINESS_LABEL, short, TRUST_LABEL, type View } from "./model.ts";

export function MissionView({ view, id }: { view: View; id: string }) {
	const m = view.missions.find((m) => m.id === id);
	if (!m) return <p role="alert">Mission unavailable.</p>;
	const workspace = view.workspaces.find((w) => w.id === m.workstreamId),
		artifacts = view.artifacts.filter((a) => a.missionId === m.id),
		proposals = view.proposals.filter((p) => p.missionId === m.id),
		group = m.experimentOf ?? m.id,
		experiments = view.missions.filter((o) => o.id !== m.id && (o.experimentOf ?? o.id) === group && (o.experimentOf || m.experimentOf));
	const plan = m.plan as {
		objective?: string;
		writeSet?: { resource: string }[];
		contractSet?: { resource: string }[];
		verification?: string[];
	};
	return (
		<section className="workstream-detail" aria-labelledby="mission-title">
			<p className="eyebrow">
				Mission · {label(m.specialization)} · {m.state}
			</p>
			<h1 id="mission-title">{m.title}</h1>
			{m.context && <p className="muted">{m.context}</p>}
			<dl className="kv">
				<dt>Agent</dt>
				<dd>{m.agent ? `${m.agent.tool} · ${m.agent.developerId}` : <span className="muted">Not started</span>}</dd>
				<dt>Base revision</dt>
				<dd>
					<code className="rev">{short(m.baseRevision)}</code> <span className="muted">accepted source when the mission started</span>
				</dd>
				<dt>Workspace</dt>
				<dd>
					{workspace ? (
						<>
							<code className="rev">{short(workspace.headRevision)}</code>{" "}
							<span className="muted">
								{workspace.repository} · {label(workspace.state)}
							</span>
						</>
					) : (
						<span className="muted">Created when the mission starts</span>
					)}
				</dd>
				{m.decision && (
					<>
						<dt>Coordination</dt>
						<dd>
							{m.decision.displayStatus} <span className="muted">· {m.decision.nextAction}</span>
						</dd>
					</>
				)}
			</dl>
			{plan.objective && <p>{plan.objective}</p>}
			{!!plan.writeSet?.length && (
				<p className="muted">
					Scope: {plan.writeSet.map((w) => w.resource).join(", ")}
					{!!plan.contractSet?.length && ` · contracts: ${plan.contractSet.map((c) => c.resource).join(", ")}`}
				</p>
			)}
			{experiments.length > 0 && (
				<>
					<h2>Alternative approaches</h2>
					<ul className="plain-list">
						{experiments.map((e) => (
							<li key={e.id}>
								<a href={href({ view: "mission", id: e.id })}>{e.title}</a>{" "}
								<span className="muted">
									· {e.agent?.tool ?? "not started"} · <code>{short(e.headRevision)}</code> ·{" "}
									{view.artifacts.filter((a) => a.missionId === e.id && a.kind !== "source").length} evidence
								</span>
							</li>
						))}
					</ul>
				</>
			)}
			<h2>Proposals</h2>
			{proposals.length === 0 && <p className="muted">No proposal yet.</p>}
			<ul className="plain-list">
				{proposals.map((p) => (
					<li key={p.id}>
						<a href={href({ view: "proposal", id: p.id })}>
							#{p.number} {p.summary}
						</a>{" "}
						<span className="muted">
							· {p.state === "proposed" ? READINESS_LABEL[p.readiness.outcome] : label(p.state)} · <code>{short(p.revision)}</code>
						</span>
					</li>
				))}
			</ul>
			<h2>Revisions and artifacts</h2>
			<ul className="plain-list">
				{artifacts.map((a) => (
					<li key={a.id}>
						<a href={href({ view: "artifact", id: a.id })}>{a.title}</a>{" "}
						<span className="muted">
							· {label(a.kind)} · <code>{short(a.revision)}</code> · {TRUST_LABEL[a.trust]}
						</span>
					</li>
				))}
			</ul>
			<p>
				<a href={href({ view: "lineage", subject: m.id })}>Trace lineage</a>
			</p>
		</section>
	);
}

export function ArtifactView({ view, id, execute }: { view: View; id: string; execute: Execute }) {
	const a = view.artifacts.find((a) => a.id === id);
	const [content, setContent] = useState<string | null>(null),
		[error, setError] = useState("");
	if (!a) return <p role="alert">Artifact unavailable.</p>;
	return (
		<section className="workstream-detail" aria-labelledby="artifact-title">
			<p className="eyebrow">
				{label(a.kind)} · {TRUST_LABEL[a.trust]}
			</p>
			<h1 id="artifact-title">{a.title}</h1>
			<p>{a.summary}</p>
			<dl className="kv">
				<dt>Revision</dt>
				<dd>
					<code className="rev" title={a.revision}>
						{short(a.revision)}
					</code>
				</dd>
				<dt>Produced by</dt>
				<dd>
					{a.producer.tool ?? a.producer.actor}{" "}
					<span className="muted">
						({a.producer.kind}
						{a.producer.model ? ` · ${a.producer.model}` : ""})
					</span>
				</dd>
				<dt>Executed</dt>
				<dd>
					{label(a.execution.location)} <span className="muted">· {a.execution.detail}</span>
				</dd>
				<dt>Stored</dt>
				<dd>
					<span className="muted">{a.storage.repository}</span> <code className="rev">{short(a.storage.revision)}</code>
				</dd>
			</dl>
			{a.kind !== "source" && (
				<button
					type="button"
					className="btn quiet"
					onClick={() => {
						void execute({ tool: "read_artifact", artifactId: a.id })
							.then((r) => setContent((r as { content?: string }).content ?? ""))
							.catch((e) => setError(e.message));
					}}
				>
					Read content
				</button>
			)}
			{content !== null && <pre>{content}</pre>}
			{a.kind === "source" && <SourceBrowser revision={a.revision} execute={execute} />}
			<details>
				<summary>Provenance record</summary>
				<pre>{JSON.stringify(a, null, 2)}</pre>
			</details>
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

export function SourceBrowser({ revision, execute }: { revision: string; execute: Execute }) {
	const [paths, setPaths] = useState<string[]>([]),
		[path, setPath] = useState(""),
		[content, setContent] = useState(""),
		[error, setError] = useState("");
	return (
		<div className="source-browser">
			<p className="muted">Source at {short(revision)} · read only</p>
			<button
				type="button"
				className="btn quiet"
				onClick={() => {
					void execute({ tool: "get_source", revision })
						.then((r) => setPaths((r as { paths: string[] }).paths))
						.catch((e) => setError(e.message));
				}}
			>
				List files
			</button>
			{paths.length > 0 && (
				<label>
					File
					<select
						value={path}
						onChange={(e) => {
							const selected = e.target.value;
							setPath(selected);
							void execute({ tool: "get_source", revision, path: selected })
								.then((r) => {
									const source = r as { content?: string; truncated?: boolean };
									setContent(source.content ?? "File unavailable");
									setError(source.truncated ? "Excerpt bounded to 100,000 characters. Check out the revision for the complete file." : "");
								})
								.catch((e) => setError(e.message));
						}}
					>
						<option value="">Choose a file</option>
						{paths.map((p) => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
				</label>
			)}
			{path && <pre>{content}</pre>}
			{error && <p role="status">{error}</p>}
		</div>
	);
}
