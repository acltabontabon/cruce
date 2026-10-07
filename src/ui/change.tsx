import { type CSSProperties, type ReactNode, useState } from "react";
import type { Proposal, RepositorySnapshot } from "../shared/platform.ts";
import { BackLink, Pill, Section } from "./design.tsx";
import { laneIndex } from "./lanes.ts";
import { LaneBullet } from "./lanes.tsx";
import { ChangeDiff, type Execute } from "./source.tsx";
import { actorLabel, ago, changeStatus, short } from "./status.ts";

type Open = (tab: string, id?: string) => void;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Check({ done, warn, title, children }: { done: boolean; warn?: boolean; title: string; children?: ReactNode }) {
	return (
		<li className={`check ${done ? "done" : warn ? "warn" : "todo"}`}>
			<span className="check-mark" aria-hidden="true">
				{done ? "✓" : warn ? "!" : ""}
			</span>
			<div>
				{done ? (
					<details className="completed-check">
						<summary>
							<span className="sr-only">Done: </span>
							{title}
						</summary>
						{children}
					</details>
				) : (
					<>
						<strong>
							<span className="sr-only">{warn ? "Blocked: " : "To do: "}</span>
							{title}
						</strong>
						{children}
					</>
				)}
			</div>
		</li>
	);
}

/** A small inline action that asks for one optional note before running. */
export function NoteAction({
	label,
	placeholder,
	fallback,
	run,
	className = "",
	immediate = false,
}: {
	label: string;
	placeholder: string;
	fallback: string;
	run: (note: string) => Promise<unknown>;
	className?: string;
	/** Run on the first click with the fallback note; for actions where an explanation is optional. */
	immediate?: boolean;
}) {
	const [open, setOpen] = useState(false),
		[note, setNote] = useState(""),
		[busy, setBusy] = useState(false),
		[error, setError] = useState("");
	if (!open)
		return (
			<>
				<button
					type="button"
					className={className}
					disabled={busy}
					onClick={() => {
						if (!immediate) return setOpen(true);
						setBusy(true);
						setError("");
						void run(fallback)
							.catch((err) => setError((err as Error).message))
							.finally(() => setBusy(false));
					}}
				>
					{busy ? "Saving…" : label}
				</button>
				{error && <p role="alert">{error}</p>}
			</>
		);
	return (
		<form
			className="note-action"
			onSubmit={(e) => {
				e.preventDefault();
				setBusy(true);
				setError("");
				void run(note.trim() || fallback)
					.then(() => setOpen(false))
					.catch((err) => setError((err as Error).message))
					.finally(() => setBusy(false));
			}}
		>
			<input value={note} onChange={(e) => setNote(e.target.value)} placeholder={placeholder} aria-label={`${label} note`} />
			<button type="submit" className={className} disabled={busy}>
				{busy ? "Saving…" : label}
			</button>
			<button type="button" className="text-button" onClick={() => setOpen(false)}>
				Cancel
			</button>
			{error && <p role="alert">{error}</p>}
		</form>
	);
}

function ReviewChecklist({ view, p, execute, busy }: { view: RepositorySnapshot; p: Proposal; execute: Execute; busy: boolean }) {
	const readiness = view.readiness[p.id],
		[error, setError] = useState("");
	if (!readiness) return null;
	const { checks } = readiness;
	const verificationFor = (kind: string) =>
		view.verifications.filter((v) => checks.evidence.find((e) => e.kind === kind)?.verificationIds.includes(v.id));
	const approval = p.reviews
		.toReversed()
		.find((r) => checks.reviewIds.includes(r.id) && r.outcome === "approve" && r.approvalAuthority === "human-maintainer");
	const next = !checks.current
		? "Merge canonical and publish a new revision"
		: checks.blockedByPromotion
			? "Reconcile the pending promotion"
			: checks.evidence.some((e) => !e.trusted || e.failed)
				? "Confirm the required evidence"
				: checks.concerns
					? "Resolve the review concerns"
					: !checks.approved
						? "Obtain maintainer approval for this revision"
						: "Promote this revision";
	return (
		<section
			className="review-panel"
			aria-label="Review checklist"
			style={{ "--lane": `var(--lane-${laneIndex(view).get(p.workspaceId) ?? 1})` } as CSSProperties}
		>
			<h2>Review</h2>
			<p className="next-action" role="status">
				Next: {next}
			</p>
			<p className="review-revision">
				Revision <code>{short(p.revision)}</code> against <code>{short(p.base)}</code>
			</p>
			<ol className="checklist">
				<Check
					done={checks.current}
					warn={!checks.current}
					title={checks.current ? "Built on the current canonical revision" : "Canonical has moved"}
				>
					<p>
						{checks.current ? (
							<>
								Based on <code>{short(p.base)}</code>, which is canonical <code>{view.repository.defaultBranch}</code> now.
							</>
						) : (
							<>
								This change is based on <code>{short(p.base)}</code>, but canonical is now <code>{short(checks.canonical)}</code>. Its
								workspace has to merge canonical and publish a new revision. This one can't be promoted.
							</>
						)}
					</p>
				</Check>
				{checks.evidence.map((e) => {
					const reports = verificationFor(e.kind);
					const reported = reports.find((v) => v.trust === "reported" && v.outcome === "pass");
					const confirmed = reports.find((v) => v.trust !== "reported" && v.outcome === "pass");
					return (
						<Check
							key={e.kind}
							done={e.trusted && !e.failed}
							warn={e.failed}
							title={e.failed ? `${cap(e.kind)} failing` : e.trusted ? `${cap(e.kind)} confirmed` : `Confirm ${e.kind}`}
						>
							<p>
								{e.failed
									? "A failing result is recorded for this exact revision. Its author can record an updated result after checking again, or the workspace can publish a fix."
									: e.trusted
										? `Confirmed by ${actorLabel(confirmed?.actor)} for this exact revision.`
										: reported
											? `${actorLabel(reported.actor)} reported a pass: “${reported.summary}”. Repository policy needs a maintainer to confirm it.`
											: `Repository policy needs confirmed ${e.kind} for this exact revision.`}
							</p>
							{view.permissions.approve && checks.open && (
								<div className="check-actions">
									<NoteAction
										label={e.failed ? `Record updated ${e.kind} pass` : `Confirm ${e.kind} pass`}
										immediate
										placeholder="What did you check? (optional)"
										fallback={`Confirmed ${e.kind} in the console`}
										run={(note) =>
											execute({
												tool: "record_verification",
												proposalId: p.id,
												revision: p.revision,
												kind: e.kind,
												outcome: "pass",
												reason: note,
												humanAttested: true,
											})
										}
									/>
									<NoteAction
										label="Record failure"
										className="quiet"
										placeholder="What failed?"
										fallback={`${e.kind} failed`}
										run={(note) =>
											execute({
												tool: "record_verification",
												proposalId: p.id,
												revision: p.revision,
												kind: e.kind,
												outcome: "fail",
												reason: note,
												humanAttested: true,
											})
										}
									/>
								</div>
							)}
						</Check>
					);
				})}
				{checks.concerns > 0 && (
					<Check done={false} warn title={`${checks.concerns} unresolved ${checks.concerns === 1 ? "concern" : "concerns"}`}>
						{p.reviews.map((r, i) =>
							checks.reviewIds.includes(r.id) && r.outcome !== "approve" && !r.resolution && r.revision === p.revision ? (
								<div key={r.id} className="concern">
									<p>
										{actorLabel(r.actor)}: “{r.reason}”
									</p>
									{view.permissions.maintain && view.permissions.human && (
										<NoteAction
											label="Resolve concern"
											placeholder="How was it resolved?"
											fallback="Resolved in the console"
											run={(note) => execute({ tool: "resolve_review", proposalId: p.id, reviewIndex: i, reason: note })}
										/>
									)}
								</div>
							) : null,
						)}
					</Check>
				)}
				<Check done={checks.approved} title={checks.approved ? "Approved" : "Approve this exact revision"}>
					<p>
						{checks.approved
							? `Approved by ${actorLabel(approval?.actor)}.`
							: `Approval covers ${short(p.revision)} only. A new revision needs a new review.`}
					</p>
				</Check>
			</ol>
			{checks.open && view.permissions.write && view.permissions.human && (
				<div className="check-actions">
					{view.permissions.approve && (
						<NoteAction
							label={checks.approved ? "Approve again" : "Approve"}
							immediate
							placeholder="Approval note (optional)"
							fallback="Approved in the console"
							run={(note) => execute({ tool: "review_proposal", proposalId: p.id, revision: p.revision, outcome: "approve", reason: note })}
						/>
					)}
					<NoteAction
						label="Raise concern"
						className="quiet"
						placeholder="What's the concern?"
						fallback="Concern raised in the console"
						run={(note) => execute({ tool: "review_proposal", proposalId: p.id, revision: p.revision, outcome: "concern", reason: note })}
					/>
				</div>
			)}
			{checks.blockedByPromotion && <p className="muted">Another promotion is being reconciled. Finish it first.</p>}
			{view.permissions.maintain && view.permissions.human && checks.open && (
				<div className="promote-bar">
					<button
						type="button"
						className="primary"
						disabled={busy || !readiness.ready}
						onClick={() => {
							setError("");
							void execute({ tool: "promote_proposal", proposalId: p.id }).catch((e) => setError((e as Error).message));
						}}
					>
						Promote to {view.repository.defaultBranch}
					</button>
					<p className="muted">
						{readiness.ready
							? `Moves canonical ${view.repository.defaultBranch} from ${short(p.base)} to ${short(p.revision)} with a non-forced Git update.`
							: "Finish the steps above to promote."}
					</p>
					<NoteAction
						label="Close change"
						className="quiet"
						placeholder="Why close it? (optional)"
						fallback={checks.current ? "Closed in the console" : "Closed as stale"}
						run={(note) => execute({ tool: "reject_proposal", proposalId: p.id, reason: note })}
					/>
				</div>
			)}
			{!(view.permissions.maintain && view.permissions.human) && (
				<p className="muted">A repository maintainer confirms checks and promotes.</p>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

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
	open: Open;
}) {
	const p = view.proposals.find((p) => p.id === id);
	const [error, setError] = useState("");
	if (!p) return <p className="empty">This change is unavailable.</p>;
	const status = changeStatus(view, p),
		workspace = view.workspaces.find((w) => w.id === p.workspaceId),
		artifact = view.artifacts.find((a) => a.id === p.artifactId),
		recovery = view.promotionRecovery[p.id];
	const verifications = view.verifications.filter((v) => v.proposalId === p.id);
	const reports = view.artifacts.filter(
		(a) =>
			a.kind === "evidence" &&
			a.revision === p.revision &&
			(a.workspaceId === p.workspaceId || verifications.some((v) => v.artifactId === a.id)),
	);
	const decision = p.state === "open" || (["promoting", "promoted"].includes(p.state) && recovery);
	return (
		<article className="change-page detail-page">
			<BackLink label="Changes" onClick={() => open("changes")} />
			<header className="page-header change-header">
				<div className="page-title">
					<p className="kicker">
						<span>Change</span>
						<code>#{p.number}</code>
					</p>
					<h1>{p.title}</h1>
					<p className="change-meta">
						<LaneBullet lane={laneIndex(view).get(p.workspaceId)} />
						<Pill tone={status.tone}>{status.label}</Pill>
						<span>
							Revision <code title={p.revision}>{short(p.revision)}</code> on <code title={p.base}>{short(p.base)}</code>
						</span>
						{workspace && (
							<span>
								{"from "}
								<button type="button" className="text-button" onClick={() => open("workspaces", workspace.id)}>
									{workspace.title}
								</button>
							</span>
						)}
						{artifact && <span>{`published by ${actorLabel(artifact.actor)} ${ago(artifact.at)}`}</span>}
					</p>
					{["stale", "superseded", "promoted", "rejected"].includes(status.key) && <p className="status-detail">{status.detail}</p>}
				</div>
			</header>
			<div className={decision ? "review-layout" : "review-layout single"}>
				{decision && (
					<aside className="review-side" aria-label="Decision">
						{p.state === "open" && <ReviewChecklist view={view} p={p} execute={execute} busy={busy} />}
						{["promoting", "promoted"].includes(p.state) && recovery && (
							<section className="review-panel">
								<h2>Promotion</h2>
								<p>
									{p.state === "promoted"
										? "Canonical was updated. Finish recording the completed promotion."
										: "The promotion was interrupted. Check its exact remote outcome before anything else is promoted."}
								</p>
								<div className="promote-bar">
									<button
										type="button"
										className="primary"
										disabled={busy || !recovery.ready}
										onClick={() => {
											setError("");
											void execute(recovery.command).catch((e) => setError((e as Error).message));
										}}
									>
										{p.state === "promoted" ? "Finish promotion" : "Reconcile promotion"}
									</button>
								</div>
								{error && <p role="alert">{error}</p>}
							</section>
						)}
					</aside>
				)}
				<div className="review-main">
					<Section title="Files changed">
						<ChangeDiff base={p.base} revision={p.revision} execute={execute} />
					</Section>
					<Section title="Evidence and reviews">
						<ul className="timeline">
							{verifications.map((v) => (
								<li key={v.id}>
									<strong>
										{v.kind} {v.outcome}
									</strong>{" "}
									· {v.trust === "reported" ? `reported by ${actorLabel(v.actor)}` : `confirmed by ${actorLabel(v.actor)}`}
									{v.revision !== p.revision && " · earlier revision"}
									<p>{v.summary}</p>
								</li>
							))}
							{reports.map((a) => (
								<li key={a.id}>
									<button type="button" className="text-button" onClick={() => open("history", a.id)}>
										{a.title}
									</button>{" "}
									· stored evidence from {actorLabel(a.actor)}
								</li>
							))}
							{p.reviews.map((r) => (
								<li key={r.id}>
									<strong>{r.outcome === "approve" ? "Approved" : r.outcome === "concern" ? "Concern" : "Disagreed"}</strong> ·{" "}
									{actorLabel(r.actor)}
									{r.revision !== p.revision && " · earlier revision"}
									<p>
										{r.reason}
										{r.resolution && ` — resolved by ${actorLabel(r.resolution.actor)}: ${r.resolution.reason}`}
									</p>
								</li>
							))}
							{!verifications.length && !reports.length && !p.reviews.length && <li className="muted">No evidence or reviews yet.</li>}
						</ul>
						{artifact && (
							<p className="panel-note">
								The exact source is retained as{" "}
								<button type="button" className="text-button" onClick={() => open("history", artifact.id)}>
									published revision {short(artifact.revision)}
								</button>
								. Retention proves which source is under review, not that it is correct.
							</p>
						)}
					</Section>
				</div>
			</div>
		</article>
	);
}
