import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BRAND } from "./brand.tsx";
import {
	auth,
	billing,
	deps,
	exampleBaseline,
	examplePromotions,
	exampleRepository,
	exampleWorkspaces,
	rev,
	sharedPath,
} from "./landing-example.ts";
import { rememberSignInDestination } from "./sign-in-destination.ts";
import "./landing.css";

const base = rev(exampleBaseline);
const [first, second] = examplePromotions.map(rev);
const reconciled = rev(billing.heads[1]);

const stages = [
	{
		name: "Baseline",
		title: "Every workspace starts from a known revision.",
		detail: `auth, billing and deps branch from canonical ${base}. That baseline never changes.`,
		description: `Canonical main is at ${base}. Three workspaces, auth, billing and deps, each start from that exact revision with their own fork. A workspace's baseline is immutable.`,
	},
	{
		name: "Work",
		title: "Work happens anywhere, at its own pace.",
		detail: "Each tool commits locally and pushes to its workspace fork. Nobody waits on anybody.",
		description: `Claude Code advances auth to ${rev(auth.heads[0])}, Codex advances billing to ${rev(billing.heads[0])} and Cursor advances deps to ${rev(deps.heads[0])}. The tools are annotations on local work; Cruce does not run them, schedule them or relay messages between them.`,
	},
	{
		name: "Overlap",
		title: "Shared paths show up early.",
		detail: `auth and billing both touch ${sharedPath}. Overlap is advisory, not a conflict.`,
		description: `auth and billing both changed ${sharedPath}. Cruce shows the shared path as advisory context. It is not a conflict verdict, not proof of incompatibility and not a reason to stop independent work.`,
	},
	{
		name: "Review",
		title: "Review the revision that will move.",
		detail: `auth proposes ${first} against ${base}. A human approves ${first}, not the branch.`,
		description: `auth publishes and proposes the exact revision ${first} against base ${base}. Review and approval name ${first}. Only an authenticated human approval satisfies promotion.`,
	},
	{
		name: "Promote",
		title: `Canonical advances to exactly ${first}.`,
		detail: `A non-forced update from ${base}. billing and deps are now 3 behind and keep working.`,
		description: `After human approval and readiness, canonical moves from ${base} to ${first} with a non-forced Git update: the same revision that was reviewed. billing and deps are now three commits behind canonical and continue independently.`,
	},
	{
		name: "Reconcile",
		title: "Reconcile with what exists now.",
		detail: `billing merges ${first} with plain Git, verifies and pushes ${reconciled}. Its baseline stays ${base}.`,
		description: `billing explicitly fetches and merges accepted canonical ${first}, verifies locally and pushes ${reconciled} for fresh review. Fetching alone is not reconciliation. billing's baseline remains ${base}.`,
	},
	{
		name: "Continue",
		title: "One promotion at a time. Work continues.",
		detail: `${reconciled} is reviewed, approved and promoted. deps keeps working and reconciles when ready.`,
		description: `${reconciled} receives fresh review and human approval, then canonical moves from ${first} to ${second}. deps keeps working at ${rev(deps.heads[1])}, six commits behind canonical, and reconciles when its owner is ready. Canonical history: ${base}, then ${first}, then ${second}.`,
	},
];
const durations = [3800, 4400, 4800, 5400, 4600, 5400, 6000];
// Which lanes the story is about at each stage; the others recede but never disappear.
const focus = [[0, 1, 2], [0, 1, 2], [0, 1], [0], [0, 1, 2], [1], [1, 2]];

type Motion = "static" | "running" | "paused";
type Lane = { y: number; commits: number[]; extra?: number; marker?: number; node?: number };
type Layout = {
	id: "desktop" | "mobile";
	width: number;
	height: number;
	canonicalY: number;
	baseX: number;
	labelX: number;
	lanes: Lane[];
	compact: boolean;
};
const layouts: Layout[] = [
	{
		id: "desktop",
		width: 640,
		height: 432,
		canonicalY: 64,
		baseX: 60,
		labelX: 86,
		compact: false,
		lanes: [
			{ y: 176, commits: [146, 222, 298], marker: 372, node: 488 },
			{ y: 286, commits: [168, 252], extra: 520, marker: 560, node: 600 },
			{ y: 396, commits: [140, 230], extra: 318 },
		],
	},
	{
		id: "mobile",
		width: 356,
		height: 306,
		canonicalY: 56,
		baseX: 22,
		labelX: 42,
		compact: true,
		lanes: [
			{ y: 150, commits: [78, 120, 162], marker: 202, node: 248 },
			{ y: 258, commits: [90, 142], extra: 270, marker: 300, node: 332 },
		],
	},
];

// Reported head and its relationship to canonical, as the coordination view would state it.
function laneMeta(lane: number, stage: number): [string, string?] {
	if (stage === 0) return [base, "at baseline"];
	if (lane === 0) return [rev(auth.heads[0]), stage === 3 ? "proposal" : stage >= 4 ? "promoted 01" : undefined];
	if (lane === 1) {
		if (stage < 4) return [rev(billing.heads[0])];
		if (stage === 4) return [rev(billing.heads[0]), "3 behind canonical"];
		return [reconciled, stage === 5 ? `merged ${first}` : "promoted 02"];
	}
	if (stage < 4) return [rev(deps.heads[0])];
	if (stage < 6) return [rev(deps.heads[0]), "3 behind canonical"];
	return [rev(deps.heads[1]), "6 behind · still working"];
}

function CrossingGraph({ layout: L, stage }: { layout: Layout; stage: number }) {
	const cy = L.canonicalY;
	const [authLane, billingLane, depsLane] = L.lanes;
	const step = (from: number, until = Number.POSITIVE_INFINITY) =>
		`graph-step${stage >= from && stage < until ? " is-visible" : ""}${stage === from ? " is-current" : ""}`;
	const token = (path: string, label: string, from: number, delay = 0) => (
		<g className={step(from, from + 1)}>
			<g className="graph-token" data-ride={`${L.id}-${path}`} data-delay={delay}>
				<rect x="-31" y="-10" width="62" height="20" rx="10" />
				<text x="0" y="3.8" textAnchor="middle">
					{label}
				</text>
			</g>
		</g>
	);
	const promotion = (lane: Lane) =>
		`M${lane.marker! + 11} ${lane.y}H${lane.node! - 24}Q${lane.node} ${lane.y} ${lane.node} ${lane.y - 24}V${cy + 6}`;
	const review = (lane: Lane, revision: string, from: number) => (
		<g className={`graph-review ${step(from)}`}>
			<circle className="graph-proposal-ring" cx={lane.marker} cy={lane.y} r="11" data-pop="true" />
			<path className="graph-check" d={`m${lane.marker! - 5} ${lane.y}l3.5 3.5 6.5-7.5`} data-draw="true" data-delay="700" />
			{/* Review notes belong to their moment; the approval mark stays on the history. */}
			<g className={step(from, from + 2)}>
				<text x={lane.marker} y={lane.y + 30} textAnchor="middle" className="graph-mono graph-strong">
					{L.compact ? revision : `proposal ${revision}`}
				</text>
				<text x={lane.marker} y={lane.y + 46} textAnchor="middle" className="graph-note">
					✓ approved by a human
				</text>
			</g>
		</g>
	);
	const node = (lane: Lane, revision: string, order: string, from: number) => (
		<g className={`graph-promotion ${step(from)}`}>
			<path id={`${L.id}-promote-${lane === L.lanes[0] ? 0 : 1}`} d={promotion(lane)} data-draw="true" />
			<circle className="graph-canonical-node" cx={lane.node} cy={cy} r="6" data-pop="true" data-delay="900" />
			<text x={lane.node} y={cy - 16} textAnchor="middle" className="graph-mono graph-strong" data-pop="true" data-delay="900">
				{revision}
			</text>
			<text x={lane.node! - 9} y={cy + 22} textAnchor="end" className="graph-mono graph-faint">
				{order}
			</text>
		</g>
	);
	return (
		<svg
			className={`crossing-graph crossing-${L.id}`}
			viewBox={`0 0 ${L.width} ${L.height}`}
			fill="none"
			aria-hidden="true"
			data-canonical={stage >= 6 ? second : stage >= 4 ? first : base}
		>
			<text x="0" y="20" className="graph-mono graph-faint graph-caps">
				canonical / main
			</text>
			<path className="graph-canonical" d={`M0 ${cy}H${L.width}`} />
			<circle className="graph-baseline" cx={L.baseX} cy={cy} r="6" />
			<text x={L.baseX} y={cy - 16} textAnchor="middle" className="graph-mono graph-strong">
				{base}
			</text>
			<text x={L.baseX + 12} y={cy + 22} className="graph-mono graph-faint">
				baseline
			</text>
			{L.lanes.map((lane, i) => {
				const workspace = exampleWorkspaces[i];
				const [head, relation] = laneMeta(i, stage);
				const start = lane.commits[0] - 26;
				const last = lane.commits.at(-1)!;
				return (
					<g key={workspace.id} className={`graph-lane lane-${i}${focus[stage].includes(i) ? " is-focused" : ""}`} data-head={head}>
						<path
							id={`${L.id}-branch-${i}`}
							className={step(0)}
							d={`M${L.baseX} ${cy + 6}V${lane.y - 22}Q${L.baseX} ${lane.y} ${L.baseX + 22} ${lane.y}H${start}`}
							data-draw="true"
						/>
						<g className={step(1)}>
							<path d={`M${start} ${lane.y}H${last}`} data-draw="true" />
							{lane.commits.map((x, n) => (
								<circle
									key={x}
									className="graph-commit"
									cx={x}
									cy={lane.y}
									r="4.5"
									data-pop="true"
									data-delay={300 + n * (700 + i * 380) + i * 240}
								/>
							))}
						</g>
						<text x={L.labelX} y={lane.y - 36} className="graph-workspace">
							workspace/{workspace.id}
						</text>
						<text x={L.labelX} y={lane.y - 17} className="graph-mono">
							<tspan className="graph-strong">{head}</tspan>
							{relation && <tspan className={relation.includes("behind") ? "graph-behind" : "graph-faint"}> · {relation}</tspan>}
						</text>
						<text x={L.labelX} y={lane.y + 26} className="graph-tool">
							via {workspace.tool}
							{L.compact ? "" : " · local work"}
						</text>
					</g>
				);
			})}
			{/* Advisory overlap: a shared path between two independent workspaces, never a conflict verdict. */}
			<g className={`graph-overlap ${step(2, 3)}`}>
				<path d={`M${authLane.commits[1]} ${authLane.y + 8}L${billingLane.commits[1]} ${billingLane.y - 8}`} data-draw="true" />
				<circle cx={authLane.commits[1]} cy={authLane.y} r="9" data-pop="true" />
				<circle cx={billingLane.commits[1]} cy={billingLane.y} r="9" data-pop="true" />
				<text
					x={billingLane.commits[1] + (L.compact ? 14 : 20)}
					y={(authLane.y + billingLane.y) / 2 - (L.compact ? 12 : 6)}
					className="graph-mono graph-advisory"
				>
					shares {L.compact ? "session.ts" : sharedPath}
				</text>
				<text
					x={billingLane.commits[1] + (L.compact ? 14 : 20)}
					y={(authLane.y + billingLane.y) / 2 + (L.compact ? 3 : 10)}
					className="graph-note"
				>
					{L.compact ? "advisory only" : "advisory · not a conflict"}
				</text>
			</g>
			<g className={`lane-0 ${step(3)}`}>
				<path className="graph-extend" d={`M${authLane.commits[2]} ${authLane.y}H${authLane.marker! - 11}`} data-draw="true" />
			</g>
			<g className="lane-0">{review(authLane, first, 3)}</g>
			<g className="lane-0">{node(authLane, first, "01", 4)}</g>
			{/* Reconciliation is ordinary Git: billing merges accepted canonical into its own line of work. */}
			<g className={`graph-reconcile lane-1 ${step(5)}`}>
				<path className="graph-halo" d={reconcilePath(L)} />
				<path id={`${L.id}-reconcile`} className="graph-merge" d={reconcilePath(L)} data-draw="true" />
				<path d={`M${billingLane.commits[1]} ${billingLane.y}H${billingLane.extra}`} data-draw="true" />
				<circle
					className="graph-commit graph-merge-commit"
					cx={billingLane.extra}
					cy={billingLane.y}
					r="5"
					data-pop="true"
					data-delay="1100"
				/>
			</g>
			<g className={`graph-reconcile-label ${step(5, 6)}`}>
				<text x={billingLane.extra! - 14} y={billingLane.y - (L.compact ? 60 : 56)} textAnchor="end" className="graph-mono graph-strong">
					git merge {first}
				</text>
				{!L.compact && (
					<text x={billingLane.extra! - 14} y={billingLane.y - 40} textAnchor="end" className="graph-note">
						baseline stays {base}
					</text>
				)}
			</g>
			<g className={`lane-1 ${step(6)}`}>
				<path className="graph-extend" d={`M${billingLane.extra} ${billingLane.y}H${billingLane.marker! - 11}`} data-draw="true" />
			</g>
			<g className="lane-1">{review(billingLane, reconciled, 6)}</g>
			<g className="lane-1">{node(billingLane, second, "02", 6)}</g>
			{depsLane && (
				<g className={`lane-2 ${step(6)}`}>
					<path d={`M${depsLane.commits[1]} ${depsLane.y}H${depsLane.extra}`} data-draw="true" />
					<circle className="graph-commit" cx={depsLane.extra} cy={depsLane.y} r="4.5" data-pop="true" data-delay="1600" />
				</g>
			)}
			{L.lanes.map((lane, i) => (
				<g key={lane.y}>{token(`branch-${i}`, base, 0, 150 + i * 260)}</g>
			))}
			{token("promote-0", first, 4, 150)}
			{token("reconcile", first, 5, 100)}
			{token("promote-1", second, 6, 1500)}
		</svg>
	);
}

function reconcilePath(L: Layout) {
	const from = L.lanes[0].node!;
	const lane = L.lanes[1];
	return `M${from + 4} ${L.canonicalY + 5}C${from + 30} ${L.canonicalY + 60} ${lane.extra} ${lane.y - 110} ${lane.extra} ${lane.y - 6}`;
}

function sequenceVisible(element: Element | null) {
	if (!element) return false;
	const box = element.getBoundingClientRect();
	const width = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
	const height = Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
	return box.width > 0 && box.height > 0 && (width * height) / (box.width * box.height) >= 0.2;
}

function useStageMotion(ref: React.RefObject<HTMLDivElement | null>, stage: number, motion: Motion) {
	const animations = useRef<Animation[]>([]);
	const isStatic = motion === "static";
	// biome-ignore lint/correctness/useExhaustiveDependencies: Each stage renders new current elements whose effects replace the previous stage's.
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root || isStatic) return;
		const active: Animation[] = [];
		const animate = (element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
			const animation = element.animate(frames, { fill: "both", ...options });
			animation.pause();
			active.push(animation);
		};
		// Native SVG effects retain their painted frame on pause without generated global keyframes.
		for (const path of root.querySelectorAll<SVGPathElement>(".is-current[data-draw], .is-current [data-draw]")) {
			const length = path.getTotalLength();
			if (!length) continue;
			animate(
				path,
				[
					{ strokeDasharray: `${length} ${length}`, strokeDashoffset: String(length) },
					{ strokeDasharray: `${length} ${length}`, strokeDashoffset: "0" },
				],
				{
					duration: 1100,
					delay: Number(path.dataset.delay ?? 0),
					easing: "cubic-bezier(.3,.6,.25,1)",
				},
			);
		}
		for (const element of root.querySelectorAll<SVGElement>(".is-current [data-pop]"))
			animate(
				element,
				[
					{ opacity: 0, transform: "scale(.4)" },
					{ opacity: 1, transform: "scale(1)" },
				],
				{
					duration: 420,
					delay: Number(element.dataset.delay ?? 500),
					easing: "cubic-bezier(.3,1.4,.5,1)",
				},
			);
		// The exact revision rides its Git path: baselines into workspaces, approved revisions into canonical.
		for (const token of root.querySelectorAll<SVGGElement>(".is-current [data-ride]")) {
			const path = token.ownerSVGElement?.getElementById(token.dataset.ride ?? "");
			if (!(path instanceof SVGPathElement)) continue;
			const length = path.getTotalLength();
			if (!length) continue;
			const samples = 28;
			const frames: Keyframe[] = Array.from({ length: samples + 1 }, (_, n) => {
				const point = path.getPointAtLength((length * n) / samples);
				return {
					transform: `translate(${point.x}px, ${point.y}px)`,
					opacity: n === 0 || n === samples ? 0 : 1,
					offset: n / samples,
				};
			});
			animate(token, frames, { duration: 1500, delay: Number(token.dataset.delay ?? 0), easing: "cubic-bezier(.45,0,.25,1)" });
		}
		animations.current = active;
		return () => {
			for (const animation of active) animation.cancel();
			animations.current = [];
		};
	}, [stage, isStatic]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A new stage replaces effects and must reapply the current playback state.
	useLayoutEffect(() => {
		for (const animation of animations.current) {
			if (motion === "running") animation.play();
			// A stage that never started in a hidden document shows its finished state rather than an empty frame.
			else if (document.hidden && animation.currentTime === 0) animation.finish();
			else animation.pause();
		}
	}, [motion, stage, isStatic]);
}

function HeroSequence() {
	const [stage, setStage] = useState(0),
		[playing, setPlaying] = useState(false),
		[manual, setManual] = useState(false),
		[replay, setReplay] = useState(0),
		[visible, setVisible] = useState(false),
		[foreground, setForeground] = useState(!document.hidden),
		[reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
	const ref = useRef<HTMLDivElement>(null);
	const graphs = useRef<HTMLDivElement>(null);
	const inViewport = useRef(false);
	const progress = useRef<{ stage: number; elapsed: number; cycle: number; stoppedAt?: number }>({ stage: 0, elapsed: 0, cycle: 0 });
	const running = playing && !reduced && visible && foreground;
	const select = (next: number) => {
		progress.current = { stage: next, elapsed: 0, cycle: replay };
		setStage(next);
		setManual(true);
		setPlaying(false);
	};
	useEffect(() => {
		const preference = matchMedia("(prefers-reduced-motion: reduce)");
		setPlaying(!preference.matches);
		const motion = () => {
			progress.current.stoppedAt ??= performance.now();
			setReduced(preference.matches);
			setManual(true);
			setPlaying(false);
		};
		const visibility = () => {
			if (document.hidden) progress.current.stoppedAt ??= performance.now();
			setForeground(!document.hidden);
		};
		const observer = new IntersectionObserver(
			() => {
				// Observer entries can arrive after a resize or capture; read the current viewport geometry.
				inViewport.current = sequenceVisible(ref.current);
				if (!inViewport.current) progress.current.stoppedAt ??= performance.now();
				setVisible(inViewport.current);
			},
			{ threshold: [0, 0.2, 0.5] },
		);
		if (ref.current) observer.observe(ref.current);
		preference.addEventListener("change", motion);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			observer.disconnect();
			preference.removeEventListener("change", motion);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, []);
	useEffect(() => {
		if (!running) return;
		const phase = progress.current;
		if (phase.cycle !== replay) return;
		const started = performance.now();
		phase.stoppedAt = undefined;
		let completed = false;
		const timer = setTimeout(
			() => {
				const bounds = ref.current?.getBoundingClientRect();
				if (document.hidden || !inViewport.current || !bounds || bounds.bottom <= 0 || bounds.top >= innerHeight) return;
				completed = true;
				if (stage === durations.length - 1) {
					setPlaying(false);
				} else {
					progress.current = { stage: stage + 1, elapsed: 0, cycle: replay };
					setStage(stage + 1);
				}
			},
			Math.max(0, durations[stage] - phase.elapsed),
		);
		return () => {
			clearTimeout(timer);
			if (!completed && progress.current === phase)
				phase.elapsed = Math.min(durations[stage], phase.elapsed + (phase.stoppedAt ?? performance.now()) - started);
		};
	}, [running, stage, replay]);
	const replayStory = () => {
		progress.current = { stage: 0, elapsed: 0, cycle: replay + 1 };
		setReplay((value) => value + 1);
		setStage(0);
		setManual(false);
		setPlaying(!reduced);
	};
	const motion: Motion = reduced || manual ? "static" : running ? "running" : "paused";
	useStageMotion(graphs, stage, motion);
	const playbackLabel = reduced || (!playing && stage === durations.length - 1) ? "Replay" : playing ? "Pause" : "Play";
	return (
		<figure className="hero-sequence" ref={ref} data-motion={motion} aria-labelledby="sequence-title">
			<figcaption className="title-block">
				<span>
					<small>Example</small>
					<code>{exampleRepository}</code>
				</span>
				<span>
					<small>Canonical</small>
					<code>main</code>
				</span>
				<span>
					<small>Step</small>
					<code>
						{stage + 1}/{stages.length}
					</code>
				</span>
				<button
					className="sequence-playback"
					type="button"
					onClick={() => {
						if (playbackLabel === "Replay") {
							replayStory();
							return;
						}
						if (playing) progress.current.stoppedAt ??= performance.now();
						inViewport.current = sequenceVisible(ref.current);
						setVisible(inViewport.current);
						setManual(false);
						setPlaying((value) => !value);
					}}
				>
					{playbackLabel}
				</button>
			</figcaption>
			<div className="crossing-surface" ref={graphs} key={replay}>
				{layouts.map((layout) => (
					<CrossingGraph key={layout.id} layout={layout} stage={stage} />
				))}
				<p className="crossing-mobile-note">
					Also in flight: <code>workspace/deps</code> via Cursor, from the same baseline.
				</p>
			</div>
			{/* Every note occupies the same cell, so the tallest one reserves the space and the controls never move. */}
			<div className="sequence-note" aria-hidden="true">
				{stages.map((entry, i) => (
					<div key={entry.name} className={i === stage ? "is-current" : undefined}>
						<p id={i === stage ? "sequence-title" : undefined}>{entry.title}</p>
						<span>{entry.detail}</span>
					</div>
				))}
			</div>
			<fieldset className="sequence-controls" aria-label="Development story stages">
				{stages.map(({ name }, i) => (
					<button key={name} type="button" aria-label={name} aria-pressed={stage === i} onClick={() => select(i)}>
						<span className="sequence-stop" aria-hidden="true" />
						<span className="sequence-step-copy">{name}</span>
					</button>
				))}
			</fieldset>
			<p className="landing-sr-only sequence-description" aria-live={playing ? "off" : "polite"}>
				{stages[stage].description}
			</p>
		</figure>
	);
}

// The exact-revision ledger: two Git lanes, one canonical and one workspace, read top to bottom.
const ledger: { lane: "c" | "w"; revision: string; label: string; join?: "branch" | "merge" | "promote"; mark?: "ring" | "check" }[] = [
	{ lane: "c", revision: base, label: "baseline" },
	{ lane: "w", revision: rev(billing.heads[0]), label: "work, any tool", join: "branch" },
	{ lane: "c", revision: first, label: "canonical moved" },
	{ lane: "w", revision: reconciled, label: `merge ${first}`, join: "merge" },
	{ lane: "w", revision: reconciled, label: "proposal", mark: "ring" },
	{ lane: "w", revision: reconciled, label: "human approval", mark: "check" },
	{ lane: "c", revision: reconciled, label: "promoted", join: "promote" },
];

function Ledger() {
	const row = 34,
		c = 10,
		w = 34,
		top = 14;
	const y = (i: number) => top + i * row;
	const height = y(ledger.length - 1) + 22;
	const workFrom = ledger.findIndex((entry) => entry.join === "branch");
	const workTo = ledger.findIndex((entry) => entry.join === "promote") - 1;
	return (
		<svg className="ledger" viewBox={`0 0 300 ${height}`} role="img" aria-labelledby="ledger-title">
			<title id="ledger-title">
				{`billing starts at baseline ${base}, works to ${rev(billing.heads[0])}, merges canonical ${first} into ${reconciled}, proposes ${reconciled}, receives human approval for ${reconciled}, and canonical is promoted to exactly ${reconciled}.`}
			</title>
			<path className="ledger-canonical" d={`M${c} 0V${height}`} />
			<path className="ledger-work" d={`M${w} ${y(workFrom)}V${y(workTo)}`} />
			{ledger.map((entry, i) => {
				const x = entry.lane === "c" ? c : w;
				const prior = y(i - 1);
				return (
					<g key={`${entry.label}-${entry.revision}`} className={`ledger-row is-${entry.lane}`} style={{ "--i": i } as React.CSSProperties}>
						{entry.join === "branch" && (
							<path className="ledger-work" d={`M${c} ${prior}C${c} ${prior + 20} ${w} ${y(i) - 20} ${w} ${y(i)}`} />
						)}
						{entry.join === "merge" && (
							<path className="ledger-merge" d={`M${c} ${prior}C${c} ${prior + 20} ${w} ${y(i) - 20} ${w} ${y(i)}`} />
						)}
						{entry.join === "promote" && (
							<path className="ledger-work" d={`M${w} ${prior}C${w} ${prior + 20} ${c} ${y(i) - 20} ${c} ${y(i)}`} />
						)}
						<circle
							className={entry.mark ? `ledger-${entry.mark}` : entry.join === "promote" ? "ledger-accepted" : "ledger-dot"}
							cx={x}
							cy={y(i)}
							r={entry.mark ? 7 : 5}
						/>
						{entry.mark === "check" && <path className="ledger-tick" d={`m${x - 3.2} ${y(i)}l2.2 2.2 4.2-4.8`} />}
						<text x="62" y={y(i) + 4} className={`ledger-revision${entry.revision === reconciled ? " is-exact" : ""}`}>
							{entry.revision}
						</text>
						<text x="128" y={y(i) + 4} className="ledger-label">
							{entry.label}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

// The sheet draws itself once when it arrives; without motion (or without JS) it is simply there.
function useReveal(onLoad = false) {
	const ref = useRef<HTMLElement>(null);
	const [reveal, setReveal] = useState<"pending" | "done" | undefined>(() =>
		onLoad && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "pending" : undefined,
	);
	useEffect(() => {
		const element = ref.current;
		if (!element || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		if (onLoad) {
			// Draw shortly after the empty state paints; a timer also fires in background tabs.
			const timer = setTimeout(() => setReveal("done"), 120);
			return () => clearTimeout(timer);
		}
		if (element.getBoundingClientRect().top < innerHeight * 0.8) return;
		setReveal("pending");
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setReveal("done");
				observer.disconnect();
			},
			{ rootMargin: "0px 0px -25% 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [onLoad]);
	return [ref, reveal] as const;
}

// Three specimens of how Git work is shaped: one author, one assistant, then many agents at once.
function Generations() {
	const draw = (index: number, d: string, className = "") => (
		<path key={d} className={`gen-draw ${className}`} d={d} pathLength={1} style={{ "--d": `${index * 90}ms` } as React.CSSProperties} />
	);
	return (
		<ol className="generations" aria-label="Three generations of software development">
			<li style={{ "--g": 0 } as React.CSSProperties}>
				<svg viewBox="0 0 200 124" aria-hidden="true">
					{draw(0, "M8 70H192", "gen-canonical")}
					{[44, 86, 128].map((x) => (
						<circle key={x} className="gen-commit" cx={x} cy="70" r="4.5" />
					))}
					<circle className="gen-review" cx="170" cy="70" r="8" />
					<path className="gen-tick" d="m166 70 3 3 5-6" />
					<text x="44" y="52" textAnchor="middle" className="gen-label">
						you
					</text>
				</svg>
				<Era name="I · Written">You write the code. Review reads what you wrote.</Era>
			</li>
			<li style={{ "--g": 1 } as React.CSSProperties}>
				<svg viewBox="0 0 200 124" aria-hidden="true">
					{draw(0, "M8 82H192", "gen-canonical")}
					{draw(1, "M36 82C52 82 52 46 70 46H128C146 46 146 82 162 82", "gen-agent")}
					{[86, 112].map((x) => (
						<circle key={x} className="gen-commit gen-agent-commit" cx={x} cy="46" r="4" />
					))}
					<circle className="gen-commit" cx="36" cy="82" r="4.5" />
					<circle className="gen-review" cx="162" cy="82" r="8" />
					<path className="gen-tick" d="m158 82 3 3 5-6" />
					<text x="99" y="32" textAnchor="middle" className="gen-label">
						you + an agent
					</text>
					<text x="162" y="108" textAnchor="middle" className="gen-label">
						PR
					</text>
				</svg>
				<Era name="II · Assisted">An agent helps, one at a time. The pull request still fits.</Era>
			</li>
			<li className="is-now" style={{ "--g": 2 } as React.CSSProperties}>
				<svg viewBox="0 0 200 124" aria-hidden="true">
					{["M46 62C68 18 88 104 116 22", "M46 62C72 96 84 8 116 46", "M46 62C66 36 94 116 116 78", "M46 62C76 116 86 34 116 102"].map(
						(d, i) => draw(i, d, `gen-strand gen-strand-${i}`),
					)}
					<circle className="gen-intent" cx="46" cy="62" r="5" />
					<rect className="gen-cruce" x="116" y="10" width="36" height="104" rx="3" />
					{[22, 46, 78, 102].map((y, i) => draw(4 + i, `M118 ${y}C134 ${y} 136 62 150 62`, "gen-reconcile"))}
					{draw(8, "M152 62H196", "gen-canonical")}
					{[164, 178, 192].map((x) => (
						<circle key={x} className="gen-commit gen-promoted" cx={x} cy="62" r="4" />
					))}
					<text x="134" y="124" textAnchor="middle" className="gen-label gen-label-cruce">
						{BRAND.name.toLowerCase()}
					</text>
					<text x="37" y="66" textAnchor="end" className="gen-label">
						intent
					</text>
				</svg>
				<Era name="III · Agentic">
					Many agents write at once, overlapping. <strong>{BRAND.name} sits here</strong>, between them and canonical Git.
				</Era>
			</li>
		</ol>
	);
}

function Era({ name, children }: { name: string; children: React.ReactNode }) {
	return (
		<div className="era">
			<h3>{name}</h3>
			<p>{children}</p>
		</div>
	);
}

export function Landing() {
	const [hero, heroReveal] = useReveal(true);
	const [sheet, reveal] = useReveal();
	useEffect(() => {
		document.title = `${BRAND.name} · Git coordination for parallel agentic development`;
	}, []);
	return (
		<div
			className="landing"
			onClickCapture={(event) => {
				if (event.target instanceof Element && event.target.closest("a")?.getAttribute("href") === "/auth/login")
					rememberSignInDestination();
			}}
		>
			<a className="landing-skip" href="#landing-content">
				Skip to content
			</a>
			<header className="landing-header landing-wrap">
				<a className="landing-brand" href="/" aria-label={`${BRAND.name} home`}>
					<img src={BRAND.wordmarkInk} alt={BRAND.name} />
				</a>
				<nav aria-label="Homepage navigation">
					{BRAND.docsUrl && <a href={BRAND.docsUrl}>Docs</a>}
					{BRAND.sourceUrl && <a href={BRAND.sourceUrl}>GitHub</a>}
					<a className="landing-signin" href="/auth/login">
						Sign in
					</a>
				</nav>
			</header>
			<main id="landing-content" tabIndex={-1}>
				<section className="landing-hero landing-wrap" aria-labelledby="hero-heading" ref={hero} data-reveal={heroReveal}>
					<div className="hero-copy">
						<p className="landing-kicker">Git coordination for parallel agentic development</p>
						<h1 id="hero-heading">
							Code is written in parallel now.
							<br />
							<em>The decision is still yours.</em>
						</h1>
						<p className="hero-description">
							Software went from written, to assisted, to agentic. As agents write more of it, your job moves from typing every line to
							understanding, reconciling and authorizing what lands. {BRAND.name} is Git coordination built for that third generation.
						</p>
						<p className="shift">
							<small>The human job</small>
							<s>writing every line</s>
							<span aria-hidden="true">→</span>
							<strong>deciding what becomes canonical</strong>
						</p>
					</div>
					<Generations />
				</section>
				<section className="story landing-wrap" aria-labelledby="story-heading">
					<div className="story-copy">
						<p className="plate-index">How it works</p>
						<h2 id="story-heading">
							Many paths.
							<br />
							<em>One history.</em>
						</h2>
						<p className="hero-description">
							Let every agent, teammate and script work at once, in whatever tool they like. {BRAND.name} remembers where each piece of work
							began, notices where paths cross, and brings it home <strong>one approved revision at a time</strong>.
						</p>
						<ul className="hero-boundary" aria-label={`What ${BRAND.name} does not do`}>
							<li>Runs no agents</li>
							<li>Replaces no Git</li>
							<li>Lands nothing without a human</li>
						</ul>
					</div>
					<HeroSequence />
				</section>
				<section className="sheet landing-wrap" aria-labelledby="sheet-heading" ref={sheet} data-reveal={reveal}>
					<header className="sheet-header">
						<p className="plate-index">What stays true</p>
						<h2 id="sheet-heading">However many agents you run.</h2>
					</header>
					<div className="plates">
						<article className="plate" aria-labelledby="durable-heading">
							<p className="plate-index">A · Durable</p>
							<h3 id="durable-heading">
								Work outlives
								<br />
								the session.
							</h3>
							<ul className="identity" aria-label="What a workspace is not">
								{[
									["agent session", "closed"],
									["laptop", "asleep"],
									["local checkout", "detached"],
									["tool", "swapped"],
								].map(([thing, state], i) => (
									<li key={thing} style={{ "--i": i } as React.CSSProperties}>
										<s>{thing}</s>
										<span aria-hidden="true">≠</span>
										<code>workspace</code>
										<small>{state}</small>
									</li>
								))}
							</ul>
							<dl className="identity-record" aria-label="workspace/auth">
								<p>workspace/auth</p>
								<div>
									<dt>baseline</dt>
									<dd>
										<code>{base}</code> fixed
									</dd>
								</div>
								<div>
									<dt>pushed</dt>
									<dd>
										<code>{first}</code>
									</dd>
								</div>
								<div>
									<dt>history</dt>
									<dd>started in Claude Code · continued in Codex</dd>
								</div>
							</dl>
							<p className="plate-note">
								Close the laptop. Switch tools. Pick it up tomorrow on another machine. The workspace belongs to you, not to the process
								that happened to be running.
							</p>
						</article>
						<article className="plate" aria-labelledby="exact-heading">
							<p className="plate-index">B · Exact</p>
							<h3 id="exact-heading">
								What you approve
								<br />
								is what lands.
							</h3>
							<Ledger />
							<p className="plate-note">
								Approval names one exact revision, never a branch that can shift underneath it. If main moves first, the work is reconciled
								with plain Git and reviewed again.
							</p>
						</article>
						<article className="plate" aria-labelledby="tools-heading">
							<p className="plate-index">C · Composable</p>
							<h3 id="tools-heading">
								Bring any agent.
								<br />
								Keep Git.
							</h3>
							<ol className="strata" aria-label="Where Cruce sits">
								<li>
									<small>Execution · yours</small>
									<p>Claude Code · Codex · Cursor · orchestrators · scripts · you</p>
								</li>
								<li className="strata-wire" aria-hidden="true">
									<span>git push</span>
									<span>MCP / API</span>
								</li>
								<li className="strata-cruce">
									<small>Coordination · {BRAND.name}</small>
									<p>workspaces · baselines · overlap · review · promotion</p>
								</li>
								<li className="strata-wire" aria-hidden="true">
									<span>non-forced promotion</span>
								</li>
								<li>
									<small>Source · Git</small>
									<p>canonical + workspace forks, in Cloudflare Artifacts</p>
								</li>
							</ol>
							<p className="plate-note">
								{BRAND.name} doesn’t run your agents; it coordinates what they leave behind. There is no <code>cruce push</code>. Clone,
								commit, merge and push work as they always have.
							</p>
						</article>
					</div>
				</section>
			</main>
			<footer className="landing-footer landing-wrap">
				<div className="footer-status">
					<p>
						<span className="footer-dot" aria-hidden="true" />
						{BRAND.name} is in early development.
					</p>
					<p>Built toward open source.</p>
				</div>
			</footer>
		</div>
	);
}
