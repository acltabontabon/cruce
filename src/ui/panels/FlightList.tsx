import type { ControllerState } from "../../core/controller.ts";
import type { Flight } from "../../core/domain.ts";
import { flightBadge, isActive, missionOf, short } from "../model.ts";

interface Props {
	state: ControllerState;
	selected: string | null;
	onSelect(id: string): void;
	onHover(id: string | null): void;
}

export function FlightList({ state, selected, onSelect, onHover }: Props) {
	const active = state.flights.filter(isActive);
	const done = state.flights.filter((f) => !isActive(f));
	const sequencing = state.traffic.edges;
	return (
		<nav className="flights" aria-label="Flights">
			<Section title="Flights" count={active.length}>
				{active.length === 0 && <div className="flights-empty">No active Flights</div>}
				{active.map((f) => (
					<Row key={f.id} f={f} state={state} selected={selected === f.id} onSelect={onSelect} onHover={onHover} />
				))}
			</Section>
			{done.length > 0 && (
				<Section title="Landed & closed" count={done.length}>
					{done.map((f) => (
						<Row key={f.id} f={f} state={state} selected={selected === f.id} onSelect={onSelect} onHover={onHover} />
					))}
				</Section>
			)}
			{sequencing.length > 0 && (
				<Section title="Sequencing">
					{sequencing.map((e) => (
						<div key={`${e.from}${e.to}`} className="seq-row">
							<span className="mono">{e.from}</span>
							<span className="muted">
								{e.reason.startsWith("holds") ? "holds for" : e.reason.startsWith("declared") ? "depends on" : "lands after"}
							</span>
							<span className="mono">{e.to}</span>
						</div>
					))}
				</Section>
			)}
		</nav>
	);
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
	return (
		<section className="fl-section">
			<h2 className="eyebrow">
				{title}
				{count !== undefined && <span className="eyebrow-count">{count}</span>}
			</h2>
			{children}
		</section>
	);
}

function Row({
	f,
	state,
	selected,
	onSelect,
	onHover,
}: { f: Flight; state: ControllerState; selected: boolean } & Pick<Props, "onSelect" | "onHover">) {
	const badge = flightBadge(f, state.traffic.clearances[f.id]);
	const mission = missionOf(state, f);
	const sub = f.phase === "landed" ? `landed ${short(f.landedCommit)}` : (f.activity?.text ?? f.phase);
	return (
		<button
			type="button"
			className={`fl-row tone-${badge.tone} ${selected ? "selected" : ""}`}
			onClick={() => onSelect(f.id)}
			onMouseEnter={() => onHover(f.id)}
			onMouseLeave={() => onHover(null)}
		>
			<span className="fl-bar" />
			<span className="fl-main">
				<span className="fl-top">
					<span className="mono fl-id">{f.id}</span>
					<span className={`chip tone-${badge.tone}`}>{badge.label}</span>
				</span>
				<span className="fl-title">{f.title}</span>
				<span className="fl-sub">{sub}</span>
				{mission?.priority && mission.priority !== "normal" && <span className="fl-pri">{mission.priority}</span>}
			</span>
		</button>
	);
}
