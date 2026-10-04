import type { ControllerState } from "../../core/controller.ts";
import type { Flight } from "../../core/domain.ts";
import type { Snapshot } from "../../shared/api.ts";
import { Badge, Icon } from "../components.tsx";
import {
	agentName,
	attentionItems,
	congestionNeedsDecision,
	counts,
	decisionLabel,
	flightBadge,
	friendlyText,
	isActive,
	scopeOf,
	short,
} from "../model.ts";
import type { Selection } from "../radar/Radar.tsx";

interface Props {
	state: ControllerState;
	liveAgents: Snapshot["liveAgents"] | null;
	busy: boolean;
	attentionOnly: boolean;
	onSelect(selection: Selection): void;
	onAttention(value: boolean): void;
	onLaunch(input: { title: string; description: string; priority: string }): Promise<unknown>;
	act(cmd: Record<string, unknown>): Promise<unknown>;
}
export function Work({ state, busy, attentionOnly, onSelect, onAttention, act }: Props) {
	const c = counts(state);
	const attention = attentionItems(state);
	const allActive = state.flights.filter(isActive);
	const active = attentionOnly ? state.flights.filter((f) => attention.some((a) => a.flights.includes(f.id))) : allActive;
	const completed = state.flights.filter((f) => !isActive(f)).sort((a, b) => (b.landedAt ?? b.createdAt) - (a.landedAt ?? a.createdAt));
	const crossings = state.traffic.congestions.filter((x) => x.control !== "caution");
	return (
		<div className="work-page">
			<div className="page-heading">
				<div>
					<div className="page-kicker">{state.project.name.replace(" · live", "")}</div>
					<h1>Work</h1>
					<p className="page-description">
						{c.active
							? "Concurrent tasks, coordinated."
							: completed.length
								? "No active work. Review completed and closed runs below."
								: "Connected tools register work automatically."}
					</p>
				</div>
				<button
					type="button"
					className={`attention-summary${c.attention ? " needs-attention" : ""}`}
					onClick={() => onAttention(!attentionOnly)}
					aria-pressed={attentionOnly}
				>
					<Icon name={c.attention ? "alert" : "check"} size={18} />
					<span>
						<strong>
							{c.attention ? c.attention + (c.attention === 1 ? " needs your decision" : " need your decision") : "No action needed"}
						</strong>
						<span>{c.attention ? "Review the items below" : "0 need your attention"}</span>
					</span>
				</button>
			</div>
			{attention.length > 0 && (
				<section className="attention-list" aria-label="Needs attention">
					{attention.map((a) => (
						<div key={a.id}>
							<Icon name="alert" />
							<div>
								<strong>{friendlyText(a.title, state)}</strong>
								<p>{friendlyText(a.detail, state)}</p>
								<div className="inline-actions">
									{a.flights.map((id) => (
										<button type="button" className="link" key={id} onClick={() => onSelect({ kind: "flight", id })}>
											View {state.flights.find((f) => f.id === id)?.title ?? id}
										</button>
									))}
									{state.attention.some((item) => item.id === a.id) && (
										<button
											type="button"
											className="link"
											disabled={busy}
											onClick={() => void act({ type: "dismiss", attentionId: a.id }).catch(() => {})}
										>
											Acknowledge
										</button>
									)}
								</div>
							</div>
						</div>
					))}
				</section>
			)}
			{crossings.length > 0 && (
				<section className="coordination-strip" aria-label="Coordination">
					<div className="coordination-strip-icon">
						<Icon name="traffic" size={24} />
					</div>
					<div className="coordination-copy">
						<div className="coordination-title">
							{c.overlapping} tasks overlap<span className="text-divider">·</span>
							<span>
								{c.automatic === crossings.length
									? "Cruce handled it"
									: crossings.some((x) => congestionNeedsDecision(x, state))
										? "Decision needed"
										: "Coordination in place"}
							</span>
						</div>
						{crossings.map((x) => (
							<button type="button" className="coordination-link" key={x.key} onClick={() => onSelect({ kind: "congestion", key: x.key })}>
								<span>
									<span className="mono">{x.label || "Shared code"}</span>
									<span className="muted"> · {decisionLabel(x, state)}</span>
								</span>
								<span className="why-link">
									See why
									<Icon name="arrow" size={14} />
								</span>
							</button>
						))}
					</div>
				</section>
			)}
			<section className="work-section" aria-label={attentionOnly ? "Tasks needing attention" : "Active work"}>
				<div className="section-heading">
					<h2>
						{attentionOnly ? "Needs attention" : "Active work"}
						<span className="count">{active.length}</span>
					</h2>
					{attentionOnly ? (
						<button type="button" className="link" onClick={() => onAttention(false)}>
							Show all work
						</button>
					) : (
						<span className="muted small">Agent runs</span>
					)}
				</div>
				<div className="task-list">
					{active.map((f) => (
						<TaskRow key={f.id} flight={f} state={state} onSelect={onSelect} />
					))}
				</div>
				{!active.length && (
					<div className="empty-work">
						<Icon name={attentionOnly ? "check" : "work"} size={25} />
						<h3>
							{attentionOnly ? (attention.length ? "Review the attention items above" : "Nothing needs your attention") : "No active work"}
						</h3>
						<p>
							{attentionOnly
								? attention.length
									? "The controller has requested your attention."
									: "Routine coordination is handled automatically."
								: state.project.mode === "demo"
									? "Continue or replay the demo to see three agents work together."
									: "Continue in your existing coding tools. Cruce coordinates their reported work."}
						</p>
					</div>
				)}
			</section>
			{completed.length > 0 && !attentionOnly && (
				<section className="work-section recent-work" aria-label="Recent work">
					<div className="section-heading">
						<h2>
							Recent<span className="count">{completed.length}</span>
						</h2>
						<span className="muted small">Completed and closed runs</span>
					</div>
					{completed.map((f) => (
						<TaskRow key={f.id} flight={f} state={state} onSelect={onSelect} />
					))}
				</section>
			)}
			{c.active > 0 && !crossings.length && !attention.length && (
				<p className="quiet-note">
					<Icon name="check" />
					No coordination needed. Independent work can continue.
				</p>
			)}
		</div>
	);
}
export function TaskRow({ flight: f, state, onSelect }: { flight: Flight; state: ControllerState; onSelect(s: Selection): void }) {
	const clearance = state.traffic.clearances[f.id];
	const badge = flightBadge(f, clearance, state);
	const scope = scopeOf(f, state);
	const done = !isActive(f);
	const tests = f.publishes.filter((p) => p.approved).at(-1)?.tests;
	return (
		<button type="button" className={`task-row${done ? " task-row-done" : ""}`} onClick={() => onSelect({ kind: "flight", id: f.id })}>
			<span className={`task-state-icon tone-${badge.tone}`}>
				<Icon
					name={f.phase === "landed" ? "check" : badge.label === "Waiting" ? "pause" : badge.label === "Failed" ? "alert" : "code"}
					size={18}
				/>
			</span>
			<span className="task-main">
				<span className="task-title">{f.title}</span>
				<span className="task-meta">
					<span>{agentName(f)}</span>
					<span>·</span>
					<span className="mono">{f.id}</span>
					{done && f.landedCommit && (
						<>
							<span>·</span>
							<span className="mono">{short(f.landedCommit)}</span>
						</>
					)}
				</span>
				<span className="task-scope">
					{done
						? badge.label === "Failed"
							? badge.detail
							: (tests?.summary ?? badge.detail ?? "Run closed")
						: scope.length
							? scope.slice(0, 3).join(" · ") + (scope.length > 3 ? ` +${scope.length - 3}` : "")
							: badge.detail}
				</span>
				{!done && clearance?.held.length ? <span className="task-waiting">{badge.detail}</span> : null}
			</span>
			<span className="task-status">
				<Badge badge={badge} />
				<span className="task-status-description">
					{!done && clearance?.held.length
						? clearance.status === "partial"
							? "Partial clearance"
							: "Waiting for clearance"
						: done
							? f.phase === "landed"
								? "Integrated"
								: "Closed"
							: clearance?.status === "clear"
								? "Cleared to continue"
								: ""}
				</span>
			</span>
			<span className="row-arrow">
				<Icon name="chevron" size={15} />
			</span>
		</button>
	);
}
