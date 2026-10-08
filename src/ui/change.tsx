import { type CSSProperties, Fragment, type ReactNode, useState } from "react";
import type { Proposal, RepositorySnapshot } from "../shared/platform.ts";
import { CRUCE_PROMPTS } from "../shared/tools.ts";
import { BackLink, CopyCommand, Pill, Section } from "./design.tsx";
import { laneIndex } from "./lanes.ts";
import { LaneBullet } from "./lanes.tsx";
import { ArchivedRecord } from "./records.tsx";
import { changeNotes, ReviewFiles, type ThreadNote } from "./review.tsx";
import type { Execute } from "./source.tsx";
import {
	actorLabel,
	ago,
	attentionItem,
	behindCanonical,
	canonicalTarget,
	changeStatus,
	nextStep,
	ownerName,
	type People,
	RECONCILIATION_GUIDANCE,
	short,
	throughConnection,
} from "./status.ts";
import { UpdateHandoff } from "./work.tsx";

type Open = (tab: string, id?: string) => void;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

type StepId = "base" | "concerns" | `evidence:${string}` | "approval" | "promote";
interface Step {
	id: StepId;
	state: "done" | "warn" | "bad" | "todo";
	label: string;
}
interface Next {
	text: string;
	action?: { label: string; run: () => void };
}

/** What the reviewer reads in a few seconds: one next step, one primary action, and the checklist as small steps. */
function reviewState(view: RepositorySnapshot, p: Proposal, who: People, notes: ThreadNote[]) {
	const readiness = view.readiness[p.id];
	if (!readiness) return undefined;
	const { checks } = readiness;
	const workspace = view.workspaces.find((w) => w.id === p.workspaceId);
	const owner = workspace ? ownerName(workspace.ownerId, who) : "the owner";
	const mine = workspace?.ownerId === who.viewerId;
	const wholeConcerns = p.reviews.filter(
		(r) => checks.reviewIds.includes(r.id) && r.outcome !== "approve" && !r.resolution && r.revision === p.revision,
	);
	const concernNotes = notes.filter((n) => n.note.kind === "concern" && n.state !== "resolved");
	const answered = concernNotes.filter((n) => n.state === "awaiting_reviewer");
	const evidenceStep = (e: (typeof checks.evidence)[number]): Step => ({
		id: `evidence:${e.kind}`,
		state: e.failed ? "bad" : e.trusted ? "done" : e.reported ? "warn" : "todo",
		label: cap(e.kind),
	});
	const steps: Step[] = [
		{
			id: "base",
			state: checks.current ? "done" : "warn",
			label: checks.current ? `On ${view.repository.defaultBranch}` : "Behind canonical",
		},
		{
			id: "concerns",
			state: checks.concerns ? "warn" : "done",
			label: checks.concerns ? plural(checks.concerns, "concern") : "No concerns",
		},
		...checks.evidence.map(evidenceStep),
		{ id: "approval", state: checks.approved ? "done" : "todo", label: "Approval" },
	];
	const missing = checks.evidence.find((e) => e.failed || !e.trusted);
	const decide = view.permissions.approve;
	// The page's one primary action; step details never repeat it.
	const primary = !checks.current
		? "base"
		: answered.length && decide
			? "answers"
			: checks.concerns
				? "concerns"
				: missing
					? "evidence"
					: !checks.approved
						? "approve"
						: readiness.ready
							? "promote"
							: "none";
	return { readiness, checks, owner, mine, wholeConcerns, concernNotes, answered, missing, steps, workspace, primary };
}

function ReviewNext({
	view,
	p,
	who,
	notes,
	step,
	setStep,
	execute,
	busy,
	onFocusNote,
}: {
	view: RepositorySnapshot;
	p: Proposal;
	who: People;
	notes: ThreadNote[];
	step?: StepId;
	setStep: (s?: StepId) => void;
	execute: Execute;
	busy: boolean;
	onFocusNote: (id: string) => void;
}) {
	const [error, setError] = useState("");
	const state = reviewState(view, p, who, notes);
	if (!state || p.state !== "open") return null;
	const { readiness, checks, owner, mine, concernNotes, answered, missing, steps, wholeConcerns } = state;
	const decide = view.permissions.approve;
	const run = (command: Parameters<Execute>[0]) => {
		setError("");
		void execute(command).catch((e) => setError((e as Error).message));
	};
	const item = attentionItem(view, p.id);
	let next: Next;
	if (!checks.current)
		next = {
			text: "Canonical moved. The workspace merges it and publishes a new revision before review continues.",
			action: { label: "How to update", run: () => setStep("base") },
		};
	else if (answered.length && decide)
		next = {
			text: `${mine ? "Your agent" : owner} answered ${plural(answered.length, "concern")}${concernNotes.length + wholeConcerns.length > answered.length ? `; ${concernNotes.length + wholeConcerns.length - answered.length} still open` : ""}.`,
			action: { label: "Check the answers", run: () => onFocusNote(answered[0].note.id) },
		};
	else if (checks.concerns)
		next = mine
			? {
					text: `${plural(checks.concerns, "concern")} ${checks.concerns === 1 ? "waits" : "wait"} for your changes.`,
					action: { label: "Hand to your agent", run: () => setStep("concerns") },
				}
			: {
					text: `${plural(checks.concerns, "concern")} ${checks.concerns === 1 ? "waits" : "wait"} for ${owner}.`,
					action: { label: "See concerns", run: () => setStep("concerns") },
				};
	else if (missing)
		next = {
			text: missing.failed
				? `${cap(missing.kind)} failing on ${short(p.revision)}.`
				: missing.reported
					? `${cap(missing.kind)} reported passing; a maintainer attests it.`
					: `${cap(missing.kind)} not recorded for ${short(p.revision)}.`,
			...(decide
				? { action: { label: missing.failed ? "See details" : "Record result", run: () => setStep(`evidence:${missing.kind}`) } }
				: {}),
		};
	else if (!checks.approved)
		next = {
			text: `Ready for approval of ${short(p.revision)}.`,
			...(decide
				? {
						action: {
							label: "Approve",
							run: () =>
								run({
									tool: "review_proposal",
									proposalId: p.id,
									revision: p.revision,
									outcome: "approve",
									reason: "Approved in the console",
								}),
						},
					}
				: {}),
		};
	else if (readiness.ready)
		next = {
			text: `Everything is in place for ${short(p.revision)}.`,
			...(decide
				? {
						action: {
							label: `Promote to ${view.repository.defaultBranch}`,
							run: () => run({ tool: "promote_proposal", proposalId: p.id }),
						},
					}
				: {}),
		};
	else next = { text: item ? `Next: ${nextStep(item)}` : "Readiness for this change is unavailable" };
	const mark = (s: Step["state"]) => (s === "done" ? "✓" : s === "warn" || s === "bad" ? "!" : "");
	return (
		<div className="rv-next">
			<div className="rv-next-line">
				<p role="status">{next.text}</p>
				{next.action && (
					<button type="button" className="primary" disabled={busy} onClick={next.action.run}>
						{next.action.label}
					</button>
				)}
			</div>
			<nav className="rv-steps" aria-label="Review checklist">
				{steps.map((s, i) => (
					<Fragment key={s.id}>
						{i > 0 && <span className="rv-stepline" aria-hidden="true" />}
						<button
							type="button"
							className={`rv-step ${s.state}`}
							aria-expanded={step === s.id}
							onClick={() => setStep(step === s.id ? undefined : s.id)}
						>
							<span className="rv-mark" aria-hidden="true">
								{mark(s.state)}
							</span>
							<span className="sr-only">{s.state === "done" ? "Done: " : s.state === "todo" ? "To do: " : "Blocked: "}</span>
							{s.label}
						</button>
					</Fragment>
				))}
				<span className="rv-stepline" aria-hidden="true" />
				<button
					type="button"
					className={`rv-step ${readiness.ready ? "ready" : "todo"}`}
					aria-expanded={step === "promote"}
					onClick={() => setStep(step === "promote" ? undefined : "promote")}
				>
					<span className="rv-mark" aria-hidden="true" />
					Promote
				</button>
			</nav>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}

/** The details of one checklist step, opened from its label. Actions that are the page's next step are not repeated here. */
function StepDetail({
	view,
	p,
	who,
	notes,
	step,
	close,
	execute,
	onFocusNote,
}: {
	view: RepositorySnapshot;
	p: Proposal;
	who: People;
	notes: ThreadNote[];
	step: StepId;
	close: () => void;
	execute: Execute;
	onFocusNote: (id: string) => void;
}) {
	const state = reviewState(view, p, who, notes);
	if (!state) return null;
	const { readiness, checks, mine, wholeConcerns, concernNotes, workspace, owner, primary } = state;
	const decide = view.permissions.approve;
	const reviewable = checks.current;
	const item = attentionItem(view, p.id);
	const header = (title: string) => (
		<h3>
			{title}
			<button type="button" className="text-button" onClick={close}>
				Close
			</button>
		</h3>
	);
	let body: ReactNode = null;
	if (step === "base")
		body = (
			<>
				{header(checks.current ? "Built on the current canonical revision" : "Canonical has moved")}
				<p>
					{checks.current ? (
						<>
							Based on <code>{short(p.base)}</code>, which is canonical <code>{view.repository.defaultBranch}</code> now.
						</>
					) : (
						<>
							This change is based on <code>{short(p.base)}</code>, but canonical is now <code>{short(checks.canonical)}</code>. Its
							workspace has to merge canonical and publish a new revision. This one can't be promoted, so review the updated revision
							instead.
						</>
					)}
				</p>
				{item?.group === "reconciliation" && <p className="muted">{RECONCILIATION_GUIDANCE}</p>}
				{!checks.current && workspace && item?.actions.includes("reconcile_with_git") && (
					<UpdateHandoff w={workspace} canonical={canonicalTarget(item) ?? checks.canonical} />
				)}
			</>
		);
	else if (step === "concerns") {
		const prompt = CRUCE_PROMPTS[0];
		body = (
			<>
				{header(checks.concerns ? `${plural(checks.concerns, "concern")} before this can land` : "No open concerns")}
				{concernNotes.length > 0 && (
					<ul className="rv-concerns">
						{concernNotes.map((n) => (
							<li key={n.note.id}>
								<button type="button" className="text-button" onClick={() => onFocusNote(n.note.id)}>
									{n.note.anchor ? `${n.note.anchor.path}:${n.note.anchor.line}` : "Whole change"}
								</button>
								<span>{n.note.body}</span>
								<em>{n.state === "awaiting_reviewer" ? "answered" : "waiting for the owner"}</em>
							</li>
						))}
					</ul>
				)}
				{wholeConcerns.map((r) => (
					<div key={r.id} className="concern">
						<p>
							{actorLabel(r.actor)}: “{r.reason}”
						</p>
						{decide && (
							<NoteAction
								label="Resolve concern"
								placeholder="How was it resolved?"
								fallback="Resolved in the console"
								run={(note) => execute({ tool: "resolve_review", proposalId: p.id, reviewIndex: p.reviews.indexOf(r), reason: note })}
							/>
						)}
					</div>
				))}
				{mine && checks.concerns > 0 ? (
					<>
						<p>
							Ask your own agent to address them. It reads the notes through your connection, changes the code, publishes and proposes a new
							revision, and replies on each note citing it. You resolve each concern with a reason; an agent can't. Cruce never contacts the
							agent.
						</p>
						<CopyCommand
							label="Ask your agent"
							text="Address the open review notes on my Cruce change, then publish and propose the fixed revision."
						/>
						<p className="muted">
							Tools that support MCP prompts also offer <code>{prompt.name}</code>, and the Cruce bridge mentions waiting notes in your
							agent's next response.
						</p>
					</>
				) : (
					checks.concerns > 0 && (
						<p className="muted">{owner}'s agent sees these notes through Cruce and can reply; only a maintainer resolves them.</p>
					)
				)}
			</>
		);
	} else if (step.startsWith("evidence:")) {
		const kind = step.slice("evidence:".length);
		const e = checks.evidence.find((x) => x.kind === kind);
		if (e) {
			const reports = view.verifications.filter((v) => e.verificationIds.includes(v.id));
			const reported = reports.find((v) => v.trust === "reported" && v.outcome === "pass");
			const confirmed = reports.find((v) => v.trust !== "reported" && v.outcome === "pass");
			body = (
				<>
					{header(
						e.failed
							? `${cap(kind)} failing`
							: e.trusted
								? `${cap(kind)} attested`
								: reported
									? `${cap(kind)} reported passing; human attestation required`
									: `Required ${kind} evidence missing`,
					)}
					<p>
						{e.failed
							? "A failing result is recorded for this exact revision. Its author can record an updated result after checking again, or the workspace can publish a fix."
							: e.trusted
								? `Attested by ${actorLabel(confirmed?.actor)} for this exact revision.`
								: reported
									? `${actorLabel(reported.actor)} reported a pass: “${reported.summary}”. Inspect the evidence; repository policy needs a human maintainer to attest it.`
									: `No ${kind} result is recorded for this exact revision. The owner's tools can report one, or a maintainer can record a result they checked.`}
					</p>
					{decide && checks.open && reviewable && (
						<div className="check-actions">
							{/* An attested pass is done: recording it again would only repeat it. A later failure can still be recorded. */}
							{!(e.trusted && !e.failed) && (
								<NoteAction
									label={e.failed ? `Record updated ${kind} pass` : reported ? `Attest ${kind} pass` : `Record checked ${kind} pass`}
									immediate
									placeholder="What did you check? (optional)"
									fallback={`Attested ${kind} in the console`}
									run={(note) =>
										execute({
											tool: "record_verification",
											proposalId: p.id,
											revision: p.revision,
											kind,
											outcome: "pass",
											reason: note,
											humanAttested: true,
										}).then(close)
									}
								/>
							)}
							<NoteAction
								label={e.trusted && !e.failed ? "Record a failure instead" : "Record failure"}
								className="quiet"
								placeholder="What failed?"
								fallback={`${kind} failed`}
								run={(note) =>
									execute({
										tool: "record_verification",
										proposalId: p.id,
										revision: p.revision,
										kind,
										outcome: "fail",
										reason: note,
										humanAttested: true,
									})
								}
							/>
						</div>
					)}
				</>
			);
		}
	} else if (step === "approval") {
		const approval = p.reviews
			.toReversed()
			.find((r) => checks.reviewIds.includes(r.id) && r.outcome === "approve" && r.approvalAuthority === "human-maintainer");
		body = (
			<>
				{header(checks.approved ? "Approved" : reviewable ? "Approve this exact revision" : "Approve the updated revision")}
				<p>
					{checks.approved
						? `Approved by ${actorLabel(approval?.actor)}. A new revision needs a new review.`
						: reviewable
							? `Approval covers ${short(p.revision)} only. A new revision needs a new review.`
							: "Approval waits for the updated revision; this one can't be promoted."}
				</p>
				{decide && reviewable && checks.open && !checks.approved && primary !== "approve" && (
					<div className="check-actions">
						<NoteAction
							label="Approve"
							immediate
							placeholder="Approval note (optional)"
							fallback="Approved in the console"
							run={(note) =>
								execute({ tool: "review_proposal", proposalId: p.id, revision: p.revision, outcome: "approve", reason: note }).then(close)
							}
						/>
					</div>
				)}
			</>
		);
	} else if (step === "promote")
		body = (
			<>
				{header(readiness.ready ? "Ready to promote" : "Promotion")}
				<p>
					{readiness.ready
						? `Moves canonical ${view.repository.defaultBranch} from ${short(p.base)} to ${short(p.revision)} with a non-forced Git update.`
						: "Finish the other steps to promote."}
				</p>
				{checks.blockedByPromotion && <p className="muted">Another promotion is being reconciled. Finish it first.</p>}
				{decide ? (
					<div className="check-actions">
						<NoteAction
							label="Close change"
							className="quiet"
							placeholder="Why close it? (optional)"
							fallback={checks.current ? "Closed in the console" : "Closed as stale"}
							run={(note) => execute({ tool: "reject_proposal", proposalId: p.id, reason: note })}
						/>
					</div>
				) : (
					<p className="muted">A human repository maintainer attests evidence, approves and promotes.</p>
				)}
			</>
		);
	return (
		<section className="rv-detail" aria-label="Review step">
			{body}
		</section>
	);
}

export function ChangeDetail({
	view,
	id,
	execute,
	busy,
	open,
	who,
}: {
	view: RepositorySnapshot;
	id: string;
	execute: Execute;
	busy: boolean;
	open: Open;
	who: People;
}) {
	const p = view.proposals.find((p) => p.id === id);
	const [error, setError] = useState(""),
		[step, setStep] = useState<StepId>(),
		[focus, setFocus] = useState<{ id: string; nonce: number }>();
	if (!p) return <ArchivedRecord key={id} id={id} execute={execute} open={open} who={who} missing="This change is unavailable." />;
	const status = changeStatus(view, p),
		workspace = view.workspaces.find((w) => w.id === p.workspaceId),
		artifact = view.artifacts.find((a) => a.id === p.artifactId),
		recovery = view.promotionRecovery[p.id];
	const notes = changeNotes(view, p);
	const focusNote = (noteId: string) => setFocus({ id: noteId, nonce: Date.now() });
	const verifications = view.verifications.filter((v) => v.proposalId === p.id);
	const reports = view.artifacts.filter(
		(a) =>
			a.kind === "evidence" &&
			a.revision === p.revision &&
			(a.workspaceId === p.workspaceId || verifications.some((v) => v.artifactId === a.id)),
	);
	// While this promotion is still canonical, name the work it left behind. Information only: each workspace is
	// updated when its owner decides, just before its own review.
	const leftBehind =
		p.state === "promoted" && view.promotions.some((x) => x.proposalId === p.id && x.state === "complete" && x.to === view.sourceHead)
			? behindCanonical(view).filter((w) => w.id !== p.workspaceId)
			: [];
	return (
		<article
			className="change-page detail-page rv-page"
			style={{ "--lane": `var(--lane-${laneIndex(view).get(p.workspaceId) ?? 1})` } as CSSProperties}
		>
			<BackLink label="Workspaces" onClick={() => open("workspaces")} />
			<header className="change-header rv-head">
				<div className="page-title">
					<p className="kicker">
						<span>Change</span>
						<code>#{p.number}</code>
					</p>
					<h1>{p.title}</h1>
					<p className="change-meta">
						<LaneBullet lane={laneIndex(view).get(p.workspaceId)} />
						<Pill tone={status.tone}>{status.label}</Pill>
						{workspace && <span className="owner">Owner: {ownerName(workspace.ownerId, who)}</span>}
						{workspace && (
							<button type="button" className="text-button" onClick={() => open("workspaces", workspace.id)}>
								{workspace.title}
							</button>
						)}
						<span>
							<code title={p.revision}>{short(p.revision)}</code> on <code title={p.base}>{short(p.base)}</code>
						</span>
						{artifact && <span>{`published ${throughConnection(artifact.actor, who)} · ${ago(artifact.at)}`}</span>}
					</p>
					{["stale", "superseded", "promoted", "rejected"].includes(status.key) && <p className="status-detail">{status.detail}</p>}
					{leftBehind.length > 0 && (
						<p className="status-detail">
							{"Now behind canonical: "}
							{leftBehind.map((w, i) => (
								<Fragment key={w.id}>
									{i > 0 && ", "}
									<button type="button" className="text-button" onClick={() => open("workspaces", w.id)}>
										{w.title}
									</button>
								</Fragment>
							))}
							. {leftBehind.length === 1 ? "It needs" : "Each needs"} an update from canonical before its review.
						</p>
					)}
				</div>
				<ReviewNext
					view={view}
					p={p}
					who={who}
					notes={notes}
					step={step}
					setStep={setStep}
					execute={execute}
					busy={busy}
					onFocusNote={focusNote}
				/>
			</header>
			{step && p.state === "open" && (
				<StepDetail
					view={view}
					p={p}
					who={who}
					notes={notes}
					step={step}
					close={() => setStep(undefined)}
					execute={execute}
					onFocusNote={focusNote}
				/>
			)}
			{["promoting", "promoted"].includes(p.state) && recovery && (
				<section className="rv-detail" aria-label="Promotion">
					<h3>Promotion</h3>
					<p>
						{p.state === "promoted"
							? "Canonical was updated. Finish recording the completed promotion."
							: "The promotion was interrupted. Check its exact remote outcome before anything else is promoted."}
					</p>
					<div className="check-actions">
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
			<ReviewFiles view={view} p={p} execute={execute} who={who} focus={focus} />
			<Section title="Evidence and reviews">
				<ul className="timeline">
					{verifications.map((v) => (
						<li key={v.id}>
							<strong>
								{v.kind} {v.outcome}
							</strong>{" "}
							· {v.trust === "reported" ? `reported by ${actorLabel(v.actor)}` : `attested by ${actorLabel(v.actor)}`}
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
		</article>
	);
}
