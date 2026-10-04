import { isAncestorOrEqual } from "../../core/airspace.ts";
import type { ControllerState } from "../../core/controller.ts";
import type { Flight } from "../../core/domain.ts";
import type { Congestion } from "../../core/traffic.ts";
import type { GitInfo } from "../../shared/api.ts";
import { Badge, Icon } from "../components.tsx";
import {
	agentName,
	attentionItems,
	congestionFor,
	congestionNeedsDecision,
	decisionLabel,
	eventText,
	flightBadge,
	friendlyText,
	isActive,
	LEVEL_NAMES,
	label,
	missionOf,
	routeOf,
	short,
	taskName,
	timeOf,
} from "../model.ts";
import type { Selection } from "../radar/Radar.tsx";
import { Changes } from "./Changes.tsx";

export type Act = (cmd: Record<string, unknown>) => Promise<unknown>;
interface Props {
	state: ControllerState;
	git: GitInfo | null;
	projectId: string;
	selection: Selection;
	integrationBlockers: Record<string, string[]>;
	busy: boolean;
	onSelect(selection: Selection): void;
	act: Act;
	onHistory(target: string): void;
	onTraffic(): void;
}
export function ContextPanel(props: Props) {
	const { state, selection } = props;
	if (selection?.kind === "flight") {
		const f = state.flights.find((x) => x.id === selection.id);
		if (f) return <FlightDetail {...props} f={f} />;
	}
	if (selection?.kind === "congestion") {
		const c = state.traffic.congestions.find((x) => x.key === selection.key);
		if (c) return <CongestionDetail {...props} c={c} />;
		return (
			<div className="resolved-state">
				<Icon name="check" size={26} />
				<h1>This overlap has resolved</h1>
				<p>The controller has rechecked the active plans. See task activity for the sequence of decisions.</p>
				<button type="button" className="btn" onClick={() => props.onSelect(null)}>
					Back to work
				</button>
			</div>
		);
	}
	if (selection?.kind === "resource") return <ResourceDetail {...props} resource={selection.id} />;
	return (
		<div className="empty-work">
			<h2>This run is no longer available</h2>
			<p>The demo may have been reset.</p>
		</div>
	);
}
function FlightDetail({ state, f, projectId, integrationBlockers, onSelect, act, busy, onHistory, onTraffic }: Props & { f: Flight }) {
	const clearance = state.traffic.clearances[f.id];
	const badge = flightBadge(f, clearance, state);
	const mission = missionOf(state, f);
	const active = isActive(f);
	const crossings = congestionFor(state, f.id);
	const route = routeOf(f, state);
	const latest = f.publishes.filter((p) => p.approved).at(-1);
	const validationSkipped = latest?.tests?.summary === "no test script (validation skipped)";
	const blockers = integrationBlockers[f.id] ?? [];
	const events = state.log
		.filter((e) => e.flightId === f.id && !["artifacts.event", "push.received", "flight.activity"].includes(e.type))
		.slice(-18);
	return (
		<article className="task-detail">
			<div className="detail-title-row">
				<div>
					<div className="page-kicker">
						<span className="mono">{f.id}</span>
						<span>Agent run</span>
					</div>
					<h1>{f.title}</h1>
					<div className="detail-meta">
						<Badge badge={badge} />
						<span>{agentName(f)}</span>
						{f.agent === "mock" && <span className="muted">Scripted demo</span>}
						<span className="muted">Started {timeOf(f.startedAt ?? f.createdAt)}</span>
					</div>
				</div>
				{active && (
					<details className="action-menu">
						<summary aria-label="Run actions">
							<Icon name="more" />
						</summary>
						<div className="menu-content">
							{clearance?.held.length ? (
								<button
									type="button"
									disabled={busy || f.instruction?.status === "pending"}
									onClick={() => void act({ type: "reroute", flightId: f.id }).catch(() => {})}
								>
									Request reroute
								</button>
							) : null}
							<button
								type="button"
								className="danger"
								disabled={busy}
								onClick={() => void act({ type: "cancel", flightId: f.id }).catch(() => {})}
							>
								Cancel run
							</button>
						</div>
					</details>
				)}
			</div>
			{f.failureReason && (
				<p className="notice error">
					<Icon name="alert" />
					{friendlyText(f.failureReason, state)}
				</p>
			)}
			{f.stale && (
				<div className="notice">
					<Icon name="clock" />
					<div>
						<strong>Updating the plan</strong>
						<p>{taskName(state, f.stale.byFlight)} changed the baseline. Cruce requires a refreshed plan before publishing more changes.</p>
					</div>
				</div>
			)}
			{f.instruction && active && (
				<p className="notice">
					<Icon name="traffic" />
					{f.instruction.status === "pending"
						? "Reroute requested. Waiting for the agent to receive it."
						: "The agent received the reroute request. Plan changes appear in activity."}
				</p>
			)}
			<div className="detail-columns">
				<div className="detail-main">
					<section className="detail-section">
						<h2>Summary</h2>
						<p>{mission?.description ?? f.title}</p>
						{active && f.activity && (
							<div className="current-activity">
								<span className="status-dot" />
								<span>{friendlyText(f.activity.text, state)}</span>
							</div>
						)}
					</section>
					{f.plan && (
						<section className="detail-section">
							<div className="section-heading">
								<h2>Plan</h2>
								<span className="muted small">v{f.plan.planVersion}</span>
							</div>
							<p>{friendlyText(f.plan.objective, state)}</p>
							{clearance && active ? (
								<div className="clearance-columns">
									<div>
										<h3>
											<Icon name="check" />
											Can continue
										</h3>
										{clearance.cleared.length ? (
											<ul className="scope-list">
												{clearance.cleared.map((r) => (
													<li key={r}>
														<Icon name="check" size={13} />
														<button type="button" className="resource-link mono" onClick={() => onSelect({ kind: "resource", id: r })}>
															{label(r, state.index)}
														</button>
													</li>
												))}
											</ul>
										) : (
											<p className="muted small">{clearance.held.length ? "Work is waiting for clearance." : "Read-only scope."}</p>
										)}
									</div>
									{clearance.held.length > 0 && (
										<div className="waiting-scope">
											<h3>
												<Icon name="pause" />
												Waiting for
											</h3>
											<ul className="scope-list">
												{clearance.held.map((h) => (
													<li key={h.resource}>
														<Icon name="pause" size={13} />
														<div>
															<button
																type="button"
																className="resource-link mono"
																onClick={() => onSelect({ kind: "resource", id: h.resource })}
															>
																{label(h.resource, state.index)}
															</button>
															<p>
																{h.waitingOn === "replan"
																	? "Updated plan"
																	: h.waitingOn === "controller"
																		? "Held by a human decision"
																		: taskName(state, h.waitingOn)}
															</p>
														</div>
													</li>
												))}
											</ul>
											<span className="secondary-label">{clearance.status === "partial" ? "Partial clearance" : "Hold"}</span>
										</div>
									)}
								</div>
							) : (
								<div className="completed-scope">
									{route.map((group) => (
										<div key={group.module}>
											<h3>{group.module}</h3>
											<p className="mono muted">
												{group.entries
													.filter((e) => e.mode !== "read")
													.map((e) => e.label)
													.join(" · ")}
											</p>
										</div>
									))}
								</div>
							)}
							{clearance?.landAfter.length ? (
								<p className="integration-wait">
									<Icon name="clock" />
									Can work now. Integration waits for {clearance.landAfter.map((x) => taskName(state, x.flightId)).join(", ")}.
								</p>
							) : null}
						</section>
					)}
					{crossings.length > 0 && (
						<section className="detail-section">
							<div className="section-heading">
								<h2>Coordination</h2>
								<button type="button" className="link" onClick={onTraffic}>
									View in Traffic
									<Icon name="arrow" size={13} />
								</button>
							</div>
							{crossings.map((c) => (
								<button type="button" className="decision-row" key={c.key} onClick={() => onSelect({ kind: "congestion", key: c.key })}>
									<Icon name="traffic" size={20} />
									<span>
										<strong>{c.rightOfWay ? `${taskName(state, c.rightOfWay.winner)} goes first` : c.label || "Shared scope"}</strong>
										<span>
											{c.label} · {decisionLabel(c, state)}
										</span>
									</span>
									<Icon name="chevron" size={15} />
								</button>
							))}
						</section>
					)}
					<Changes projectId={projectId} flight={f} canonical={state.canonical.head} />
					<section className="detail-section">
						<h2>Activity</h2>
						<ol className="timeline">
							{events.map((e) => (
								<li key={e.seq}>
									<span
										className={`timeline-dot ${["publish.rejected", "flight.stale", "flight.failed"].includes(e.type) ? "caution" : ""}`}
									/>
									<div>
										<div className="timeline-title">{eventText(e, state)}</div>
										{e.type === "plan.amended" && e.detail?.[0] && <p>{friendlyText(e.detail[0], state)}</p>}
										<time>{timeOf(e.at)}</time>
									</div>
								</li>
							))}
						</ol>
					</section>
				</div>
				<aside className="detail-aside" aria-label="Run context">
					{f.cleanup && (
						<section>
							<h3>Resource cleanup</h3>
							<p>
								{f.cleanup.deletedAt !== undefined
									? `Repository removed ${timeOf(f.cleanup.deletedAt)}`
									: f.cleanup.status === "retrying"
										? "Cruce is retrying cleanup."
										: f.cleanup.keep
											? "Published work kept for recovery."
											: f.phase === "landed"
												? "Removing the Flight repository. Accepted work is preserved in main."
												: `Published work expires ${new Date(f.cleanup.expiresAt).toLocaleString()}`}
							</p>
							{f.phase !== "landed" && f.cleanup.deletedAt === undefined && (
								<button
									type="button"
									className="link"
									disabled={busy}
									onClick={() => void act({ type: "retain", flightId: f.id, keep: !f.cleanup?.keep }).catch(() => {})}
								>
									{f.cleanup.keep ? "Restore automatic expiry" : "Keep for recovery"}
								</button>
							)}
						</section>
					)}
					<section>
						<h3>Validation</h3>
						{latest?.tests ? (
							<>
								<span className={`validation-result ${validationSkipped ? "muted" : latest.tests.passed ? "add" : "remove"}`}>
									<Icon name={validationSkipped ? "pause" : latest.tests.passed ? "check" : "alert"} />
									{validationSkipped ? "Skipped" : latest.tests.passed ? "Passed" : "Not passed"}
								</span>
								<p>{latest.tests.summary}</p>
								<span className="mono muted small">{short(latest.commit)}</span>
							</>
						) : (
							<p className="muted">No validation reported yet.</p>
						)}
					</section>
					<section>
						<h3>Integration</h3>
						{f.landedCommit ? (
							<>
								<span className="validation-result add">
									<Icon name="check" />
									Integrated into main
								</span>
								<p className="mono">{short(f.landedCommit)}</p>
							</>
						) : active ? (
							blockers.length ? (
								<ul className="blocker-list">
									{blockers.map((reason) => (
										<li key={reason}>{friendlyText(reason, state)}</li>
									))}
								</ul>
							) : (
								<p>Ready for integration.</p>
							)
						) : (
							<p className="muted">Run closed.</p>
						)}
						<button type="button" className="link" onClick={() => onHistory(f.id)}>
							View commit history
							<Icon name="arrow" size={13} />
						</button>
					</section>
					<details className="advanced-details">
						<summary>Advanced details</summary>
						<dl>
							<dt>Run</dt>
							<dd className="mono">{f.id}</dd>
							<dt>Baseline</dt>
							<dd className="mono">{short(f.baseline)}</dd>
							<dt>Priority</dt>
							<dd>{f.priority}</dd>
							<dt>Runtime</dt>
							<dd>{f.agentRuntime}</dd>
							{f.artifact && (
								<>
									<dt>Artifacts repository</dt>
									<dd className="mono">{f.artifact.repo}</dd>
								</>
							)}
							{f.sandboxId && (
								<>
									<dt>Sandbox</dt>
									<dd className="mono">{f.sandboxId}</dd>
								</>
							)}
						</dl>
						{route.map((g) => (
							<div key={g.module}>
								<h4>{g.module}</h4>
								{g.entries.map((e) => (
									<p key={e.resource} className="advanced-scope">
										<span>{e.mode}</span>
										<span className="mono">{e.label}</span>
									</p>
								))}
							</div>
						))}
						{f.plan?.assumptions.length ? (
							<>
								<h4>Assumptions</h4>
								<ul>
									{f.plan.assumptions.map((a) => (
										<li key={a}>{friendlyText(a, state)}</li>
									))}
								</ul>
							</>
						) : null}
						{f.planHistory.length > 1 && (
							<>
								<h4>Plan amendments</h4>
								{f.planHistory
									.filter((p) => p.amendment)
									.map((p) => (
										<p key={p.planVersion}>
											v{p.planVersion} · {friendlyText(p.amendment?.reason ?? "", state)}
										</p>
									))}
							</>
						)}
						<h4>Leases</h4>
						{state.leases
							.filter((l) => l.flightId === f.id)
							.map((l) => (
								<p key={l.resource}>
									<span className="mono">{label(l.resource, state.index)}</span>
									<br />
									Expires {timeOf(l.expiresAt)}
								</p>
							))}
					</details>
				</aside>
			</div>
		</article>
	);
}
function CongestionDetail({ state, c, act, busy, onSelect, onTraffic }: Props & { c: Congestion }) {
	const row = c.rightOfWay;
	const sharedHold = c.override?.kind === "hold-both";
	const needsDecision = congestionNeedsDecision(c, state);
	const semanticAttention = attentionItems(state).filter((a) => a.kind === "semantic" && c.flights.every((id) => a.flights.includes(id)));
	const evidence = semanticAttention.length ? semanticAttention.map((a) => a.detail) : (row?.because ?? c.why);
	return (
		<article className="decision-detail">
			<div className="page-kicker">
				Cruce decision<span className={`decision-source ${needsDecision ? "remove" : ""}`}>{decisionLabel(c, state)}</span>
			</div>
			<h1>
				{needsDecision
					? "These tasks need a decision"
					: sharedHold
						? "Shared changes are on hold"
						: row
							? `${taskName(state, row.winner)} goes first`
							: "Work can continue"}
			</h1>
			<p className="decision-intro">
				{needsDecision
					? "Review the evidence below. Existing scope clearances remain in effect."
					: sharedHold
						? "A human decision is holding the shared scope. Each task can continue only within its remaining clearance."
						: row
							? "Shared changes are sequenced. Independent work can continue."
							: friendlyText(c.why[0] ?? "Cruce is checking the overlap.", state)}
			</p>
			<section className="crossing-diagram" aria-label={`Shared code: ${c.label}`}>
				<div className="crossing-tasks">
					{c.flights.map((id) => (
						<button type="button" key={id} onClick={() => onSelect({ kind: "flight", id })}>
							{taskName(state, id)}
							<span className="mono muted">{id}</span>
						</button>
					))}
				</div>
				<svg viewBox="0 0 200 104" fill="none" aria-hidden="true">
					<path d="M0 22h35c60 0 55 60 110 60h55" stroke="var(--working)" strokeWidth="1.5" />
					<path d="M0 82h35c20 0 32-7 47-25" stroke="var(--caution)" strokeWidth="1.5" strokeDasharray="4 4" />
					<path d="M110 42c12-12 20-20 40-20h50" stroke="var(--caution)" strokeWidth="1.5" />
					<circle cx="99" cy="52" r="6" fill="var(--bg)" stroke="var(--caution)" strokeWidth="2" />
				</svg>
				<div className="crossing-resource">
					<Icon name="code" />
					<span className="mono">{c.label || "Shared scope"}</span>
				</div>
			</section>
			<div className="decision-content">
				<section className="detail-section">
					<h2>Why this decision</h2>
					<ul className="evidence-list">
						{evidence.map((text) => (
							<li key={text}>{friendlyText(text, state)}</li>
						))}
					</ul>
					<p className="decision-rule">
						Source:{" "}
						{needsDecision
							? "Semantic check"
							: c.override
								? "Human override"
								: c.level === 4 && !row
									? "Semantic check"
									: "Deterministic rules"}
						{row && !needsDecision && ` · ${row.rule.replace(/-/g, " ")}`}
					</p>
				</section>
				<section className="detail-section">
					<h2>What happens now</h2>
					{c.flights.map((id) => {
						const f = state.flights.find((x) => x.id === id);
						const clearance = state.traffic.clearances[id];
						if (!f) return null;
						return (
							<div className="decision-outcome" key={id}>
								<div>
									<strong>{f.title}</strong>
									<Badge badge={flightBadge(f, clearance, state)} />
								</div>
								{clearance?.cleared.length ? (
									<p>
										Can continue: <span className="mono">{clearance.cleared.map((r) => label(r, state.index)).join(", ")}</span>
									</p>
								) : null}
								{clearance?.held.length ? (
									<p className="waiting-text">
										Waiting for: <span className="mono">{clearance.held.map((h) => label(h.resource, state.index)).join(", ")}</span>
									</p>
								) : null}
								{clearance?.landAfter.length ? (
									<p>Integration waits for {clearance.landAfter.map((x) => taskName(state, x.flightId)).join(", ")}.</p>
								) : null}
							</div>
						);
					})}
				</section>
				<div className="decision-actions">
					<button type="button" className="btn" onClick={onTraffic}>
						<Icon name="traffic" />
						View in Traffic
					</button>
					<details className="action-menu">
						<summary className="btn">
							Change coordination
							<Icon name="chevron" size={13} />
						</summary>
						<div className="menu-content">
							{c.flights.map((id) => (
								<button
									type="button"
									key={id}
									disabled={busy}
									onClick={() => void act({ type: "override", congestionKey: c.key, kind: "first", flightId: id }).catch(() => {})}
								>
									{taskName(state, id)} first
								</button>
							))}
							<button
								type="button"
								disabled={busy}
								onClick={() => void act({ type: "override", congestionKey: c.key, kind: "allow-both" }).catch(() => {})}
							>
								Allow both
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => void act({ type: "override", congestionKey: c.key, kind: "hold-both" }).catch(() => {})}
							>
								Hold both
							</button>
							{row && (
								<button type="button" disabled={busy} onClick={() => void act({ type: "reroute", flightId: row.loser }).catch(() => {})}>
									Request reroute for {taskName(state, row.loser)}
								</button>
							)}
							{c.override && (
								<button
									type="button"
									disabled={busy}
									onClick={() => void act({ type: "clear-override", congestionKey: c.key }).catch(() => {})}
								>
									Restore automatic coordination
								</button>
							)}
						</div>
					</details>
				</div>
				<details className="decision-evidence advanced-details">
					<summary>Decision evidence</summary>
					<p>{c.levels.map((l) => LEVEL_NAMES[l]).join(" · ")}</p>
					<ul>
						{c.why.map((why) => (
							<li key={why}>{friendlyText(why, state)}</li>
						))}
					</ul>
					<ol>
						{c.plan.map((step) => (
							<li key={step}>{friendlyText(step, state)}</li>
						))}
					</ol>
					{state.semantic
						.filter((f) => f.flights.every((id) => c.flights.includes(id)))
						.map((f) => (
							<p key={f.summary}>
								{f.summary} · {f.source} · {Math.round(f.confidence * 100)}% confidence
							</p>
						))}
				</details>
			</div>
		</article>
	);
}
function ResourceDetail({ state, resource, onSelect }: Props & { resource: string }) {
	const entries = Object.entries(state.traffic.occupancy).filter(
		([r]) => isAncestorOrEqual(resource, r, state.index) || isAncestorOrEqual(r, resource, state.index),
	);
	const runs = [...new Set(entries.flatMap(([, occupants]) => occupants.map((o) => o.flightId)))];
	const attention = attentionItems(state);
	return (
		<article className="resource-detail">
			<div className="page-kicker">Code area</div>
			<h1 className="mono">{label(resource, state.index)}</h1>
			<p className="resource-path mono muted">{resource.replace(/^[msf]:/, "")}</p>
			<section className="detail-section">
				<h2>Active work here</h2>
				{runs.map((id) => {
					const f = state.flights.find((x) => x.id === id);
					if (!f || !isActive(f)) return null;
					return (
						<button type="button" className="decision-row" key={id} onClick={() => onSelect({ kind: "flight", id })}>
							<Icon name="code" />
							<span>
								<strong>{f.title}</strong>
								<span>
									{entries
										.filter(([, os]) => os.some((o) => o.flightId === id))
										.map(([r]) => label(r, state.index))
										.join(" · ")}
								</span>
							</span>
							<Badge badge={flightBadge(f, state.traffic.clearances[id], state)} />
						</button>
					);
				})}
				{!runs.length && <p className="muted">No active task is using this scope.</p>}
			</section>
			{attention
				.filter((a) => a.flights.some((id) => runs.includes(id)))
				.map((a) => (
					<p className="notice" key={a.id}>
						{friendlyText(a.title, state)}
					</p>
				))}
		</article>
	);
}
