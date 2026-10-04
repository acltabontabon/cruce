import { useEffect, useState } from "react";
import type { ControllerState } from "../../core/controller.ts";
import { Dialog, Icon } from "../components.tsx";
import { readResponse } from "../connection.ts";
import { friendlyText, short, taskName, timeOf } from "../model.ts";

interface Commit {
	oid: string;
	message: string;
	parents: string[];
	at: number;
	author: string;
	note: Record<string, unknown> | null;
}
export function History({
	projectId,
	target,
	state,
	onClose,
}: {
	projectId: string;
	target: string;
	state: ControllerState;
	onClose(): void;
}) {
	const [commits, setCommits] = useState<Commit[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const abort = new AbortController();
		setCommits(null);
		setError(null);
		fetch(`/api/demo/${encodeURIComponent(projectId)}/history?target=${encodeURIComponent(target)}`, { signal: abort.signal })
			.then((r) => readResponse<Commit[]>(r))
			.then((data) => {
				if (!abort.signal.aborted) setCommits(data);
			})
			.catch((e) => {
				if (!abort.signal.aborted) setError(e.message);
			});
		return () => abort.abort();
	}, [projectId, target]);
	return (
		<Dialog title={target === "canonical" ? "Repository history" : "Run history"} onClose={onClose} wide>
			<p className="dialog-description">
				{target === "canonical" ? `${state.project.name} · ${state.project.defaultBranch}` : taskName(state, target)}
				{state.project.mode === "demo" && <span className="muted small"> · Demo commits use fixed timestamps</span>}
			</p>
			<div className="history-list">
				{error && (
					<p className="inline-error" role="alert">
						{error}
					</p>
				)}
				{!commits && !error && <p className="muted">Reading Git history…</p>}
				{commits?.map((c) => (
					<div className="history-commit" key={c.oid}>
						<Icon name="commit" />
						<div>
							<div className="commit-heading">
								<strong>{friendlyText(c.message.split("\n")[0], state)}</strong>
								<span className="mono">{short(c.oid)}</span>
							</div>
							<p className="muted small">
								{c.author} · {timeOf(c.at)}
							</p>
							{c.note && <Note note={c.note} state={state} />}
						</div>
					</div>
				))}
			</div>
		</Dialog>
	);
}
function Note({ note, state }: { note: Record<string, unknown>; state: ControllerState }) {
	const n = note as {
		objective?: string;
		planVersion?: number;
		flightId?: string;
		validation?: { summary: string };
		planAmendments?: { reason: string }[];
		coordination?: { title: string }[];
		preflight?: { clean: boolean };
	};
	return (
		<details className="commit-note">
			<summary>Coordination record{n.planVersion ? ` · plan v${n.planVersion}` : ""}</summary>
			{n.objective && <p>{friendlyText(n.objective, state)}</p>}
			{n.planAmendments?.map((a) => (
				<p key={a.reason}>Plan updated: {friendlyText(a.reason, state)}</p>
			))}
			{n.coordination?.slice(-5).map((c) => (
				<p key={c.title}>{friendlyText(c.title, state)}</p>
			))}
			{n.validation && <p>Validation: {n.validation.summary}</p>}
			{n.preflight && <p>Git integration check: {n.preflight.clean ? "clean merge" : "conflict"}</p>}
			<span className="mono muted small">refs/notes/cruce</span>
		</details>
	);
}
