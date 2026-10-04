import { useEffect, useState } from "react";
import type { ControllerState } from "../../core/controller.ts";
import type { GitInfo } from "../../shared/api.ts";
import { short } from "../model.ts";

interface Commit {
	oid: string;
	message: string;
	parents: string[];
	at: number;
	author: string;
	note: Record<string, unknown> | null;
}

interface Props {
	projectId: string;
	target: string;
	state: ControllerState;
	git: GitInfo | null;
	onClose(): void;
}

/** Git is the source of truth: the canonical (or Flight) history with Cruce's notes attached. */
export function History({ projectId, target, state, git, onClose }: Props) {
	const [commits, setCommits] = useState<Commit[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const flight = state.flights.find((f) => f.id === target);
	const repo = target === "canonical" ? state.project.repo : flight?.artifact?.repo;
	const remote = target === "canonical" ? git?.canonicalRemote : flight?.artifact?.remote;

	useEffect(() => {
		fetch(`/api/projects/${projectId}/history?target=${target}`)
			.then((r) => r.json())
			.then((d) => (Array.isArray(d) ? setCommits(d as Commit[]) : setError((d as { error: string }).error)))
			.catch((e) => setError(String(e)));
	}, [projectId, target]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Escape is handled on window.
		<div className="modal-bg" onMouseDown={onClose} role="presentation">
			<div className="modal" role="dialog" aria-label="Git history" onMouseDown={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<div>
						<div className="eyebrow">{target === "canonical" ? "Canonical repository" : `${target} repository`}</div>
						<div className="ctx-title mono">
							{git?.backend === "artifacts" ? `${git.namespace}/` : ""}
							{repo}
						</div>
						{remote && <div className="mono muted small selectable">{remote}</div>}
					</div>
					<button type="button" className="btn small ghost" onClick={onClose}>
						Close
					</button>
				</div>
				{remote && git?.backend === "artifacts" && (
					<pre className="verify">
						{`# verify with a standard git client (read token from cf; never stored)\nTOKEN=$(cf artifacts namespaces tokens create ${git.namespace} --repo ${repo} --scope read --ttl 300 | jq -r .plaintext)\ngit -c http.extraHeader="Authorization: Bearer $TOKEN" clone ${remote}\ngit fetch origin 'refs/notes/cruce:refs/notes/cruce' && git log --graph --oneline && git notes --ref=cruce show HEAD`}
					</pre>
				)}
				<div className="commits">
					{error && <div className="muted">{error}</div>}
					{!commits && !error && <div className="muted">Reading history…</div>}
					{commits?.map((c) => (
						<div key={c.oid} className={`commit ${c.parents.length > 1 ? "merge" : ""}`}>
							<div className="commit-line">
								<span className="commit-dot" />
								<span className="mono">{short(c.oid)}</span>
								<span className="commit-msg">{c.message.split("\n")[0]}</span>
								<span className="muted small">{c.author}</span>
							</div>
							{c.note && <Note note={c.note} />}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function Note({ note }: { note: Record<string, unknown> }) {
	const n = note as {
		kind?: string;
		flightId?: string;
		planVersion?: number;
		intent?: string;
		planAmendments?: { reason: string }[];
		congestion?: { with?: string; label: string; decision?: { winner: string; rule: string } }[];
		coordination?: { title: string }[];
		validation?: { summary: string };
		preflight?: { clean: boolean; staleBase: boolean };
		gate?: string;
	};
	return (
		<div className="note">
			<div className="note-head">
				<span className="eyebrow small">refs/notes/cruce</span>
				<span className="mono">{n.flightId}</span>
				{n.planVersion && <span className="muted">plan v{n.planVersion}</span>}
				<span className="muted">{n.kind}</span>
			</div>
			{n.intent && <div className="note-intent">{n.intent}</div>}
			{n.gate && <div className="note-row">gate: {n.gate}</div>}
			{n.planAmendments?.map((a) => (
				<div key={a.reason} className="note-row">
					amended: {a.reason}
				</div>
			))}
			{n.coordination?.slice(-5).map((c) => (
				<div key={c.title} className="note-row muted">
					{c.title}
				</div>
			))}
			{n.validation && <div className="note-row">validation: {n.validation.summary}</div>}
			{n.preflight && (
				<div className="note-row">
					preflight: {n.preflight.clean ? "clean merge" : "conflict"}
					{n.preflight.staleBase ? " · baseline was behind (merged)" : ""}
				</div>
			)}
		</div>
	);
}
