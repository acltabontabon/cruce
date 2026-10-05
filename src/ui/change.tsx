import { useState } from "react";
import type { RepositorySnapshot } from "../shared/platform.ts";
import { Form, short, value } from "./controls.tsx";
import { RetainedRecordRow } from "./records.tsx";
import type { Execute } from "./work.tsx";

export function ChangeDetail({
	view,
	id,
	execute,
	busy,
	open,
}: {
	view: RepositorySnapshot;
	id: string;
	execute: Execute;
	busy: boolean;
	open: (tab: string, id?: string) => void;
}) {
	const p = view.proposals.find((p) => p.id === id);
	const [error, setError] = useState("");
	if (!p) return <p className="empty">Change unavailable.</p>;
	const evidence = view.verifications.filter((v) => v.proposalId === p.id && v.revision === p.revision);
	const reports = view.artifacts.filter(
		(a) =>
			a.kind === "evidence" &&
			a.revision === p.revision &&
			(a.workspaceId === p.workspaceId || evidence.some((v) => v.artifactId === a.id)),
	);
	return (
		<section className="change-detail">
			<button type="button" className="text-button" onClick={() => open("work")}>
				← All work
			</button>
			<p className="eyebrow">
				Change #{p.number} · {p.state}
			</p>
			<h1>{p.title}</h1>
			<p className="muted">Exact revision · {view.workspaces.find((w) => w.id === p.workspaceId)?.actor.name ?? "Workspace"}</p>
			<p className="revision-pair">
				Base <code title={p.base}>{short(p.base)}</code> → <code title={p.revision}>{short(p.revision)}</code>
			</p>
			<div className="readiness-detail">
				<h2>Promotion readiness</h2>
				{p.state === "promoted" ? (
					<p>Promoted source</p>
				) : view.readiness[p.id]?.ready ? (
					<p>Ready for human promotion</p>
				) : (
					<ul>
						{(view.readiness[p.id]?.reasons.length ? view.readiness[p.id].reasons : ["Readiness unavailable"]).map((reason) => (
							<li key={reason}>{reason}</li>
						))}
					</ul>
				)}
			</div>
			<div className="actions">
				<button type="button" onClick={() => open("code", p.id)}>
					Inspect diff
				</button>
				<button type="button" className="text-button" onClick={() => open("code", p.artifactId)}>
					View revision →
				</button>
			</div>
			<section className="evidence-summary">
				<h2>Evidence for this revision</h2>
				{evidence.map((v) => (
					<div className="evidence-row" key={v.id}>
						<strong>
							{v.kind} · {v.outcome}
						</strong>
						<span>{v.trust.replaceAll("_", " ")}</span>
						<p>{v.summary}</p>
					</div>
				))}
				{!evidence.length && <p className="muted">No verification recorded for this revision.</p>}
				{reports.map((a) => (
					<RetainedRecordRow key={a.id} record={a} open={(id) => open("work", id)} />
				))}
			</section>
			<h2>Reviews & concerns</h2>
			{!p.reviews.length && <p className="muted">No reviews for this revision yet.</p>}
			{p.reviews.map((r, i) => (
				<div key={r.id} className="record">
					<p>
						<strong>{r.actor.name}</strong> · {r.outcome} · {r.reason}
					</p>
					{r.resolution ? (
						<p>
							Resolved by {r.resolution.actor.name}: {r.resolution.reason}
						</p>
					) : (
						r.outcome !== "approve" &&
						view.permissions.maintain && (
							<Form
								label="Resolve concern"
								submit={(d) => execute({ tool: "resolve_review", proposalId: p.id, reviewIndex: i, reason: value(d, "reason") })}
							>
								<label>
									Resolution reason
									<input name="reason" required />
								</label>
							</Form>
						)
					)}
				</div>
			))}
			{p.state === "open" && (view.permissions.write || view.permissions.maintain) && (
				<>
					<h2>Human decision</h2>
					<div className="decision-area">
						{view.permissions.write && (
							<Form
								label="Submit review"
								submit={(d) =>
									execute({
										tool: "review_proposal",
										proposalId: p.id,
										revision: p.revision,
										outcome: value(d, "outcome") as "approve",
										reason: value(d, "reason"),
									})
								}
							>
								<p className="eyebrow">01 / Review the source</p>
								<label>
									Review
									<select name="outcome">
										<option value="approve">Approve</option>
										<option value="concern">Concern</option>
										<option value="disagree">Disagree</option>
									</select>
								</label>
								<label>
									Reason
									<input name="reason" required />
								</label>
							</Form>
						)}
						{view.permissions.maintain && (
							<Form
								label="Attest verification"
								submit={(d) =>
									execute({
										tool: "record_verification",
										proposalId: p.id,
										revision: p.revision,
										kind: value(d, "kind"),
										outcome: value(d, "outcome") as "pass",
										reason: value(d, "reason"),
										humanAttested: true,
									})
								}
							>
								<p className="eyebrow">02 / Attest what you checked</p>
								<label>
									Kind
									<input name="kind" defaultValue="tests" required />
								</label>
								<label>
									Outcome
									<select name="outcome">
										<option value="pass">Pass</option>
										<option value="fail">Fail</option>
									</select>
								</label>
								<label>
									What you inspected
									<input name="reason" required />
								</label>
							</Form>
						)}
						{view.permissions.maintain && (
							<div className="promotion-action">
								<p>Approval and evidence concern this exact revision. Promotion explicitly updates canonical Git.</p>
								<button
									type="button"
									className="primary"
									disabled={busy || !view.readiness[p.id]?.ready}
									onClick={() => {
										setError("");
										void execute({ tool: "promote_proposal", proposalId: p.id }).catch((e) => setError((e as Error).message));
									}}
								>
									Promote source
								</button>
							</div>
						)}
					</div>
				</>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
