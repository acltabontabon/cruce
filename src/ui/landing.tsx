import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BRAND } from "./brand.tsx";
import { short } from "./controls.tsx";
import { exampleBase, exampleContributions, exampleWorkspaces } from "./landing-example.ts";
import { rememberSignInDestination } from "./sign-in-destination.ts";
import "./landing.css";

const chapters = [
	{ name: "Independent work", label: "Work", stage: 0 },
	{ name: "Shared awareness", label: "Notice", stage: 1 },
	{ name: "Align together", label: "Align", stage: 2 },
	{ name: "Sequential convergence", label: "Converge", stage: 3 },
	{ name: "Common ground", label: "Together", stage: 8 },
];
const durations = [4200, 4800, 5600, 3600, 4600, 3600, 4600, 3600, 3200];
const notes = [
	{ title: "Room to work", detail: "One shared repository" },
	{ title: "Shared advisory", detail: "Look closer. Keep moving." },
	{ title: "Agents align", detail: "Routine work moves forward." },
	{ title: "Claude joins main", detail: "Exact revision accepted" },
	{ title: "Shared context", detail: "Fetch · merge · verify" },
	{ title: "Codex joins main", detail: "Exact revision accepted" },
	{ title: "Context refreshed", detail: "Cursor brings main forward." },
	{ title: "Cursor joins main", detail: "Exact revision accepted" },
	{ title: "Common ground", detail: "Three contributions. One main." },
];
const stageDescriptions = [
	"Three independent writers start at 71d94e2a in separate workspaces. Cruce does not launch or own their tools.",
	"Claude Code and Codex report changes to src/auth/session.ts. Shared paths are advisory, not proof of a conflict or a reason to stop independent work.",
	"The coordination vision is for agents to inspect relevant context, adjust routine work and keep independent work moving. Ambiguous requirements, competing designs and unresolved disagreement branch to the developer. Proactive decisions and acknowledgements are proposed capabilities, not implemented controls.",
	"Claude Code's exact revision bc811af0 is accepted first. Canonical advances only after human approval, controller readiness and a completed non-forced Git update. Routine coordination does not require human supervision.",
	"Codex and Cursor receive accepted source. Codex explicitly fetches and incorporates bc811af0, verifies locally, then pushes b2c4e718. Its workspace starting revision remains 71d94e2a. Receiving an update alone does not integrate it or advance canonical.",
	"Codex's reconciled revision b2c4e718 is accepted at the second dot after fresh exact-revision review, readiness and completed promotion. Claude's earlier accepted revision stays in canonical history.",
	"Cursor explicitly fetches and incorporates the accepted b2c4e718, verifies locally and pushes c3d8a902. Its starting revision remains 71d94e2a; canonical remains b2c4e718 until completed promotion.",
	"Cursor's reconciled revision c3d8a902 is accepted at the third dot after fresh review, readiness and completed promotion. Each dot represents a distinct accepted revision and originating workspace.",
	"All three accepted contributions have reached canonical, in the example order Claude Code, Codex, then Cursor. This straight line depicts the sequence of accepted revisions, not flattened Git ancestry or a vendor priority rule. Cruce's coordination boundary ends at canonical Git.",
];
const acceptedCount = (stage: number) => (stage >= 7 ? 3 : stage >= 5 ? 2 : stage >= 3 ? 1 : 0);
const currentChapter = (stage: number) => (stage < 3 ? stage : stage < 8 ? 3 : 4);
const laneEnd = (index: number) => 420 + index * 44;
const mainDot = (index: number) => 450 + index * 44;
const laneY = (index: number) => 146 + index * 112;

type Motion = "static" | "running" | "paused";

function CrossingGraph({ stage, motion }: { stage: number; motion: Motion }) {
	const svgRef = useRef<SVGSVGElement>(null);
	const animations = useRef<Animation[]>([]);
	const isStatic = motion === "static";
	useLayoutEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		for (const path of svg.querySelectorAll<SVGPathElement>("[data-draw]")) path.style.strokeDasharray = "none";
		if (isStatic) return;
		const active: Animation[] = [];
		const animate = (element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
			const animation = element.animate(frames, { fill: "both", ...options });
			animation.pause();
			active.push(animation);
		};
		// Native SVG effects retain their painted frame on pause without a framework or generated global keyframes.
		for (const path of svg.querySelectorAll<SVGPathElement>(
			stage === 0 ? ".graph-lane [data-draw]" : ".graph-convergence.is-current [data-draw]",
		)) {
			const length = path.getTotalLength();
			path.style.strokeDasharray = String(length);
			animate(path, [{ strokeDashoffset: String(length) }, { strokeDashoffset: "0" }], {
				duration: 1400,
				easing: "cubic-bezier(.25,.65,.3,1)",
			});
		}
		for (const worker of svg.querySelectorAll(".graph-worker")) {
			const index = worker.parentElement?.classList.contains("lane-1") ? 1 : worker.parentElement?.classList.contains("lane-2") ? 2 : 0;
			animate(
				worker,
				[
					{ transform: "translateX(0)", opacity: 0, offset: 0 },
					{ opacity: 1, offset: 0.1 },
					{ opacity: 1, offset: 0.85 },
					{ transform: `translateX(${270 + index * 44}px)`, opacity: 0, offset: 1 },
				],
				{ duration: 3200, delay: stage === 0 ? 600 : 0, easing: "cubic-bezier(.35,0,.25,1)" },
			);
		}
		if (stage === 2) {
			const message = svg.querySelector(".graph-message");
			if (message)
				animate(
					message,
					[
						{ transform: "translateY(0)", opacity: 0, offset: 0 },
						{ opacity: 1, offset: 0.1 },
						{ transform: "translateY(112px)", opacity: 1, offset: 0.45 },
						{ transform: "translateY(112px)", opacity: 1, offset: 0.55 },
						{ transform: "translateY(0)", opacity: 1, offset: 0.9 },
						{ transform: "translateY(0)", opacity: 0, offset: 1 },
					],
					{ duration: 3600, easing: "cubic-bezier(.35,0,.25,1)" },
				);
		}
		for (const path of svg.querySelectorAll(".graph-alignment.is-current .graph-signal, .graph-upstream.is-current .graph-feed"))
			animate(path, [{ strokeDashoffset: "8" }, { strokeDashoffset: "0" }], { duration: 1100, iterations: stage === 2 ? 3 : 2 });
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
			else animation.pause();
		}
	}, [motion, stage, isStatic]);

	const accepted = acceptedCount(stage);
	const focused =
		stage === 0 || stage === 8 ? [0, 1, 2] : stage < 3 ? [0, 1] : stage === 3 ? [0] : stage === 4 ? [1, 2] : stage === 5 ? [1] : [2];
	const canonical = accepted ? exampleContributions[accepted - 1].headRevision : exampleBase;
	const head = (index: number) =>
		stage >= (index === 1 ? 4 : 6) && index > 0 ? exampleContributions[index].headRevision : exampleWorkspaces[index].headRevision;
	const reveal = (name: string, active: boolean, enters: number) =>
		`${name} graph-reveal${active ? " is-visible" : ""}${stage === enters ? " is-current" : ""}`;
	return (
		<div className={`crossing-graph graph-stage-${stage}`} data-canonical={canonical}>
			<div className="crossing-desktop-surface">
				<svg ref={svgRef} className="crossing-desktop" viewBox="0 0 620 440" fill="none" aria-hidden="true">
					<path className="graph-canonical" d="M40 55H594" />
					<circle className="graph-base" cx="78" cy="55" r="5" />
					<text x="40" y="30" className="graph-metadata">
						canonical / main
					</text>
					<text x={accepted ? mainDot(accepted - 1) : 538} y="30" textAnchor="middle" className="graph-metadata graph-canonical-head">
						{accepted > 0 ? short(canonical) : ""}
					</text>
					{exampleWorkspaces.map((w, i) => (
						<g
							key={w.id}
							data-head={head(i)}
							className={`graph-lane lane-${i}${i < accepted ? " is-accepted" : ""}${focused.includes(i) ? " is-focused" : ""}`}
						>
							<path data-draw="true" d={`M78 60V${100 + i * 112}Q78 ${laneY(i)} 138 ${laneY(i)}H${laneEnd(i)}`} />
							<circle className="graph-tip" cx={laneEnd(i)} cy={laneY(i)} r="4" />
							{i >= accepted && <circle key={stage} className="graph-worker" cx="138" cy={laneY(i)} r="3" />}
							<text x="155" y={122 + i * 112} className="graph-actor">
								{w.actor.name}
							</text>
							<text x="155" y={171 + i * 112} className="graph-task">
								{w.title}
							</text>
						</g>
					))}
					<g className={reveal("graph-overlap", stage === 1, 1)}>
						<path d="M321 139H310V265H321" />
					</g>
					<g className={reveal("graph-alignment", stage === 2, 2)}>
						<path className="graph-signal" d="M310 146V258" />
						<circle className="graph-message message-down" cx="310" cy="146" r="3" />
						<circle cx="310" cy="202" r="11" />
						<path className="graph-check" d="m305 202 4 4 6-8" />
					</g>
					<g className={reveal("graph-decision", stage === 2, 2)}>
						<path d="M321 202H426" />
						<circle cx="430" cy="202" r="4" />
						<text x="342" y="222" className="graph-metadata">
							if unresolved
						</text>
						<text x="444" y="206" className="graph-metadata">
							developer
						</text>
					</g>
					{exampleContributions.map((contribution, i) => {
						const enters = [3, 5, 7][i],
							x = laneEnd(i),
							bend = x + 46,
							dot = mainDot(i),
							y = laneY(i);
						return (
							<g
								key={contribution.id}
								data-workspace={contribution.id}
								data-revision={contribution.headRevision}
								className={reveal(`graph-convergence lane-${i}${focused.includes(i) ? " is-focused" : ""}`, i < accepted, enters)}
							>
								<path
									className="graph-trace"
									data-draw="true"
									d={`M${x} ${y}H${x + 10}Q${bend} ${y} ${bend} ${y - 36}V91Q${bend} 55 ${dot} 55`}
								/>
								<circle className="graph-accepted-dot" cx={dot} cy="55" r="5" />
								<text x={dot} y="78" textAnchor="middle" className="graph-metadata graph-dot-label">
									0{i + 1}
								</text>
							</g>
						);
					})}
					<g className={reveal("graph-upstream", stage === 4 || stage === 6, stage === 6 ? 6 : 4)}>
						{[1, 2].map((i) => (
							<path
								key={i}
								className={`graph-feed${stage === 6 && i === 1 ? " is-hidden" : ""}`}
								d={`M${mainDot(stage === 6 ? 1 : 0)} 55H${laneEnd(i) + 22}Q${laneEnd(i) + 30} 55 ${laneEnd(i) + 30} 71V${laneY(i) - 36}Q${laneEnd(i) + 30} ${laneY(i)} ${laneEnd(i)} ${laneY(i)}`}
							/>
						))}
					</g>
				</svg>
			</div>
			<div className="crossing-mobile" aria-hidden="true">
				<div className="mobile-canonical">canonical / main</div>
				<div className="mobile-mainline">
					{exampleContributions.map((contribution, i) => (
						<div key={contribution.id} className={`mobile-main-dot lane-${i}${i < accepted ? " is-accepted" : ""}`}>
							<span />
							{["Claude", "Codex", "Cursor"][i]}
							<code>{i === accepted - 1 ? short(contribution.headRevision) : ""}</code>
						</div>
					))}
				</div>
				{exampleWorkspaces.map((w, i) => (
					<div
						key={w.id}
						className={`mobile-graph-lane lane-${i}${i < accepted ? " is-accepted" : ""}${focused.includes(i) ? " is-focused" : ""}`}
					>
						<span>{w.actor.name}</span>
						<strong>{w.title}</strong>
					</div>
				))}
			</div>
		</div>
	);
}

function sequenceVisible(element: Element | null) {
	if (!element) return false;
	const box = element.getBoundingClientRect();
	const width = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
	const height = Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
	return box.width > 0 && box.height > 0 && (width * height) / (box.width * box.height) >= 0.2;
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
			{ threshold: 0.2 },
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
	const playbackLabel = reduced || (!playing && stage === durations.length - 1) ? "Replay" : playing ? "Pause" : "Play";
	return (
		<div className="hero-sequence" ref={ref} data-motion={motion}>
			<div className="sequence-caption">
				<span className="example-label">Coordination vision · illustrative</span>
				<div className="sequence-caption-meta">
					<code>fernloop / payment-api</code>
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
				</div>
			</div>
			<CrossingGraph key={replay} stage={stage} motion={motion} />
			<fieldset className="sequence-controls" aria-label="Development story stages">
				{chapters.map(({ name, label, stage: target }, i) => (
					<button key={name} type="button" aria-label={name} aria-pressed={currentChapter(stage) === i} onClick={() => select(target)}>
						<span className="sequence-stop" aria-hidden="true" />
						<span className="sequence-step-copy" key={currentChapter(stage) === i ? stage : name}>
							<span className="sequence-step-title">{currentChapter(stage) === i ? notes[stage].title : label}</span>
							{currentChapter(stage) === i && <span className="sequence-step-detail">{notes[stage].detail}</span>}
						</span>
					</button>
				))}
			</fieldset>
			<p className="landing-sr-only sequence-description" aria-live={playing ? "off" : "polite"}>
				{stageDescriptions[stage]}
			</p>
		</div>
	);
}

export function Landing() {
	useEffect(() => {
		document.title = `${BRAND.name} · Common ground for coding agents`;
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
			<header className="landing-header">
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
				<section className="landing-hero landing-wrap" aria-labelledby="hero-heading">
					<div className="hero-copy">
						<p className="landing-kicker">
							<span className="kicker-cross" aria-hidden="true">
								↗↘
							</span>{" "}
							Git-native coordination
						</p>
						<h1 id="hero-heading">
							Many agents.
							<br />
							One repository.
							<br />
							<em>Common ground.</em>
						</h1>
						<p className="hero-description">
							Keep your tools. {BRAND.name} gives concurrent coding agents shared context, exact revisions, and a deliberate path into
							canonical Git.
						</p>
						<p className="hero-aside">Independent paths. Shared direction.</p>
					</div>
					<HeroSequence />
				</section>
			</main>
			<footer className="landing-footer landing-wrap">
				<p>Coming soon · in early development.</p>
				<p>Being developed toward open source.</p>
			</footer>
		</div>
	);
}
