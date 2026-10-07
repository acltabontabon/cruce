import type { RepositorySummary } from "../shared/coordination.ts";
import type { RepositorySnapshot, Workspace } from "../shared/platform.ts";
import { type Lane, lanes as laneModel, trunk as trunkModel } from "./lanes.ts";
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
const VISIBLE_TRUNK = 5;
const MAX_LANES = 12;
const tone = (key: string) =>
	["behind", "diverged", "reconciliation", "preparation"].includes(key)
		? "var(--tone-warning)"
		: ["current", "ahead", "promote", "promoted"].includes(key)
			? "var(--tone-success)"
			: key === "review"
				? "var(--tone-accent)"
				: key === "recovery" || key === "promoting"
					? "var(--tone-danger)"
					: "var(--text-muted)";

/**
 * Canonical drawn as a trunk of recorded promotions, each live workspace as a lane leaving it at its fixed baseline.
 * The horizontal axis is lifecycle stage, not time or distance: Cruce has no commit counts between revisions to draw honestly.
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
	const nodes = trunkModel(view),
		// The lane's person is its accountable owner; tool provenance stays in the workspace rows and details.
		all = laneModel(view).map((lane) => (who ? { ...lane, worked: `Owner: ${ownerName(lane.ownerId, who)}` } : lane));
	if (!all.length) return null;
	const hidden = Math.max(0, nodes.length - VISIBLE_TRUNK),
		position = (index: number) => (hidden ? (index < hidden ? 0 : index - hidden + 1) : index),
		ticks = hidden ? [{ revision: "", earlier: hidden }, ...nodes.slice(hidden)] : nodes;
	const shown = all
		.toSorted((a, b) => (b.baseline === undefined ? -1 : position(b.baseline)) - (a.baseline === undefined ? -1 : position(a.baseline)))
		.slice(0, MAX_LANES);
	const TY = 66,
		tx = (i: number) => 80 + i * 104,
		COL = { head: 560, pub: 680, chg: 800, rel: 870 },
		top = 160,
		gap = 82,
		overlaps = view.overlaps.slice(0, 4),
		W = 1030 + overlaps.length * 14,
		H = top + shown.length * gap - 14,
		R = 22;
	const groups = new Map<number, Lane[]>();
	for (const lane of shown)
		if (lane.baseline !== undefined) groups.set(position(lane.baseline), [...(groups.get(position(lane.baseline)) ?? []), lane]);
	const departure = (lane: Lane) => {
		if (lane.baseline === undefined) return undefined;
		const group = groups.get(position(lane.baseline)) ?? [lane];
		return tx(position(lane.baseline)) + ((group.length - 1) / 2 - group.indexOf(lane)) * 10;
	};
	const rowY = new Map(shown.map((lane, i) => [lane.id, top + i * gap]));
	const headX = tx(ticks.length - 1);
	const relationCounts = {
		current: all.filter((l) => ["current", "ahead"].includes(l.relation.key)).length,
		behind: all.filter((l) => ["behind", "diverged"].includes(l.relation.key)).length,
		unknown: all.filter((l) => !["current", "ahead", "behind", "diverged"].includes(l.relation.key)).length,
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
	return (
		<figure className="lane-map" data-focus={focus || undefined}>
			<div className="lane-map-head">
				<h2>Lane map</h2>
				<ul className="lane-legend" aria-hidden="true">
					<li>
						<svg width="12" height="12" aria-hidden="true">
							<circle cx="6" cy="6" r="4.5" fill="currentColor" />
						</svg>
						reported head
					</li>
					<li>
						<svg width="12" height="12" aria-hidden="true">
							<circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
						</svg>
						published
					</li>
					<li>
						<svg width="20" height="12" aria-hidden="true">
							<rect x="1.5" y="1.5" width="17" height="9" rx="4.5" fill="none" stroke="currentColor" strokeWidth="2" />
						</svg>
						change
					</li>
					<li>
						<svg width="20" height="8" aria-hidden="true">
							<path d="M1 4h18" stroke="currentColor" strokeWidth="3" strokeDasharray="1 5" strokeLinecap="round" />
						</svg>
						not reporting or unplaced
					</li>
					<li className="shared">
						<svg width="10" height="12" aria-hidden="true">
							<path d="M1 1h7v10H1" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" />
						</svg>
						shared path, advisory
					</li>
				</ul>
			</div>
			<div className="lane-canvas">
				<svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" onMouseLeave={() => setFocus(undefined)}>
					{(
						[
							["head", COL.head],
							["published", COL.pub],
							["change", COL.chg],
						] as const
					).map(([label, x]) => (
						<g key={label}>
							<text x={x} y={26} textAnchor="middle" fontSize="10.5" fill="var(--text-faint)">
								{label}
							</text>
							<line
								x1={x}
								y1={top - 54}
								x2={x}
								y2={H - 10}
								stroke="var(--border)"
								strokeDasharray="1 6"
								strokeLinecap="round"
								strokeWidth="1.5"
							/>
						</g>
					))}
					<text x={COL.rel} y={26} fontSize="10.5" fill="var(--text-faint)">
						relation
					</text>
					{shown.map((lane) => (
						<LanePath
							key={lane.id}
							lane={lane}
							y={rowY.get(lane.id) ?? top}
							bx={departure(lane)}
							TY={TY}
							R={R}
							COL={COL}
							W={W}
							gap={gap}
							focused={focus === lane.id}
							setFocus={setFocus}
							open={open}
						/>
					))}
					<path d={`M32 ${TY} H${headX}`} stroke="var(--surface)" strokeWidth="14" strokeLinecap="round" />
					<path d={`M32 ${TY} H${headX}`} stroke="var(--canonical)" strokeWidth="8" strokeLinecap="round" />
					<text x={32} y={26} fontSize="10.5" fill="var(--text-faint)">
						{view.repository.defaultBranch}
					</text>
					{ticks.map((node, i) => {
						const x = tx(i),
							last = i === ticks.length - 1,
							width = (groups.get(i)?.length ?? 1) * 10 + 10;
						return (
							<g key={"earlier" in node ? "earlier" : node.revision}>
								<rect
									x={x - width / 2}
									y={TY - 10}
									width={width}
									height={20}
									rx={10}
									fill="var(--surface)"
									stroke="var(--canonical)"
									strokeWidth="4"
									strokeDasharray={"earlier" in node ? "3 3" : undefined}
								/>
								{"lane" in node && node.lane && <circle cx={x} cy={TY} r="3.5" fill={`var(--lane-${node.lane})`} />}
								<text
									x={x}
									y={TY - 20}
									textAnchor="middle"
									fontSize="11"
									fontWeight={last ? 700 : 400}
									fill={last ? "var(--text)" : "var(--text-muted)"}
								>
									{"earlier" in node ? `+${node.earlier} earlier` : short(node.revision)}
								</text>
								{"change" in node && node.change && (
									<text x={x} y={TY - 34} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
										#{node.change}
									</text>
								)}
							</g>
						);
					})}
					<g transform={`translate(${headX + 22} ${TY - 12})`}>
						<rect width="58" height="24" rx="12" fill="var(--canonical)" />
						<text x="29" y="16" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--on-canonical)">
							{clip(view.repository.defaultBranch, 7)}
						</text>
					</g>
					{overlaps.map((overlap, k) => {
						const ys = overlap.workspaces.map((id) => rowY.get(id)).filter((y): y is number => y !== undefined);
						if (ys.length < 2) return null;
						const x = 1012 + k * 14,
							y1 = Math.min(...ys),
							y2 = Math.max(...ys);
						return (
							<g key={overlap.id}>
								<path
									d={`M${x - 10} ${y1} H${x} V${y2} H${x - 10}`}
									fill="none"
									stroke="var(--tone-warning)"
									strokeWidth="2"
									strokeLinejoin="round"
									strokeDasharray="6 4"
								/>
								{ys
									.filter((y) => y !== y1 && y !== y2)
									.map((y) => (
										<path key={y} d={`M${x - 10} ${y} H${x}`} stroke="var(--tone-warning)" strokeWidth="2" />
									))}
							</g>
						);
					})}
				</svg>
			</div>
			<figcaption>
				{caption}.
				{view.overlaps.length > 0 &&
					` Shared ${view.overlaps.length === 1 ? "path" : "paths"}: ${view.overlaps
						.slice(0, 3)
						.map((o) => o.surface)
						.join(", ")}${view.overlaps.length > 3 ? " and more" : ""}. A heads-up, not a conflict.`}
				{all.length > shown.length && ` ${all.length - shown.length} more are listed below.`}
			</figcaption>
		</figure>
	);
}

function LanePath({
	lane,
	y,
	bx,
	TY,
	R,
	COL,
	W,
	gap,
	focused,
	setFocus,
	open,
}: {
	lane: Lane;
	y: number;
	bx?: number;
	TY: number;
	R: number;
	COL: { head: number; pub: number; chg: number; rel: number };
	W: number;
	gap: number;
	focused: boolean;
	setFocus: (id?: string) => void;
	open: (id: string) => void;
}) {
	const colour = `var(--lane-${lane.lane})`,
		placed = bx !== undefined,
		startX = placed ? bx : 190,
		end = lane.change ? COL.chg : lane.published ? COL.pub : COL.head,
		dashed = !placed || lane.quiet || lane.relation.key === "unknown",
		d = placed ? `M${bx} ${TY} V${y - R} Q${bx} ${y} ${bx + R} ${y} H${end}` : `M${startX} ${y} H${end}`,
		nameX = placed ? bx + R + 12 : startX + 22;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the drawing is aria-hidden; each lane's row below is the accessible control.
		<g className={`lane${focused ? " is-focus" : ""}`} onMouseEnter={() => setFocus(lane.id)} onClick={() => open(lane.id)}>
			<title>{lane.title}</title>
			<rect x={startX - 24} y={y - 46} width={W - startX} height={gap - 6} fill="transparent" />
			<path d={d} fill="none" stroke="var(--surface)" strokeWidth="12" strokeLinecap="round" />
			<path d={d} fill="none" stroke={colour} strokeWidth="6" strokeLinecap="round" strokeDasharray={dashed ? "1 11" : undefined} />
			<path
				d={`M${end + 24} ${y} H${COL.rel - 14}`}
				stroke="var(--border-strong)"
				strokeWidth="1.5"
				strokeDasharray="1 5"
				strokeLinecap="round"
			/>
			<circle cx={nameX + 10} cy={y - 26} r="10" fill={colour} />
			<text x={nameX + 10} y={y - 22.2} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--on-lane)">
				{lane.lane}
			</text>
			<text className="lane-title" x={nameX + 28} y={y - 22} fontSize="13" fontWeight="600" fill="var(--text)">
				{clip(lane.title, 34)}
				<tspan fontWeight="400" fontStyle="italic" fill="var(--text-muted)" dx="8">
					{clip(lane.worked, 30)}
				</tspan>
			</text>
			{!placed && (
				<>
					<circle cx={startX} cy={y} r="11" fill="var(--surface)" stroke={colour} strokeWidth="3" strokeDasharray="3 3" />
					<text x={startX} y={y + 4.5} textAnchor="middle" fontSize="12" fontWeight="700" fill={colour}>
						?
					</text>
					<text x={startX} y={y + 30} textAnchor="middle" fontSize="10.5" fill="var(--text-muted)">
						{short(lane.baseRevision)}
					</text>
				</>
			)}
			{lane.shared.length > 0 && (
				<circle cx={COL.head} cy={y} r="15" fill="none" stroke="var(--tone-warning)" strokeWidth="2" strokeDasharray="3 3" />
			)}
			<circle cx={COL.head} cy={y} r="9" fill={lane.quiet ? "var(--surface)" : colour} stroke={colour} strokeWidth="3" />
			<text x={COL.head} y={y + 30} textAnchor="middle" fontSize="11" fill="var(--text)">
				{short(lane.head)}
			</text>
			<text x={COL.head} y={y + 44} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
				{lane.commits} {lane.commits === 1 ? "commit" : "commits"}
			</text>
			{lane.published && (
				<>
					<circle cx={COL.pub} cy={y} r="8" fill="var(--surface)" stroke={colour} strokeWidth="4" />
					<text x={COL.pub} y={y + 30} textAnchor="middle" fontSize="11" fill="var(--text)">
						{short(lane.published)}
					</text>
				</>
			)}
			{lane.change && (
				<>
					<rect
						x={COL.chg - 22}
						y={y - 13}
						width="44"
						height="26"
						rx="13"
						fill={lane.change.status.key === "promoted" ? colour : "var(--surface)"}
						stroke={colour}
						strokeWidth="4"
					/>
					<text
						x={COL.chg}
						y={y + 4.5}
						textAnchor="middle"
						fontSize="11.5"
						fontWeight="700"
						fill={lane.change.status.key === "promoted" ? "var(--on-lane)" : "var(--text)"}
					>
						#{lane.change.number}
					</text>
					<text x={COL.chg} y={y + 32} textAnchor="middle" fontSize="11" fill={tone(lane.change.status.key)}>
						{clip(lane.change.status.label.toLowerCase(), 18)}
					</text>
				</>
			)}
			<text className="lane-title" x={COL.rel} y={y + 1} fontSize="12.5" fontWeight="600" fill={tone(lane.relation.key)}>
				{clip(lane.relation.label.toLowerCase(), 22)}
			</text>
			<circle
				cx={COL.rel + 4}
				cy={y + 16}
				r="3.5"
				fill={lane.quiet ? "none" : "var(--tone-success)"}
				stroke={lane.quiet ? "var(--text-faint)" : "none"}
				strokeWidth="1.5"
			/>
			<text x={COL.rel + 13} y={y + 20} fontSize="10.5" fill="var(--text-muted)">
				{lane.quiet ? "quiet" : "live"}
			</text>
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
	const rows = lanes.slice(0, 3);
	return (
		<svg className="mini-lanes" width="150" height="42" viewBox="0 0 150 42" aria-hidden="true">
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
