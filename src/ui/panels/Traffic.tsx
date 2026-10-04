import { ReactFlowProvider } from "@xyflow/react";
import { useState } from "react";
import type { ControllerState } from "../../core/controller.ts";
import type { GitInfo } from "../../shared/api.ts";
import { Badge, Icon } from "../components.tsx";
import { congestionNeedsDecision, counts, decisionLabel, flightBadge, label, short, taskName } from "../model.ts";
import { Radar, type Selection } from "../radar/Radar.tsx";
import { TowerLog } from "./TowerLog.tsx";

export function Traffic({
	state,
	git,
	selection,
	onSelect,
	onOpen,
}: {
	state: ControllerState;
	git: GitInfo | null;
	selection: Selection;
	onSelect(s: Selection): void;
	onOpen(s: Selection): void;
}) {
	const [hover, setHover] = useState<string | null>(null);
	const c = counts(state);
	const crossing = selection?.kind === "congestion" ? state.traffic.congestions.find((x) => x.key === selection.key) : undefined;
	const flight = selection?.kind === "flight" ? state.flights.find((f) => f.id === selection.id) : undefined;
	return (
		<div className="traffic-page">
			<div className="page-heading">
				<div>
					<div className="page-kicker">{state.project.name.replace(" · live", "")}</div>
					<h1>Traffic</h1>
					<p className="page-description">Where active plans cross.</p>
				</div>
				<span className="traffic-count">
					{c.active} active runs<span className="text-divider">·</span>
					{c.congestion} {c.congestion === 1 ? "overlap" : "overlaps"}
				</span>
			</div>
			<div className="traffic-layout">
				<section className="traffic-canvas" aria-label="Active code and routes">
					<div className="canvas-label">
						<span>Active scope</span>
						<span className="muted">Select a code area to explore</span>
					</div>
					<ReactFlowProvider>
						<Radar state={state} selection={selection} hover={hover} onSelect={onSelect} onHover={setHover} />
					</ReactFlowProvider>
					<div className="graph-legend">
						<span>
							<i className="legend-line" />
							Cleared route
						</span>
						<span>
							<i className="legend-line waiting" />
							Waiting
						</span>
						<span>
							<i className="legend-crossing" />
							Crossing
						</span>
					</div>
				</section>
				<aside className="traffic-inspector" aria-label="Traffic details">
					{selection && (
						<button type="button" className="link small" onClick={() => onSelect(null)}>
							<Icon name="back" size={13} />
							All traffic
						</button>
					)}
					{flight ? (
						<>
							<h2>{flight.title}</h2>
							<Badge badge={flightBadge(flight, state.traffic.clearances[flight.id], state)} />
							<p>{flight.activity?.text ?? "Waiting for the agent’s next update."}</p>
							<button type="button" className="btn" onClick={() => onOpen(selection)}>
								Open task
								<Icon name="arrow" />
							</button>
						</>
					) : crossing ? (
						<>
							<div className="page-kicker">Shared scope</div>
							<h2 className="mono">{crossing.label}</h2>
							<p>
								{congestionNeedsDecision(crossing, state)
									? "Review the unresolved coordination decision."
									: crossing.rightOfWay
										? `${taskName(state, crossing.rightOfWay.winner)} goes first.`
										: decisionLabel(crossing, state)}
							</p>
							<p className="muted">{decisionLabel(crossing, state)}</p>
							<button type="button" className="btn" onClick={() => onOpen(selection)}>
								Why this decision?
								<Icon name="arrow" />
							</button>
						</>
					) : selection?.kind === "resource" ? (
						<>
							<div className="page-kicker">Code area</div>
							<h2 className="mono">{label(selection.id, state.index)}</h2>
							<p>Inspect the tasks and resources in this scope.</p>
							<button type="button" className="btn" onClick={() => onOpen(selection)}>
								Inspect scope
								<Icon name="arrow" />
							</button>
						</>
					) : (
						<>
							<h2>Coordination</h2>
							<p className="muted">{c.attention ? `${c.attention} need your attention.` : "No action needed."}</p>
							{state.traffic.congestions.length ? (
								state.traffic.congestions.map((x) => (
									<button
										type="button"
										className="traffic-crossing"
										key={x.key}
										onClick={() => onSelect({ kind: "congestion", key: x.key })}
									>
										<Icon name="traffic" />
										<span>
											<strong>{x.label || "Shared code"}</strong>
											<span>{decisionLabel(x, state)}</span>
										</span>
										<Icon name="chevron" size={13} />
									</button>
								))
							) : (
								<p>Independent routes are cleared to continue.</p>
							)}
						</>
					)}
				</aside>
			</div>
			<details className="controller-view">
				<summary>
					<Icon name="settings" />
					Controller details<span className="muted">Decisions, dependencies, and infrastructure</span>
				</summary>
				<div className="controller-metadata">
					<span>
						Git backend <strong>{git?.backend ?? "—"}</strong>
					</span>
					<span>
						Canonical <strong className="mono">{short(state.canonical.head)}</strong>
					</span>
					<span>
						Active leases <strong>{state.leases.length}</strong>
					</span>
					<span>
						Namespace <strong className="mono">{git?.namespace ?? "—"}</strong>
					</span>
				</div>
				{state.traffic.edges.length > 0 && (
					<div className="dependency-list">
						<h3>Dependencies</h3>
						{state.traffic.edges.map((e, i) => (
							<p key={String(i)} className="mono">
								{JSON.stringify(e)}
							</p>
						))}
					</div>
				)}
				<TowerLog events={state.log} focusFlight={flight?.id ?? null} onSelectFlight={(id) => onOpen({ kind: "flight", id })} />
			</details>
		</div>
	);
}
