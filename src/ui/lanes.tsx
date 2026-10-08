import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import type { RepositorySummary } from "../shared/coordination.ts";
import type { RepositorySnapshot, Workspace } from "../shared/platform.ts";
import {
	type Lane,
	type LaneHistory,
	laneHistory,
	lanes as laneModel,
	repositoryAxis,
	type TimeAxis,
	type TrunkNode,
	trunk as trunkModel,
} from "./lanes.ts";
import { ownerName, type People, short } from "./status.ts";

/** A workspace's colour running down the left of its row, like a branch in `git log --graph`. Decorative: the row says everything in text. */
export function LaneTrack({ lane, done, quiet }: { lane?: number; done?: boolean; quiet?: boolean }) {
	return <span className={`lane-track lane-${lane ?? 1}${done ? " done" : ""}${quiet ? " quiet" : ""}`} aria-hidden="true" />;
}
export function LaneBullet({ lane }: { lane?: number }) {
	return (
		<span className={`lane-bullet lane-${lane ?? 1}`} aria-hidden="true">
			{lane ?? ""}
		</span>
	);
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const MAX_LANES = 12;
/** Return rails beyond this many promoted lanes keep the filled capsule without a drawn return. */
const MAX_RETURNS = 6;
/** A full replay of recorded history takes this long at normal speed. */
const REPLAY_SECONDS = 16;
const W = 1120,
	STATUS_X = W - 262,
	GX0 = 228,
	GX1 = STATUS_X - 78,
	TY = 74;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
/** Clock time for today, day and month otherwise; the axis labels recorded moments, not durations. */
function clock(at: number, now: number) {
	const d = new Date(at);
	return d.toDateString() === new Date(now).toDateString()
		? `${pad(d.getHours())}:${pad(d.getMinutes())}`
		: `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
const span = (ms: number) => (ms < 48 * 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} d`);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const cubic = (p: number[][], t: number) => {
	const u = 1 - t;
	return [0, 1].map((i) => u * u * u * p[0][i] + 3 * u * u * t * p[1][i] + 3 * u * t * t * p[2][i] + t * t * t * p[3][i]);
};
const tone = (key: string) =>
	["behind", "diverged", "reconciliation", "preparation"].includes(key)
		? "var(--tone-warning)"
		: ["current", "ahead", "contained", "promote", "promoted"].includes(key)
			? "var(--tone-success)"
			: key === "review"
				? "var(--tone-accent)"
				: key === "recovery" || key === "promoting"
					? "var(--tone-danger)"
					: "var(--text-muted)";

/**
 * Canonical drawn as a trunk of recorded promotions and each live workspace as a lane leaving it at its fixed baseline,
 * on a compressed axis of recorded time (see `timeAxis`). Lanes reach now while their workspace exists. Replay redraws
 * the same records up to an earlier moment; presence, relation and overlaps are current facts and show only live.
 * A baseline that is not a recorded canonical revision gets a dashed, unattached lane rather than a guessed junction.
 */
export function LaneMap({
	view,
	focus,
	setFocus,
	open,
	who,
}: {
	view: RepositorySnapshot;
	focus?: string;
	setFocus: (id?: string) => void;
	open: (id: string) => void;
	who?: People;
}) {
	const [showDetached, setShowDetached] = useState(false);
	const [showSettled, setShowSettled] = useState(false);
	const [page, setPage] = useState(0);
	const [paused, setPaused] = useState(false);
	const [visible, setVisible] = useState(false);
	const [documentVisible, setDocumentVisible] = useState(!document.hidden);
	const [replay, setReplay] = useState<{ pos: number; playing: boolean }>();
	const mapRef = useRef<HTMLElement>(null);
	const previous = useRef(new Map<string, { head: string; published?: string }>());
	const [updates, setUpdates] = useState(new Map<string, string>());
	useEffect(() => {
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
		if (mapRef.current) observer.observe(mapRef.current);
		const onVisibility = () => setDocumentVisible(!document.hidden);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);
	useEffect(() => {
		const changed = new Map<string, string>();
		for (const w of view.workspaces) {
			const old = previous.current.get(w.id);
			if (old && old.head !== w.headRevision) changed.set(w.id, "head");
			else if (old && old.published !== w.publishedRevision && w.publishedRevision) changed.set(w.id, "published");
		}
		previous.current = new Map(view.workspaces.map((w) => [w.id, { head: w.headRevision, published: w.publishedRevision }]));
		if (!changed.size) return;
		setUpdates(changed);
		const timer = setTimeout(() => setUpdates(new Map()), 4200);
		return () => clearTimeout(timer);
	}, [view.workspaces]);
	const running = !!replay?.playing && visible && documentVisible;
	useEffect(() => {
		if (!running) return;
		let frame = 0,
			last = performance.now();
		const tick = (now: number) => {
			const dt = Math.min(0.1, (now - last) / 1000);
			last = now;
			// Playback holds briefly on the last recorded moment, then returns to live.
			setReplay((r) => (r?.playing ? (r.pos >= 1.06 ? undefined : { ...r, pos: r.pos + dt / REPLAY_SECONDS }) : r));
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [running]);
	const nodes = trunkModel(view),
		// The lane's person is its accountable owner; tool provenance stays in the workspace rows and details.
		all = laneModel(view).map((lane) => (who ? { ...lane, worked: `Owner: ${ownerName(lane.ownerId, who)}` } : lane));
	if (!all.length) return null;
	const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const now = view.asOf ?? Date.now();
	const histories = new Map(
		all.map((lane) => {
			const w = view.workspaces.find((x) => x.id === lane.id) as Workspace;
			return [lane.id, laneHistory(view, w)];
		}),
	);
	const axis = repositoryAxis(view, [...histories.values()], now);
	const replaying = replay !== undefined,
		limit = replaying ? clamp01(replay.pos) : 1,
		X = (pos: number) => GX0 + pos * (GX1 - GX0),
		nowX = X(limit);
	const detached = all.filter((lane) => lane.detached);
	// Work already in canonical has nothing left to decide; it folds into one pill on main until asked for. Replay keeps
	// it, because its promotion is part of the history being replayed.
	const settled = all.filter((lane) => lane.settled);
	const eligible = all
		.filter((lane) => (showDetached || !lane.detached) && (replaying || showSettled || !lane.settled))
		.toSorted((a, b) => Number(a.detached) - Number(b.detached));
	const pages = Math.max(1, Math.ceil(eligible.length / MAX_LANES));
	const currentPage = Math.min(page, pages - 1);
	const shown = eligible.slice(currentPage * MAX_LANES, (currentPage + 1) * MAX_LANES);
	const top = 166,
		gap = shown.length > 5 ? 74 : 84,
		overlaps = replaying ? [] : view.overlaps.slice(0, 4),
		H = Math.max(200, top + shown.length * gap - 18);
	const nodePos = (node: TrunkNode) => axis.slot(`main:${node.revision}`) ?? 0;
	const visibleNodes = nodes.filter((node) => nodePos(node) <= limit);
	const mainHead = visibleNodes[visibleNodes.length - 1];
	const rowY = new Map(shown.map((lane, i) => [lane.id, top + i * gap]));
	const returning = new Set(
		shown
			.filter((lane) => lane.change?.status.key === "promoted" || replaying)
			.filter((lane) => histories.get(lane.id)?.change?.promotion)
			.slice(0, MAX_RETURNS)
			.map((lane) => lane.id),
	);
	// Recorded promotions on main after a lane's baseline, up to the moment shown.
	const drift = (lane: Lane) =>
		lane.baseline === undefined ? undefined : nodes.slice(lane.baseline + 1).filter((n) => n.promotion && nodePos(n) <= limit).length;
	const focused = shown.find((lane) => lane.id === focus);
	const relationCounts = {
		current: all.filter((l) => ["current", "ahead", "contained"].includes(l.relation.key)).length,
		behind: all.filter((l) => ["behind", "diverged"].includes(l.relation.key)).length,
		unknown: all.filter((l) => !["current", "ahead", "contained", "behind", "diverged"].includes(l.relation.key)).length,
	};
	const caption = [
		`${all.length} live ${all.length === 1 ? "workspace" : "workspaces"} from ${view.repository.defaultBranch}`,
		[
			relationCounts.current && `${relationCounts.current} up to date or ahead`,
			relationCounts.behind && `${relationCounts.behind} behind or diverged`,
			relationCounts.unknown && `${relationCounts.unknown} with unknown ancestry`,
		]
			.filter(Boolean)
			.join(", "),
	].join(": ");
	const promoted = all.filter((l) => l.change?.status.key === "promoted").length;
	const notProposed = all.filter((l) => l.published && !l.change && ["ahead", "diverged"].includes(l.relation.key)).length;
	// Axis labels: recorded moments, spaced so none collide, never under the now label.
	const ticks: { x: number; at: number }[] = [];
	for (const tick of axis.ticks) {
		const x = X(tick.pos);
		const last = ticks[ticks.length - 1];
		if (Math.abs(x - nowX) > 56 && (!last || (x - last.x > 72 && clock(tick.at, now) !== clock(last.at, now))))
			ticks.push({ x, at: tick.at });
	}
	const marks = all
		.filter((lane) => !lane.detached)
		.flatMap((lane) => {
			const h = histories.get(lane.id) as LaneHistory;
			const rev = (revision: string, at: number) => axis.slot(`rev:${lane.id}:${revision}`) ?? axis.at(at);
			return [
				...h.revisions.map((r) => ({ kind: "commit", pos: rev(r.revision, r.at), lane: lane.lane })),
				...h.publications.map((p) => ({ kind: "publish", pos: Math.max(axis.at(p.at), rev(p.revision, p.at)), lane: lane.lane })),
				...(h.change
					? [{ kind: "change", pos: Math.max(axis.at(h.change.at), rev(h.change.revision, h.change.at)), lane: lane.lane }]
					: []),
				...(h.change?.promotion
					? [{ kind: "promote", pos: axis.slot(`main:${h.change.promotion.to}`) ?? axis.at(h.change.promotion.at), lane: lane.lane }]
					: []),
			];
		});
	return (
		<figure
			ref={mapRef}
			className="lane-map"
			data-focus={focus || undefined}
			data-motion={paused || !visible || !documentVisible ? "paused" : "playing"}
			data-replay={replaying || undefined}
		>
			<div className="lane-map-head">
				<h2>Lane map</h2>
				<ul className="lane-legend" aria-hidden="true">
					<li>
						<svg width="12" height="12" aria-hidden="true">
							<circle cx="6" cy="6" r="4" fill="currentColor" />
						</svg>
						reported revision
					</li>
					<li>
						<svg width="14" height="14" aria-hidden="true">
							<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
							<circle cx="7" cy="7" r="2.5" fill="currentColor" />
						</svg>
						published
					</li>
					<li>
						<svg width="20" height="12" aria-hidden="true">
							<rect x="1" y="1.5" width="18" height="9" rx="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
						</svg>
						change
					</li>
					<li>
						<svg width="20" height="8" aria-hidden="true">
							<path d="M1 4h18" stroke="currentColor" strokeWidth="2" strokeDasharray="1 4" strokeLinecap="round" />
						</svg>
						not reporting or unplaced
					</li>
					<li>
						<svg width="22" height="12" aria-hidden="true">
							<path d="M1 10h8q6 0 6-6h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
						</svg>
						promoted, rejoined main
					</li>
					<li className="shared">
						<svg width="10" height="12" aria-hidden="true">
							<path d="M1 1h7v10H1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
						</svg>
						shared path, advisory
					</li>
				</ul>
			</div>
			<div className="lane-map-controls">
				<div className="lane-presence">
					<span className={`connection-dot${all.some((lane) => !lane.quiet) ? "" : " quiet"}`} aria-hidden="true" />
					{all.filter((lane) => !lane.quiet).length} connected{" "}
					<span className="muted">· the tip breathes for presence, dots are revisions</span>
				</div>
				<div className="lane-map-actions">
					{settled.length > 0 && !replaying && (
						<button
							type="button"
							aria-expanded={showSettled}
							onClick={() => {
								setShowSettled(!showSettled);
								setPage(0);
							}}
						>
							{showSettled ? "Fold" : "Show"} {settled.length} already in {view.repository.defaultBranch}
						</button>
					)}
					{detached.length > 0 && (
						<button
							type="button"
							aria-expanded={showDetached}
							onClick={() => {
								setShowDetached(!showDetached);
								setPage(0);
							}}
						>
							{showDetached ? "Hide" : "Show"} {detached.length} detached
						</button>
					)}
					<button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>
						{paused ? "Resume motion" : "Pause motion"}
					</button>
				</div>
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded scroll region must support keyboard scrolling. */}
			<section className="lane-canvas" tabIndex={0} aria-label="Workspace lane map, scroll to inspect lanes">
				<svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" onMouseLeave={() => setFocus(undefined)}>
					{ticks.map((tick) => (
						<g key={tick.at}>
							<line x1={tick.x} y1={36} x2={tick.x} y2={H - 8} stroke="var(--border)" strokeDasharray="1 6" strokeLinecap="round" />
							<text x={tick.x} y={24} textAnchor="middle" fontSize="10.5" fill="var(--text-faint)">
								{clock(tick.at, now)}
							</text>
						</g>
					))}
					<line className="lane-now-line" x1={nowX} y1={32} x2={nowX} y2={H - 8} />
					<g className="lane-now" transform={`translate(${nowX} 20)`}>
						<rect x={replaying ? -30 : -18} y={-9} width={replaying ? 60 : 36} height={18} rx={9} />
						<text y={4} textAnchor="middle" fontSize="11">
							{replaying ? clock(axis.time(limit), now) : "now"}
						</text>
					</g>
					<text x={STATUS_X} y={24} fontSize="10.5" fill="var(--text-faint)">
						status
					</text>
					{!shown.length && (
						<text x="32" y="140" fontSize="13" fill="var(--text-muted)">
							Every workspace is folded away. Show them to inspect their revisions.
						</text>
					)}
					{focused?.baseline !== undefined && mainHead && (
						<DriftBand lane={focused} from={X(nodePos(nodes[focused.baseline]))} to={X(nodePos(mainHead))} count={drift(focused) ?? 0} />
					)}
					{shown.map((lane) => (
						<LanePath
							key={lane.id}
							lane={lane}
							hist={histories.get(lane.id) as LaneHistory}
							axis={axis}
							X={X}
							limit={limit}
							replaying={replaying}
							reduce={reduce}
							update={replaying ? undefined : updates.get(lane.id)}
							y={rowY.get(lane.id) ?? top}
							bx={lane.baseline === undefined ? undefined : X(nodePos(nodes[lane.baseline]))}
							gap={gap}
							drift={drift(lane)}
							returns={returning.has(lane.id)}
							stagger={[...returning].indexOf(lane.id)}
							focused={focus === lane.id}
							setFocus={setFocus}
							open={open}
						/>
					))}
					<path
						d={`M84 ${TY} H${GX0}`}
						stroke="var(--canonical)"
						strokeOpacity="0.35"
						strokeWidth="2"
						strokeDasharray="1 5"
						strokeLinecap="round"
					/>
					<path d={`M${GX0} ${TY} H${nowX}`} stroke="var(--surface)" strokeWidth="9" strokeLinecap="round" />
					<path d={`M${GX0} ${TY} H${nowX}`} stroke="var(--canonical)" strokeWidth="3.2" strokeLinecap="round" />
					{axis.breaks
						.filter((b) => b.pos <= limit)
						.map((b) => {
							const x = X(b.pos);
							return (
								<g key={b.pos} className="lane-break">
									<rect x={x - 6} y={TY - 6} width={12} height={12} fill="var(--surface)" />
									<path
										d={`M${x - 6} ${TY + 7} L${x - 2} ${TY - 7} M${x + 2} ${TY + 7} L${x + 6} ${TY - 7}`}
										stroke="var(--text-faint)"
										strokeWidth="1.5"
									/>
									<text x={x} y={TY + 22} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
										{span(b.gap)}
									</text>
								</g>
							);
						})}
					<g transform={`translate(18 ${TY - 12})`}>
						<rect width="58" height="24" rx="12" fill="var(--canonical)" />
						<text x="29" y="16" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--on-canonical)">
							{clip(view.repository.defaultBranch, 7)}
						</text>
					</g>
					{visibleNodes.map((node, i) => {
						const x = X(nodePos(node)),
							head = node === mainHead,
							// Right to left, the newest revision keeps its label when two would collide.
							labelled = visibleNodes.slice(i + 1).every((later) => X(nodePos(later)) - x > 62),
							age = replaying && !reduce && node.promotion ? clamp01((limit - nodePos(node)) / 0.05) : 1;
						return (
							<g key={node.revision}>
								{age < 1 && (
									<circle
										cx={x}
										cy={TY}
										r={8 + 220 * age}
										fill="none"
										stroke={node.lane ? `var(--lane-${node.lane})` : "var(--canonical)"}
										strokeOpacity={0.4 * (1 - age)}
										strokeWidth="1.2"
									/>
								)}
								{head && <circle cx={x} cy={TY} r="9.5" fill="none" stroke="var(--canonical)" strokeOpacity="0.35" strokeWidth="1.5" />}
								<circle cx={x} cy={TY} r="7.5" fill="var(--surface)" />
								<circle cx={x} cy={TY} r="5" fill={node.lane ? `var(--lane-${node.lane})` : "var(--canonical)"} />
								{labelled && (
									<>
										<text
											x={x}
											y={TY - 16}
											textAnchor="middle"
											fontSize="10.5"
											fontWeight={head ? 700 : 400}
											fill={head ? "var(--text)" : "var(--text-muted)"}
										>
											{short(node.revision)}
										</text>
										{node.change && (
											<text x={x} y={TY - 31} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={`var(--lane-${node.lane ?? 1})`}>
												#{node.change}
											</text>
										)}
									</>
								)}
							</g>
						);
					})}
					{settled.length > 0 && !showSettled && !replaying && (
						// biome-ignore lint/a11y/noStaticElementInteractions: decorative shortcut; the "Show … already in" button is the accessible control.
						<g
							className="lane-fold"
							style={{ cursor: "pointer" }}
							onClick={() => setShowSettled(true)}
							onMouseEnter={() => setFocus(undefined)}
						>
							<title>{`${settled.length} already in ${view.repository.defaultBranch}: ${settled.map((lane) => lane.title).join(", ")}`}</title>
							<path d={`M${nowX} ${TY} H${nowX + 22}`} stroke="var(--canonical)" strokeWidth="3.2" strokeLinecap="round" />
							<rect
								x={nowX + 18}
								y={TY - 12}
								width={26 + Math.min(settled.length, 6) * 13 + `${settled.length} merged`.length * 6.6}
								height="24"
								rx="12"
								fill="var(--surface)"
								stroke="var(--canonical)"
								strokeWidth="1.5"
							/>
							{settled.slice(0, 6).map((lane, i) => (
								<circle
									key={lane.id}
									className="lane-fold-bead"
									style={{ "--i": i } as CSSProperties}
									cx={nowX + 34 + i * 13}
									cy={TY}
									r="4.5"
									fill={`var(--lane-${lane.lane})`}
								/>
							))}
							<text x={nowX + 30 + Math.min(settled.length, 6) * 13} y={TY + 4} fontSize="11" fontWeight="600" fill="var(--text)">
								{settled.length} merged
							</text>
						</g>
					)}
					{overlaps.map((overlap, k) => {
						const ys = overlap.workspaces.map((id) => rowY.get(id)).filter((y): y is number => y !== undefined);
						if (ys.length < 2) return null;
						const x = nowX + 24 + k * 11,
							y1 = Math.min(...ys),
							y2 = Math.max(...ys);
						return (
							<g key={overlap.id}>
								<path
									d={`M${nowX + 10} ${y1} H${x} V${y2} H${nowX + 10}`}
									fill="none"
									stroke="var(--tone-warning)"
									strokeWidth="1.3"
									strokeLinejoin="round"
									strokeDasharray="3 3.5"
								/>
								{ys
									.filter((y) => y !== y1 && y !== y2)
									.map((y) => (
										<path key={y} d={`M${nowX + 10} ${y} H${x}`} stroke="var(--tone-warning)" strokeWidth="1.3" strokeDasharray="3 3.5" />
									))}
							</g>
						);
					})}
				</svg>
			</section>
			<div className="lane-replay">
				<button
					type="button"
					onClick={() => setReplay(replay ? { ...replay, playing: !replay.playing || replay.pos >= 1 } : { pos: 0, playing: true })}
				>
					{replay?.playing ? "Pause replay" : replaying ? "Play replay" : "Replay history"}
				</button>
				<div className="lane-replay-track">
					<span className="lane-replay-fill" style={{ width: `${limit * 100}%` }} />
					{marks.map((mark, i) => (
						<i
							// biome-ignore lint/suspicious/noArrayIndexKey: marks are positional and rebuilt from the same records every render.
							key={i}
							className={`lane-replay-mark ${mark.kind}`}
							style={{ left: `${mark.pos * 100}%`, "--lane": `var(--lane-${mark.lane})` } as CSSProperties}
						/>
					))}
					<span className="lane-replay-thumb" style={{ left: `${limit * 100}%` }} />
					<input
						type="range"
						min={0}
						max={1000}
						value={Math.round(limit * 1000)}
						aria-label="Replay position"
						aria-valuetext={replaying ? clock(axis.time(limit), now) : "Live"}
						onChange={(e) => {
							const pos = e.currentTarget.valueAsNumber / 1000;
							setReplay(pos >= 1 ? undefined : { pos, playing: false });
						}}
					/>
				</div>
				<span className="lane-replay-time">{replaying ? clock(axis.time(limit), now) : "live"}</span>
				{replaying && (
					<button type="button" onClick={() => setReplay(undefined)}>
						Back to live
					</button>
				)}
			</div>
			{pages > 1 && (
				<nav className="lane-pagination" aria-label="Lane map pages">
					<button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
						Previous lanes
					</button>
					<span>
						{currentPage * MAX_LANES + 1}–{Math.min((currentPage + 1) * MAX_LANES, eligible.length)} of {eligible.length}
					</span>
					<button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>
						Next lanes
					</button>
				</nav>
			)}
			<figcaption>
				{replaying ? (
					`Replaying recorded events at ${clock(axis.time(limit), now)}. Presence, relation and shared paths are current facts, so they show only live.`
				) : (
					<>
						{caption}.{notProposed > 0 && ` ${notProposed} published, not yet proposed for review.`}
						{settled.length > 0 &&
							!showSettled &&
							` ${settled.length} already in ${view.repository.defaultBranch} ${settled.length === 1 ? "is" : "are"} folded into the main line${settled.some((lane) => lane.settled === "other") ? " (some arrived through another workspace's promotion)" : ""}.`}
						{promoted > 0 && showSettled && ` ${promoted} promoted into ${view.repository.defaultBranch} by a recorded human approval.`}
						{view.overlaps.length > 0 &&
							` Shared ${view.overlaps.length === 1 ? "path" : "paths"}: ${view.overlaps
								.slice(0, 3)
								.map((o) => o.surface)
								.join(", ")}${view.overlaps.length > 3 ? " and more" : ""}. A heads-up, not a conflict.`}
						{!showDetached &&
							detached.length > 0 &&
							` ${detached.length} detached ${detached.length === 1 ? "workspace is" : "workspaces are"} folded away.`}
					</>
				)}
			</figcaption>
		</figure>
	);
}

/** The focused lane's view of main: how far it has moved since that lane's baseline. */
function DriftBand({ lane, from, to, count }: { lane: Lane; from: number; to: number; count: number }) {
	const colour = `var(--lane-${lane.lane})`,
		label = count ? `main moved ${count} since baseline` : "baseline is main's head",
		x = count ? (from + to) / 2 : from,
		w = label.length * 6.4 + 16;
	return (
		<g className="lane-drift">
			{count > 0 && <path d={`M${from} ${TY} H${to}`} stroke={colour} strokeOpacity="0.3" strokeWidth="11" strokeLinecap="round" />}
			<circle cx={from} cy={TY} r="10" fill="none" stroke={colour} strokeWidth="1.5" />
			<rect x={x - w / 2} y={TY + 15} width={w} height={18} rx={9} fill="var(--surface)" stroke={colour} strokeOpacity="0.5" />
			<text className="lane-title" x={x} y={TY + 28} textAnchor="middle" fontSize="11" fontWeight="500" fill={colour}>
				{label}
			</text>
		</g>
	);
}

function LanePath({
	lane,
	hist,
	axis,
	X,
	limit,
	replaying,
	reduce,
	update,
	y,
	bx,
	gap,
	drift,
	returns,
	stagger,
	focused,
	setFocus,
	open,
}: {
	lane: Lane;
	hist: LaneHistory;
	axis: TimeAxis;
	X: (pos: number) => number;
	/** Position of the moment drawn: 1 is now, less while replaying. */
	limit: number;
	replaying: boolean;
	reduce: boolean;
	update?: string;
	y: number;
	/** Baseline junction on main; undefined when the baseline is not a recorded canonical revision. */
	bx?: number;
	gap: number;
	drift?: number;
	/** Draw the recorded promotion as a return into main. */
	returns: boolean;
	stagger: number;
	focused: boolean;
	setFocus: (id?: string) => void;
	open: (id: string) => void;
}) {
	const colour = `var(--lane-${lane.lane})`,
		placed = bx !== undefined,
		startPos = axis.slot(`start:${lane.id}`) ?? 0,
		xs = Math.max(X(startPos), placed ? bx + 26 : GX0 + 8),
		tipX = Math.max(xs, X(limit)),
		// Replay only: how far a mark that just appeared has settled, from 0 to 1.
		fresh = (pos: number) => (replaying && !reduce ? clamp01((limit - pos) / 0.03) : 1),
		posOf = (x: number) => (x - GX0) / (GX1 - GX0);
	const revs = hist.revisions
		.map((r) => ({ ...r, pos: axis.slot(`rev:${lane.id}:${r.revision}`) ?? axis.at(r.at) }))
		.filter((r) => r.pos <= limit);
	const head = revs[revs.length - 1];
	const revPos = (revision?: string) => revs.find((r) => r.revision === revision)?.pos;
	const pub = replaying
		? hist.publications
				.map((p) => ({ revision: p.revision, pos: Math.max(axis.at(p.at), revPos(p.revision) ?? 0) }))
				.filter((p) => p.pos <= limit && revPos(p.revision) !== undefined)
				.at(-1)
		: lane.published
			? { revision: lane.published, pos: revPos(lane.published) ?? head?.pos ?? startPos }
			: undefined;
	const ch = hist.change,
		chPos = ch && Math.max(axis.at(ch.at), revPos(ch.revision) ?? 0),
		showChange = ch && chPos !== undefined && (replaying ? chPos <= limit : !!lane.change),
		approved = !!ch?.approvedAt && chPos !== undefined && Math.max(axis.at(ch.approvedAt), chPos) <= limit,
		promoPos = ch?.promotion && (axis.slot(`main:${ch.promotion.to}`) ?? axis.at(ch.promotion.at)),
		promoted = replaying ? promoPos !== undefined && promoPos <= limit : lane.change?.status.key === "promoted";
	const started = limit >= startPos;
	const quiet = !replaying && lane.quiet && !lane.detached,
		dashed = !placed || lane.detached || lane.relation.key === "unknown",
		seenX = Math.min(tipX, Math.max(xs, X(axis.at(hist.lastSeen)))),
		grow = replaying && !reduce ? clamp01((limit - startPos) / 0.025) : 1;
	const fork = placed ? `M${bx} ${TY} C${bx} ${TY + (y - TY) * 0.62} ${bx + (xs - bx) * 0.3} ${y} ${xs} ${y}` : "";
	let back = "",
		backProgress = 1,
		backTip: number[] | undefined,
		px = 0;
	if (returns && promoPos !== undefined) {
		px = X(promoPos);
		const x0 = Math.max(xs + 10, px - 64),
			points = [
				[x0, y],
				[x0 + (px - x0) * 0.7, y],
				[px, y - (y - TY) * 0.5],
				[px, TY],
			];
		back = `M${x0} ${y} C${points[1][0]} ${y} ${px} ${points[2][1]} ${px} ${TY}`;
		if (replaying) {
			backProgress = promoPos > posOf(x0) ? clamp01((limit - posOf(x0)) / (promoPos - posOf(x0))) : limit >= promoPos ? 1 : 0;
			if (backProgress > 0 && backProgress < 1 && !reduce) backTip = cubic(points, backProgress);
		}
	}
	const lineA = { line: 1, y: y - 17 },
		lineB = { line: 2, y: y },
		statusTone = lane.change ? tone(lane.change.status.key) : "var(--text-muted)";
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the drawing is aria-hidden; each lane's row below is the accessible control.
		<g
			className={`lane${focused ? " is-focus" : ""}`}
			data-workspace={lane.id}
			data-presence={lane.presence}
			onMouseEnter={() => setFocus(lane.id)}
			onClick={() => open(lane.id)}
		>
			<title>{lane.title}</title>
			<rect x={0} y={y - gap / 2} width={W} height={gap} fill="transparent" />
			<g opacity={started ? 1 : 0.35}>
				<circle cx={28} cy={y} r="9.5" fill={colour} />
				<text x={28} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--on-lane)">
					{lane.lane}
				</text>
				<text className="lane-title" x={46} y={y - 4} fontSize="13" fontWeight="600" fill="var(--text)">
					{clip(lane.title, 24)}
					<tspan x={46} dy="16" fontSize="10.5" fontWeight="400" fill="var(--text-muted)">
						{clip(lane.worked, 28)}
					</tspan>
				</text>
			</g>
			{started && (
				<>
					{placed && (
						<>
							<path
								d={fork}
								fill="none"
								stroke="var(--surface)"
								strokeWidth="7"
								pathLength={1}
								strokeDasharray="1"
								strokeDashoffset={1 - grow}
							/>
							<path
								d={fork}
								fill="none"
								stroke={colour}
								strokeWidth="2.5"
								strokeLinecap="round"
								strokeDasharray={dashed ? undefined : "1"}
								pathLength={dashed ? undefined : 1}
								strokeDashoffset={dashed ? undefined : 1 - grow}
							/>
						</>
					)}
					{!placed && (
						<>
							<circle cx={xs} cy={y} r="10" fill="var(--surface)" stroke={colour} strokeWidth="1.5" strokeDasharray="3 3" />
							<text x={xs} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill={colour}>
								?
							</text>
							<text x={xs} y={y + 28} textAnchor="middle" fontSize="10.5" fill="var(--text-muted)">
								{short(lane.baseRevision)}
							</text>
						</>
					)}
					{grow === 1 &&
						(dashed ? (
							<path
								d={`M${xs + (placed ? 0 : 12)} ${y} H${tipX}`}
								stroke={colour}
								strokeWidth="2.5"
								strokeDasharray="1 6"
								strokeLinecap="round"
							/>
						) : quiet ? (
							<>
								<path d={`M${xs} ${y} H${seenX}`} stroke={colour} strokeWidth="2.5" strokeLinecap="round" />
								<path d={`M${seenX} ${y} H${tipX}`} stroke={colour} strokeWidth="2.5" strokeDasharray="1.5 6" strokeLinecap="round" />
							</>
						) : (
							<path d={`M${xs} ${y} H${tipX}`} stroke={colour} strokeWidth="2.5" strokeLinecap="round" />
						))}
					{back &&
						(replaying ? (
							backProgress > 0 && (
								<>
									<path
										d={back}
										fill="none"
										stroke="var(--surface)"
										strokeWidth="7"
										pathLength={1}
										strokeDasharray="1"
										strokeDashoffset={1 - backProgress}
									/>
									<path
										d={back}
										fill="none"
										stroke={colour}
										strokeWidth="2.5"
										strokeLinecap="round"
										pathLength={1}
										strokeDasharray="1"
										strokeDashoffset={1 - backProgress}
									/>
									{backTip && (
										<circle className="lane-spark" cx={backTip[0]} cy={backTip[1]} r="3.5" fill={colour} style={{ color: colour }} />
									)}
								</>
							)
						) : (
							<>
								{/* The recorded promotion: the lane curves up into main at the moment it was promoted. */}
								<path
									className="lane-return-halo"
									style={{ "--k": stagger } as CSSProperties}
									pathLength={1}
									d={back}
									fill="none"
									stroke="var(--surface)"
									strokeWidth="7"
									strokeLinecap="round"
								/>
								<path
									className="lane-return"
									style={{ "--k": stagger } as CSSProperties}
									pathLength={1}
									d={back}
									fill="none"
									stroke={colour}
									strokeWidth="2.5"
									strokeLinecap="round"
								/>
								{/* Presentation only: a spark travels the recorded return and the junction rings; neither implies anything new has merged. */}
								<g className="lane-return-motion" style={{ "--k": stagger } as CSSProperties}>
									<circle className="lane-return-ripple" cx={px} cy={TY} r="6" fill="none" stroke={colour} strokeWidth="1.5" />
									<circle className="lane-return-spark" cx="0" cy="0" r="3.5" fill={colour} style={{ offsetPath: `path("${back}")` }} />
								</g>
							</>
						))}
					{revs.map((r) => {
						const x = X(r.pos),
							isHead = r === head,
							f = fresh(r.pos);
						return (
							<g key={r.revision}>
								{f < 1 && (
									<circle cx={x} cy={y} r={6 + 16 * f} fill="none" stroke={colour} strokeOpacity={0.6 * (1 - f)} strokeWidth="1.5" />
								)}
								{isHead && pub?.revision !== r.revision && (
									<circle cx={x} cy={y} r="10" fill="none" stroke={colour} strokeOpacity="0.35" strokeWidth="1.5" />
								)}
								<circle cx={x} cy={y} r={isHead ? 7.5 : 5.5} fill="var(--surface)" />
								<circle cx={x} cy={y} r={(isHead ? 5.5 : 3.5) * (0.3 + 0.7 * f)} fill={colour} />
							</g>
						);
					})}
					{pub && (
						<circle
							key={pub.revision}
							className={update === "published" ? "lane-publication-flash" : undefined}
							cx={X(revPos(pub.revision) ?? pub.pos)}
							cy={y}
							r={11.5 + 12 * (1 - fresh(pub.pos))}
							opacity={fresh(pub.pos)}
							fill="none"
							stroke={colour}
							strokeWidth="1.6"
						/>
					)}
					{head && (
						<>
							<text className="lane-label" x={X(head.pos)} y={y + 24} textAnchor="middle" fontSize="11" fill="var(--text)">
								{short(head.revision)}
							</text>
							{!replaying && (
								<text className="lane-label" x={X(head.pos)} y={y + 38} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
									{lane.commits} {lane.commits === 1 ? "commit" : "commits"}
								</text>
							)}
						</>
					)}
					{update === "head" && head && (
						<circle key={lane.head} className="lane-revision-arrival" cx={X(head.pos)} cy={y} r="5" fill={colour}>
							<title>New reported revision</title>
						</circle>
					)}
					{showChange && ch && chPos !== undefined && (
						<g
							transform={`translate(${X(revPos(ch.revision) ?? chPos)} ${y - 27}) scale(${0.6 + 0.4 * fresh(chPos)})`}
							opacity={fresh(chPos)}
						>
							<path d="M0 9 V17" stroke={colour} strokeWidth="1.2" />
							<rect
								x={-(18 + `${approved && !promoted ? "✓ " : ""}#${ch.number}`.length * 6.6) / 2}
								y={-9}
								width={18 + `${approved && !promoted ? "✓ " : ""}#${ch.number}`.length * 6.6}
								height={18}
								rx={9}
								fill={promoted ? colour : "var(--surface)"}
								stroke={colour}
								strokeWidth="1.4"
							/>
							<text
								className="lane-title"
								y={4}
								textAnchor="middle"
								fontSize="11"
								fontWeight="700"
								fill={promoted ? "var(--on-lane)" : colour}
							>
								{approved && !promoted ? "✓ " : ""}#{ch.number}
							</text>
						</g>
					)}
					{!replaying && !lane.detached && !lane.quiet && (
						<>
							<circle className="lane-presence-pulse" cx={tipX} cy={y} r="12" fill="none" stroke={colour} strokeWidth="1.5" />
							<circle cx={tipX} cy={y} r="3.5" fill={colour} />
						</>
					)}
					{quiet && <circle cx={tipX} cy={y} r="4" fill="var(--surface)" stroke={colour} strokeOpacity="0.7" strokeWidth="1.5" />}
				</>
			)}
			{replaying ? (
				<text className="lane-title" x={STATUS_X} y={lineA.y} fontSize="12" fill="var(--text-muted)">
					{promoted && ch ? (
						<>
							<tspan fontWeight="700" fill={colour}>
								#{ch.number}
							</tspan>{" "}
							promoted into main
						</>
					) : approved && ch ? (
						<>
							<tspan fontWeight="700" fill={colour}>
								#{ch.number}
							</tspan>{" "}
							approved on {short(ch.revision)}
						</>
					) : showChange && ch ? (
						<>
							<tspan fontWeight="700" fill={colour}>
								#{ch.number}
							</tspan>{" "}
							proposed on {short(ch.revision)}
						</>
					) : pub ? (
						`published ${short(pub.revision)}`
					) : started ? (
						"started"
					) : (
						"not started yet"
					)}
					<tspan x={STATUS_X} y={lineB.y} fill="var(--text-faint)">
						{drift === undefined ? "baseline not on record" : drift ? `main moved ${drift} since baseline` : "baseline is main's head"}
					</tspan>
				</text>
			) : (
				<>
					<text className="lane-title" x={STATUS_X} y={lineA.y} fontSize="12" fill={statusTone}>
						{lane.change ? (
							<>
								<tspan fontWeight="700" fill={colour}>
									#{lane.change.number}
								</tspan>{" "}
								{clip(lane.change.status.label.toLowerCase(), 26)}
							</>
						) : lane.published && ["ahead", "diverged"].includes(lane.relation.key) ? (
							<tspan fill="var(--text-muted)">published, not proposed</tspan>
						) : (
							<tspan fill="var(--text-faint)">no change yet</tspan>
						)}
					</text>
					<text className="lane-title" x={STATUS_X} y={lineB.y} fontSize="12.5" fontWeight="600" fill={tone(lane.relation.key)}>
						{clip(lane.relation.label.toLowerCase(), 26)}
					</text>
					<circle
						cx={STATUS_X + 4}
						cy={y + 13}
						r="3.5"
						fill={lane.quiet ? "none" : "var(--tone-success)"}
						stroke={lane.quiet ? "var(--text-faint)" : "none"}
						strokeWidth="1.5"
					/>
					<text className="lane-title" x={STATUS_X + 13} y={y + 17} fontSize="11.5" fill="var(--text-muted)">
						{lane.presence}
					</text>
					{lane.shared.length > 0 && (
						<text x={STATUS_X} y={y + 33} fontSize="11" fill="var(--tone-warning)">
							{clip(`shared ${lane.shared.join(", ")}`, 34)}
						</text>
					)}
				</>
			)}
		</g>
	);
}

/** One workspace on its own: the canonical trunk, its fixed baseline and the stages its work has reached. */
export function LaneStrip({ view, workspace, lane }: { view: RepositorySnapshot; workspace: Workspace; lane: number }) {
	const nodes = trunkModel(view),
		at = nodes.findIndex((n) => n.revision === workspace.baseRevision),
		placed = at !== -1,
		onHead = placed && at === nodes.length - 1,
		colour = `var(--lane-${lane})`,
		quiet = workspace.state === "disconnected",
		observed = view.reconciliation?.observation.workspaces[workspace.id],
		change = view.proposals.filter((p) => p.workspaceId === workspace.id).toSorted((a, b) => b.number - a.number)[0];
	const TY = 44,
		LY = 110,
		baseX = 80,
		headX = onHead ? baseX : 206,
		R = 22;
	const stops = [
		{ x: 320, label: "reported head", value: short(workspace.headRevision), on: true, shape: "head" },
		{
			x: 460,
			label: "pushed ref",
			value: observed && !observed.deleted ? short(observed.revision) : "not observed",
			on: !!observed && !observed.deleted,
			shape: "ring",
		},
		{
			x: 600,
			label: "published",
			value: workspace.publishedRevision ? short(workspace.publishedRevision) : "not published",
			on: !!workspace.publishedRevision,
			shape: "pub",
		},
		{ x: 740, label: "change", value: change ? `#${change.number}` : "none yet", on: !!change, shape: "change" },
	];
	const lastOn = Math.max(...stops.filter((s) => s.on).map((s) => s.x));
	const d = placed ? `M${baseX} ${TY} V${LY - R} Q${baseX} ${LY} ${baseX + R} ${LY} H${lastOn}` : `M${baseX} ${LY} H${lastOn}`;
	return (
		<div className="lane-strip" aria-hidden="true">
			<svg width="880" height="172" viewBox="0 0 880 172" aria-hidden="true">
				<path
					d={d}
					fill="none"
					stroke={colour}
					strokeWidth="6"
					strokeLinecap="round"
					strokeDasharray={placed && !quiet ? undefined : "1 11"}
				/>
				{lastOn < 740 && (
					<path
						d={`M${lastOn + 20} ${LY} H718`}
						stroke="var(--border-strong)"
						strokeWidth="2"
						strokeDasharray="1 7"
						strokeLinecap="round"
					/>
				)}
				<path d={`M28 ${TY} H${headX}`} stroke="var(--canonical)" strokeWidth="8" strokeLinecap="round" />
				{placed && (
					<>
						<rect
							x={baseX - 10}
							y={TY - 10}
							width="20"
							height="20"
							rx="10"
							fill="var(--surface)"
							stroke="var(--canonical)"
							strokeWidth="4"
						/>
						<text x={baseX} y={TY - 18} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
							{short(workspace.baseRevision)}
						</text>
					</>
				)}
				{!onHead && view.sourceHead && (
					<>
						<rect
							x={headX - 10}
							y={TY - 10}
							width="20"
							height="20"
							rx="10"
							fill="var(--surface)"
							stroke="var(--canonical)"
							strokeWidth="4"
						/>
						<text x={headX} y={TY - 18} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text)">
							{short(view.sourceHead)}
						</text>
					</>
				)}
				<g transform={`translate(${headX + 22} ${TY - 12})`}>
					<rect width="58" height="24" rx="12" fill="var(--canonical)" />
					<text x="29" y="16" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--on-canonical)">
						{clip(view.repository.defaultBranch, 7)}
					</text>
				</g>
				{!placed && (
					<>
						<circle cx={baseX} cy={LY} r="11" fill="var(--surface)" stroke={colour} strokeWidth="3" strokeDasharray="3 3" />
						<text x={baseX} y={LY + 4.5} textAnchor="middle" fontSize="12" fontWeight="700" fill={colour}>
							?
						</text>
						<text x={baseX} y={LY + 30} textAnchor="middle" fontSize="10.5" fill="var(--text-muted)">
							{short(workspace.baseRevision)}
						</text>
					</>
				)}
				{stops.map((stop) => {
					const stroke = stop.on ? colour : "var(--border-strong)";
					return (
						<g key={stop.label}>
							{stop.shape === "head" ? (
								<circle cx={stop.x} cy={LY} r="9" fill={quiet ? "var(--surface)" : colour} stroke={colour} strokeWidth="3" />
							) : stop.shape === "change" ? (
								<rect x={stop.x - 22} y={LY - 13} width="44" height="26" rx="13" fill="var(--surface)" stroke={stroke} strokeWidth="4" />
							) : (
								<circle cx={stop.x} cy={LY} r="8" fill="var(--surface)" stroke={stroke} strokeWidth={stop.shape === "ring" ? 2.5 : 4} />
							)}
							{stop.shape === "change" && stop.on && (
								<text x={stop.x} y={LY + 4.5} textAnchor="middle" fontSize="11.5" fontWeight="700" fill="var(--text)">
									{stop.value}
								</text>
							)}
							<text x={stop.x} y={LY + 34} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
								{stop.label}
							</text>
							{!(stop.shape === "change" && stop.on) && (
								<text x={stop.x} y={LY + 49} textAnchor="middle" fontSize="11" fill={stop.on ? "var(--text)" : "var(--text-faint)"}>
									{stop.value}
								</text>
							)}
						</g>
					);
				})}
			</svg>
		</div>
	);
}

/** Home's small sketch of a repository: canonical and one short branch per live workspace. */
export function MiniLanes({ lanes }: { lanes: RepositorySummary["lanes"] }) {
	const rows = lanes.slice(0, 3),
		height = rows.length ? 15 + rows.length * 9 : 16;
	return (
		<svg className="mini-lanes" width="150" height={height} viewBox={`0 0 150 ${height}`} aria-hidden="true">
			<path d="M6 8 H128" stroke="var(--canonical)" strokeWidth="3" strokeLinecap="round" />
			<circle cx="132" cy="8" r="4.5" fill="var(--bg)" stroke="var(--canonical)" strokeWidth="2.5" />
			{rows.map((lane, i) => {
				const y = 19 + i * 9,
					colour = `var(--lane-${(i % 6) + 1})`,
					behind = lane.relation === "behind" || lane.relation === "diverged",
					unplaced = lane.relation === "unknown" || lane.relation === "unrelated",
					bx = behind ? 34 - i * 6 : 104 - i * 22;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: the sketch is positional; summaries carry no workspace IDs.
					<g key={i}>
						{unplaced ? (
							<path d={`M${bx - 10} ${y} H136`} stroke={colour} strokeWidth="2.5" strokeDasharray="1 5" strokeLinecap="round" fill="none" />
						) : (
							<path
								d={`M${bx} 8 V${y - 6} Q${bx} ${y} ${bx + 6} ${y} H136`}
								stroke={colour}
								strokeWidth="2.5"
								fill="none"
								strokeLinecap="round"
								strokeDasharray={lane.quiet ? "1 5" : undefined}
							/>
						)}
						{behind ? (
							<path d={`M140 ${y - 4} V${y + 4}`} stroke="var(--tone-warning)" strokeWidth="2.5" strokeLinecap="round" />
						) : (
							<circle cx="139" cy={y} r="3" fill="var(--bg)" stroke={colour} strokeWidth="2.2" />
						)}
					</g>
				);
			})}
			{lanes.length > 3 && (
				<text x="148" y="41" fontSize="9" textAnchor="end" fill="var(--text-faint)" fontFamily="var(--font-mono)">
					+{lanes.length - 3}
				</text>
			)}
		</svg>
	);
}
