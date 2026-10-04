import { resourceLabel } from "../../core/airspace.ts";
import type { ControllerState, TowerEvent } from "../../core/controller.ts";
import type { Flight } from "../../core/domain.ts";
import type { Congestion } from "../../core/traffic.ts";
import type { GitInfo } from "../../shared/api.ts";
import { congestionFor, flightBadge, LEVEL_NAMES, label, missionOf, routeOf, short, timeOf } from "../model.ts";
import type { Selection } from "../radar/Radar.tsx";

export type Act = (cmd: Record<string, unknown>) => void;

interface Props {
	state: ControllerState;
	git: GitInfo | null;
	selection: Selection;
	onSelect(sel: Selection): void;
	act: Act;
	busy: boolean;
	onHistory(target: string): void;
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
	}
	if (selection?.kind === "resource") return <ResourceDetail {...props} resource={selection.id} />;
	return <TrafficSummary {...props} />;
}

// ── traffic summary ───────────────────────────────────────────────────

function TrafficSummary({ state, onSelect, act, busy }: Props) {
	const congestions = state.traffic.congestions;
	const attention = [...state.traffic.attention, ...state.attention];
	const blocking = congestions.filter((c) => c.control !== "caution");
	const cautions = congestions.filter((c) => c.control === "caution");
	const replanning = state.flights.filter((f) => f.stale && !["landed", "failed", "lost", "cancelled"].includes(f.phase));
	return (
		<aside className="ctx">
			<div className="ctx-head">
				<div className="eyebrow">Traffic</div>
				<div className="ctx-title">{headline(state)}</div>
			</div>
			{attention.length > 0 && (
				<Block title="Needs a controller" tone="collision">
					{attention.map((a) => (
						<div key={a.id} className="attn">
							<div className="attn-title">{a.title}</div>
							<div className="attn-detail">{a.detail}</div>
							{state.attention.some((x) => x.id === a.id) && (
								<button type="button" className="btn small" disabled={busy} onClick={() => act({ type: "dismiss", attentionId: a.id })}>
									Acknowledge
								</button>
							)}
						</div>
					))}
				</Block>
			)}
			{replanning.length > 0 && (
				<Block title="Re-planning">
					{replanning.map((f) => (
						<button type="button" key={f.id} className="cg-card" onClick={() => onSelect({ kind: "flight", id: f.id })}>
							<div className="cg-card-top">
								<span className="mono">{f.id}</span>
								<span className="chip tone-caution">STALE</span>
							</div>
							<div className="cg-card-row">baseline moved when {f.stale?.byFlight} landed</div>
							{f.stale?.reasons.slice(0, 2).map((r) => (
								<div key={r} className="cg-card-row muted">
									{r}
								</div>
							))}
						</button>
					))}
				</Block>
			)}
			{blocking.length > 0 && (
				<Block title="Coordinated">
					{blocking.map((c) => (
						<button type="button" key={c.key} className="cg-card" onClick={() => onSelect({ kind: "congestion", key: c.key })}>
							<div className="cg-card-top">
								<span className="mono">{c.flights.join(" × ")}</span>
								<span className={`chip tone-${c.resolution === "auto" ? "clear" : "caution"}`}>
									{c.resolution === "auto" ? "AUTO-COORDINATED" : "OVERRIDE"}
								</span>
							</div>
							<div className="cg-card-label">{c.label}</div>
							{c.rightOfWay && (
								<div className="cg-card-row">
									<span className="mono">{c.rightOfWay.winner}</span> has right-of-way ·{" "}
									<span className="muted">{c.rightOfWay.rule.replace("-", " ")}</span>
								</div>
							)}
						</button>
					))}
				</Block>
			)}
			{cautions.length > 0 && (
				<Block title="Watching">
					{cautions.map((c) => (
						<button type="button" key={c.key} className="cg-card quiet" onClick={() => onSelect({ kind: "congestion", key: c.key })}>
							<div className="cg-card-top">
								<span className="mono">{c.flights.join(" × ")}</span>
								<span className="chip tone-muted">CAUTION</span>
							</div>
							<div className="cg-card-label">{c.label || "shared area"}</div>
						</button>
					))}
				</Block>
			)}
			{!congestions.length && !attention.length && !replanning.length && (
				<div className="ctx-empty">
					{state.flights.some((f) => f.plan && !["landed", "failed", "lost", "cancelled"].includes(f.phase))
						? "All active routes are independent. Every Flight is cleared."
						: state.flights.length && state.flights.every((f) => f.phase === "landed")
							? "Every Flight has landed. Canonical carries all of their work."
							: "Waiting for Flight Plans."}
				</div>
			)}
			<ArtifactsActivity state={state} />
			<Block title="Canonical">
				<KV k="repository" v={state.project.repo} mono />
				<KV k="head" v={short(state.canonical.head)} mono />
				<KV k="landed" v={`${state.flights.filter((f) => f.phase === "landed").length} Flight(s)`} />
				<KV k="index" v={`${state.index.files.length} files · ${state.index.modules.length} modules`} />
			</Block>
		</aside>
	);
}

function headline(s: ControllerState) {
	const blocking = s.traffic.congestions.filter((c) => c.control !== "caution").length;
	const attention = s.attention.length + s.traffic.attention.length;
	const active = s.flights.filter((f) => f.plan && !["landed", "failed", "lost", "cancelled"].includes(f.phase)).length;
	const stale = s.flights.filter((f) => f.stale && !["landed", "failed", "lost", "cancelled"].includes(f.phase)).length;
	if (attention) return `${attention} decision${attention === 1 ? "" : "s"} required`;
	if (stale && !blocking) return `${stale} Flight${stale === 1 ? "" : "s"} re-planning on the new baseline`;
	if (blocking) return `${blocking} congestion${blocking === 1 ? "" : "s"}, coordinated automatically`;
	if (active) return "Clear skies";
	if (s.flights.length && s.flights.every((f) => f.phase === "landed")) return `${s.flights.length} Flights landed`;
	return "Idle";
}

// ── flight detail ─────────────────────────────────────────────────────

function FlightDetail({ state, f, git, onSelect, act, busy, onHistory }: Props & { f: Flight }) {
	const c = state.traffic.clearances[f.id];
	const badge = flightBadge(f, c);
	const mission = missionOf(state, f);
	const route = routeOf(f, state);
	const congestions = congestionFor(state, f.id);
	const lastPublish = f.publishes.at(-1);
	const preflight = [...state.log].reverse().find((e) => e.type === "preflight" && e.flightId === f.id);
	const lastEvent = [...state.log].reverse().find((e) => e.flightId === f.id && e.type !== "flight.activity");
	const active = !["landed", "failed", "lost", "cancelled"].includes(f.phase);
	return (
		<aside className="ctx">
			<div className="ctx-head">
				<div className="ctx-head-row">
					<span className="mono ctx-id">{f.id}</span>
					<span className={`chip big tone-${badge.tone}`}>{badge.label === "PARTIAL" ? "PARTIAL CLEARANCE" : badge.label}</span>
				</div>
				<div className="ctx-title">{f.title}</div>
				{mission && mission.description !== f.title && <div className="ctx-desc">{mission.description}</div>}
			</div>

			{f.stale && (
				<div className="banner tone-caution">
					<div className="banner-title">Baseline changed — re-plan required</div>
					<ul>
						{f.stale.reasons.map((r) => (
							<li key={r}>{r}</li>
						))}
					</ul>
				</div>
			)}

			<div className="kv-grid">
				<KV k="agent" v={f.agentRuntime} />
				<KV k="phase" v={f.phase} />
				<KV k="baseline" v={short(f.baseline)} mono />
				<KV k="plan" v={f.plan ? `v${f.plan.planVersion}${f.plan.amendment ? " · amended" : ""}` : "not filed"} />
				<KV
					k="artifact"
					v={f.artifact?.repo ?? "—"}
					mono
					title={f.artifact?.remote}
					onClick={f.artifact ? () => onHistory(f.id) : undefined}
				/>
				<KV k="priority" v={f.priority} />
			</div>

			{f.activity && active && (
				<Block title="Current activity">
					<div className="activity">{f.activity.text}</div>
				</Block>
			)}

			{f.plan && (
				<Block title={`Route · plan v${f.plan.planVersion}`}>
					<div className="intent">{f.plan.intent}</div>
					{route.map((g) => (
						<div key={g.module} className="route-group">
							<div className="route-mod">{g.module}</div>
							{g.entries.map((e) => (
								<div key={e.resource} className={`route-row st-${e.state}`}>
									<span className={`mode mode-${e.mode}`} title={e.mode}>
										{e.mode === "contract" ? "◆" : e.mode === "write" ? "✎" : "○"}
									</span>
									<span className="mono">{e.label}</span>
									{e.mode === "contract" && <span className="tag">contract</span>}
								</div>
							))}
						</div>
					))}
					{f.plan.assumptions.length > 0 && (
						<div className="assumptions">
							{f.plan.assumptions.map((a) => (
								<div key={a}>assumes: {a}</div>
							))}
						</div>
					)}
				</Block>
			)}

			{c && (
				<Block title="Clearance">
					{c.cleared.map((r) => (
						<div key={r} className="cl-row ok">
							<span className="cl-mark">✓</span>
							<span className="mono">{label(r, state.index)}</span>
						</div>
					))}
					{c.held.map((h) => (
						<div key={h.resource} className="cl-row held">
							<span className="cl-mark">×</span>
							<span className="mono">{label(h.resource, state.index)}</span>
							<span className="cl-wait">
								{h.waitingOn === "replan" ? "re-plan" : h.waitingOn === "controller" ? "controller" : `after ${h.waitingOn}`}
							</span>
						</div>
					))}
					{c.landAfter.map((l) => (
						<div key={l.flightId} className="cl-row seq">
							<span className="cl-mark">↳</span>
							<span>lands after</span>
							<span className="mono">{l.flightId}</span>
						</div>
					))}
					{!c.cleared.length && !c.held.length && <div className="muted">read-only route</div>}
				</Block>
			)}

			{(c?.held.length ?? 0) > 0 && (
				<Block title="Why">
					{congestions
						.filter((x) => x.rightOfWay?.loser === f.id)
						.map((x) => (
							<div key={x.key}>
								<p className="why">
									<span className="mono">{x.rightOfWay?.winner}</span> has right-of-way on {x.label}:
								</p>
								<ul className="because">
									{x.rightOfWay?.because.map((b) => (
										<li key={b}>{b}</li>
									))}
								</ul>
							</div>
						))}
					{c?.held.some((h) => h.waitingOn === "replan") && <p className="why">{c.held.find((h) => h.waitingOn === "replan")?.reason}</p>}
					{c?.held.some((h) => h.waitingOn === "controller") && <p className="why">A controller is holding this airspace.</p>}
				</Block>
			)}

			{congestions.length > 0 && (
				<Block title="Intersections">
					{congestions.map((x) => (
						<button type="button" key={x.key} className="cg-card" onClick={() => onSelect({ kind: "congestion", key: x.key })}>
							<div className="cg-card-top">
								<span className="mono">{x.flights.join(" × ")}</span>
								<span className={`chip tone-${x.control === "caution" ? "muted" : x.severity === "critical" ? "collision" : "caution"}`}>
									L{x.level} {LEVEL_NAMES[x.level]}
								</span>
							</div>
							<div className="cg-card-label">{x.label}</div>
						</button>
					))}
				</Block>
			)}

			{(lastPublish || preflight) && (
				<Block title="Git">
					{f.publishes.slice(-4).map((p) => (
						<div key={`${p.commit}${p.at}`} className={`pub ${p.approved ? "ok" : "rej"}`}>
							<div className="pub-top">
								<span className="mono">{short(p.commit)}</span>
								<span className={`chip tone-${p.approved ? "clear" : "hold"}`}>
									{p.approved ? (p.verified ? "PUSHED" : "APPROVED") : "REJECTED"}
								</span>
							</div>
							<div className="pub-msg">{p.message}</div>
							{!p.approved && p.outside.length > 0 && (
								<div className="pub-out">outside clearance: {p.outside.map((o) => resourceLabel(o, state.index)).join(", ")}</div>
							)}
							{p.tests && <div className={`pub-tests ${p.tests.passed ? "" : "fail"}`}>{p.tests.summary}</div>}
						</div>
					))}
					{preflight && (
						<div className="preflight">
							<div className="eyebrow small">Actual Git (preflight)</div>
							<div>{preflight.title.replace(`${f.id} `, "")}</div>
							{preflight.detail?.map((d) => (
								<div key={d} className="muted mono small">
									{d}
								</div>
							))}
						</div>
					)}
					{f.artifact && (
						<button type="button" className="btn small ghost" onClick={() => onHistory(f.id)}>
							{git?.backend === "artifacts" ? "Open Artifacts history" : "Open history"}
						</button>
					)}
				</Block>
			)}

			{f.planHistory.length > 1 && (
				<Block title="Plan history">
					{f.planHistory.map((p) => (
						<div key={p.planVersion} className="ph-row">
							<span className="mono">v{p.planVersion}</span>
							<span className="ph-text">
								{p.amendment ? p.amendment.reason : "filed after discovery"}
								{p.amendment && (p.amendment.added.length > 0 || p.amendment.removed.length > 0) && (
									<span className="ph-diff">
										{p.amendment.added.map((a) => (
											<span key={a} className="add">
												+ {a}
											</span>
										))}
										{p.amendment.removed.map((a) => (
											<span key={a} className="rem">
												− {a}
											</span>
										))}
									</span>
								)}
							</span>
						</div>
					))}
				</Block>
			)}

			{lastEvent && (
				<Block title="Last event">
					<EventLine e={lastEvent} />
				</Block>
			)}

			{active && (
				<div className="ctx-actions">
					{(c?.held.length ?? 0) > 0 && (
						<button type="button" className="btn" disabled={busy} onClick={() => act({ type: "reroute", flightId: f.id })}>
							Reroute around hold
						</button>
					)}
					{state.project.mode === "live" && (
						<button type="button" className="btn" disabled={busy} onClick={() => act({ type: "land", flightId: f.id })}>
							Request landing
						</button>
					)}
					<button type="button" className="btn danger" disabled={busy} onClick={() => act({ type: "cancel", flightId: f.id })}>
						Cancel Flight
					</button>
				</div>
			)}
		</aside>
	);
}

// ── congestion detail ─────────────────────────────────────────────────

function CongestionDetail({ state, c, act, busy, onSelect }: Props & { c: Congestion }) {
	const [a, b] = c.flights;
	const fa = state.flights.find((f) => f.id === a);
	const fb = state.flights.find((f) => f.id === b);
	const row = c.rightOfWay;
	const auto = c.resolution === "auto";
	return (
		<aside className="ctx">
			<div className="ctx-head">
				<div className="eyebrow">Congestion</div>
				<div className="ctx-title mono">{c.label || "Intent overlap"}</div>
				<div className="levels">
					{c.levels.map((l) => (
						<span key={l} className={`chip tone-${l === c.level ? (c.severity === "critical" ? "collision" : "caution") : "muted"}`}>
							L{l} {LEVEL_NAMES[l]}
						</span>
					))}
					<span className={`chip tone-${auto ? "clear" : "caution"}`}>{auto ? "AUTO-COORDINATED" : `OVERRIDE · ${c.override?.kind}`}</span>
				</div>
			</div>

			<div className="pair">
				{[fa, fb].map(
					(f) =>
						f && (
							<button type="button" key={f.id} className="pair-flight" onClick={() => onSelect({ kind: "flight", id: f.id })}>
								<span className="mono">{f.id}</span>
								<span>{f.title}</span>
								<span className={`chip tone-${flightBadge(f, state.traffic.clearances[f.id]).tone}`}>
									{flightBadge(f, state.traffic.clearances[f.id]).label}
								</span>
							</button>
						),
				)}
			</div>

			<Block title="Why they intersect">
				<ul className="because">
					{c.why.map((w) => (
						<li key={w}>{w}</li>
					))}
				</ul>
			</Block>

			{row && (
				<Block title="Right-of-way">
					<p className="why">
						<span className="mono">{row.winner}</span> proceeds first ({row.rule.replace(/-/g, " ")}):
					</p>
					<ol className="because numbered">
						{row.because.map((w) => (
							<li key={w}>{w}</li>
						))}
					</ol>
				</Block>
			)}

			<Block title="Traffic plan">
				<ol className="plan">
					{c.plan.map((p) => (
						<li key={p}>{p}</li>
					))}
				</ol>
			</Block>

			<div className="ctx-actions grid">
				{auto ? (
					<button
						type="button"
						className="btn primary"
						disabled={busy}
						onClick={() => act({ type: "override", congestionKey: c.key, kind: "accept" })}
					>
						Accept plan
					</button>
				) : (
					<button
						type="button"
						className="btn primary"
						disabled={busy}
						onClick={() => act({ type: "clear-override", congestionKey: c.key })}
					>
						Undo · back to auto
					</button>
				)}
				<button
					type="button"
					className="btn"
					disabled={busy}
					onClick={() => act({ type: "override", congestionKey: c.key, kind: "allow-both" })}
				>
					Allow both
				</button>
				<button
					type="button"
					className="btn"
					disabled={busy}
					onClick={() => act({ type: "override", congestionKey: c.key, kind: "first", flightId: a })}
				>
					{a} first
				</button>
				<button
					type="button"
					className="btn"
					disabled={busy}
					onClick={() => act({ type: "override", congestionKey: c.key, kind: "first", flightId: b })}
				>
					{b} first
				</button>
				<button
					type="button"
					className="btn"
					disabled={busy}
					onClick={() => act({ type: "override", congestionKey: c.key, kind: "hold-both" })}
				>
					Hold both
				</button>
				{row && (
					<button type="button" className="btn" disabled={busy} onClick={() => act({ type: "reroute", flightId: row.loser })}>
						Reroute {row.loser}
					</button>
				)}
				{row && (
					<button type="button" className="btn danger" disabled={busy} onClick={() => act({ type: "cancel", flightId: row.loser })}>
						Cancel {row.loser}
					</button>
				)}
			</div>
		</aside>
	);
}

// ── resource detail ───────────────────────────────────────────────────

function ResourceDetail({ state, resource, onSelect }: Props & { resource: string }) {
	const users = Object.entries(state.traffic.occupancy).filter(
		([r]) => r === resource || r.startsWith(`${resource.replace(/^f:/, "s:")}#`),
	);
	return (
		<aside className="ctx">
			<div className="ctx-head">
				<div className="eyebrow">Airspace</div>
				<div className="ctx-title mono">{label(resource, state.index)}</div>
				<div className="ctx-desc mono">{resource.replace(/^[fsm]:/, "")}</div>
			</div>
			<Block title="Routing through">
				{users.length === 0 && <div className="muted">No active routes.</div>}
				{users.map(([r, list]) =>
					list.map((u) => (
						<button
							type="button"
							key={`${r}${u.flightId}`}
							className="cl-row link"
							onClick={() => onSelect({ kind: "flight", id: u.flightId })}
						>
							<span className="mono">{u.flightId}</span>
							<span className={`mode mode-${u.mode}`}>{u.mode}</span>
							<span className="mono muted">{label(r, state.index)}</span>
						</button>
					)),
				)}
			</Block>
		</aside>
	);
}

// ── bits ──────────────────────────────────────────────────────────────

/** Repository activity as reported by Artifacts events (operational context, not a dashboard). */
function ArtifactsActivity({ state }: { state: ControllerState }) {
	const events = state.log.filter((e) => e.type === "artifacts.event" || e.type === "push.received");
	const count = (re: RegExp) => events.filter((e) => re.test(e.title)).length;
	const pushes = count(/confirmed push to/);
	const notes = count(/confirmed Cruce notes/);
	const issued = count(/token\.created/);
	const revoked = count(/token\.revoked/);
	if (!pushes && !issued) return null;
	return (
		<Block title="Artifacts activity">
			<KV k="pushes confirmed" v={`${pushes} (+${notes} notes)`} />
			<KV k="tokens issued / revoked" v={`${issued} / ${revoked}`} />
			<KV k="Flight forks" v={String(state.flights.filter((f) => f.artifact).length)} />
		</Block>
	);
}

function Block({ title, children, tone }: { title: string; children: React.ReactNode; tone?: string }) {
	return (
		<section className={`block ${tone ? `tone-${tone}` : ""}`}>
			<h3 className="eyebrow">{title}</h3>
			{children}
		</section>
	);
}

function KV({ k, v, mono, title, onClick }: { k: string; v: string; mono?: boolean; title?: string; onClick?: () => void }) {
	return (
		<div className="kv">
			<span className="kv-k">{k}</span>
			{onClick ? (
				<button type="button" className={`kv-v link ${mono ? "mono" : ""}`} title={title} onClick={onClick}>
					{v}
				</button>
			) : (
				<span className={`kv-v ${mono ? "mono" : ""}`} title={title}>
					{v}
				</span>
			)}
		</div>
	);
}

export function EventLine({ e }: { e: TowerEvent }) {
	return (
		<div className="ev-line">
			<span className="ev-time mono">{timeOf(e.at)}</span>
			<span className={`ev-actor a-${e.actor}`}>{e.actor}</span>
			<span className="ev-title">{e.title}</span>
		</div>
	);
}
