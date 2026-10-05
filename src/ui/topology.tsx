import { useEffect, useRef, useState } from "react";
import type { CoordinationTopology } from "../shared/coordination.ts";
import type { RepositorySnapshot } from "../shared/platform.ts";
import { count, short } from "./controls.tsx";
import { Icon } from "./design.tsx";
import { topologyModel, workingActor } from "./topology-model.ts";

export function MiniTopology({ topology }: { topology?: CoordinationTopology }) {
	if (!topology) return <span className="muted">Activity unavailable</span>;
	const writers = topology.workspaces.filter((w) => w.state === "active");
	const shown = writers.slice(0, 4);
	return (
		<span className="mini-topology" aria-hidden="true">
			<svg viewBox="0 0 112 48" fill="none" aria-hidden="true">
				{shown.map((w, i) => (
					<g key={w.id}>
						<path d={`M8 ${10 + i * 9}H104`} />
						<circle cx="8" cy={10 + i * 9} r="2.5" />
						<circle cx="104" cy={10 + i * 9} r="2.5" />
					</g>
				))}
				{topology.intersections.slice(0, 3).map((o, i) => {
					const indices = shown.flatMap((w, index) => (o.workspaces.includes(w.id) ? [index] : []));
					if (indices.length < 2) return null;
					const top = 10 + Math.min(...indices) * 9,
						bottom = 10 + Math.max(...indices) * 9;
					return <path className="crossing" key={o.id} d={`M${44 + i * 14} ${top - 4}h-4v${bottom - top + 8}h4`} />;
				})}
			</svg>
		</span>
	);
}

function Observation({ at }: { at: number }) {
	const previous = useRef(at),
		[changed, setChanged] = useState(false);
	useEffect(() => {
		if (previous.current === at) return;
		previous.current = at;
		setChanged(true);
		const timer = setTimeout(() => setChanged(false), 700);
		return () => clearTimeout(timer);
	}, [at]);
	return <span className={changed ? "observation new-observation" : "observation"} aria-hidden="true" />;
}

export function Topology({ view, open, all }: { view: RepositorySnapshot; open: (id: string) => void; all: () => void }) {
	const model = topologyModel(view),
		[hover, setHover] = useState<string>(),
		[surface, setSurface] = useState<string>();
	const selected = model.intersections.find((o) => o.id === surface);
	const bracket = selected ?? model.intersections[0];
	const members = model.lanes.flatMap(({ workspace }, i) => (bracket?.workspaces.includes(workspace.id) ? [i] : []));
	return (
		<section className="topology-panel" aria-label="Workspace topology">
			<div className="section-heading">
				<div>
					<p className="eyebrow">Independent paths</p>
					<h2>Work in motion</h2>
				</div>
				<span className="muted">{count(model.total, "writer workspace")}</span>
			</div>
			<div className="canonical-track">
				<span className="track-label">
					Canonical <code>{view.repository.defaultBranch}</code>
				</span>
				<span className="canonical-rule" />
				<code>{model.canonical ? short(model.canonical) : "Unavailable"}</code>
			</div>
			<p className="revision-legend">
				Starting revision <span>Reported head</span>
			</p>
			<div className={`topology-lanes ${members.length > 1 ? "has-intersection" : ""}`}>
				{members.length > 1 && (
					<svg className="relationship-gutter" viewBox={`0 0 24 ${model.lanes.length * 100}`} preserveAspectRatio="none" aria-hidden="true">
						<path d={`M18 ${members[0] * 100 + 48}H6V${members.at(-1)! * 100 + 48}H18`} />
						{members.slice(1, -1).map((i) => (
							<path key={i} d={`M6 ${i * 100 + 48}H18`} />
						))}
					</svg>
				)}
				{model.lanes.map(({ workspace: w, publications, promotions }) => {
					const related = selected?.workspaces.includes(w.id),
						highlighted = hover === w.id || related;
					return (
						<button
							type="button"
							key={w.id}
							className={`topology-lane ${w.state} ${highlighted ? "highlighted" : ""} ${(hover || selected) && !highlighted ? "subdued" : ""}`}
							onMouseEnter={() => setHover(w.id)}
							onMouseLeave={() => setHover(undefined)}
							onFocus={() => setHover(w.id)}
							onBlur={() => setHover(undefined)}
							onClick={() => open(w.id)}
						>
							<span className="lane-heading">
								<span>
									<span className={`presence ${w.state}`} />
									<strong>{workingActor(w).name}</strong>
									<span className="actor-kind">{workingActor(w).kind}</span>
								</span>
								<span className="lane-state">
									<Observation at={w.lastActivity} />
									{w.state}
								</span>
							</span>
							<span className="lane-title">{w.title}</span>
							<span className="revision-path">
								<code title={`Immutable starting revision: ${w.baseRevision}`}>{short(w.baseRevision)}</code>
								<span className="revision-rule" aria-hidden="true" />
								<code title={`Reported head: ${w.headRevision}`}>{short(w.headRevision)}</code>
							</span>
							<span className="lane-meta">
								<code>{w.branch ?? "No ref"}</code>
								<span>
									{count(w.changes.length, "file")} · {count(w.commits.length, "reported commit")}
								</span>
							</span>
							{publications.length > 0 && (
								<span className="publication-marker">
									Retained source <code>{short(publications.at(-1)?.revision)}</code>
								</span>
							)}
							{promotions.map((p) => (
								<span className="promotion-link" key={p.id}>
									↳ Promoted to canonical{" "}
									<code>
										{short(p.from)} → {short(p.to)}
									</code>
								</span>
							))}
						</button>
					);
				})}
				{!model.total && <p className="empty">No active workspaces. Attach a local checkout to begin reporting work.</p>}
			</div>
			<div className="surface-section">
				<div className="section-heading">
					<h3>Shared surfaces</h3>
					<span className="muted">{count(model.intersections.length, "reported intersection")}</span>
				</div>
				{model.intersections.length ? (
					model.intersections.map((o) => (
						<button
							type="button"
							className={`surface-button ${selected?.id === o.id ? "selected" : ""} ${hover && o.workspaces.includes(hover) ? "highlighted" : ""}`}
							key={o.id}
							aria-expanded={selected?.id === o.id}
							onClick={() => setSurface(surface === o.id ? undefined : o.id)}
						>
							<span className="intersection-symbol" aria-hidden="true">
								⊏
							</span>
							<code>{o.surface}</code>
							<span>{count(o.workspaces.length, "workspace")}</span>
							<Icon name="chevron" />
						</button>
					))
				) : (
					<p className="muted">No shared paths reported. This does not establish semantic compatibility.</p>
				)}
				{selected && (
					<div className="surface-detail">
						<strong>Reported overlap · {selected.surface}</strong>
						{selected.workspaces.map((id) => (
							<button type="button" key={id} onClick={() => open(id)}>
								{view.workspaces.find((w) => w.id === id)?.title ?? id}
								<Icon name="arrow" />
							</button>
						))}
					</div>
				)}
				<p className="surface-note">Overlap is awareness, not a Git conflict.</p>
			</div>
			<button type="button" className="text-button topology-all" onClick={all}>
				View all work{model.total > 6 ? ` · ${model.total - 6} more writers` : ""}
				<Icon name="arrow" />
			</button>
		</section>
	);
}
