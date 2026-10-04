import type { ControllerState } from "../../core/controller.ts";
import type { DemoStatus, GitInfo, ProjectMeta } from "../../shared/api.ts";
import { counts, short } from "../model.ts";

interface Props {
	state: ControllerState;
	git: GitInfo | null;
	demo: DemoStatus | null;
	connected: boolean;
	projects: ProjectMeta[];
	projectId: string;
	onProject(id: string): void;
	onDemo(op: "play" | "pause" | "step" | "reset" | "speed", speed?: number): void;
	onHistory(): void;
	onAttention(): void;
	busy: boolean;
}

export function Header({ state, git, demo, connected, projects, projectId, onProject, onDemo, onHistory, onAttention, busy }: Props) {
	const c = counts(state);
	const needs = c.attention;
	return (
		<header className="hdr">
			<div className="hdr-brand">
				<svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
					<path d="M6 22 L26 10" stroke="var(--clear)" strokeWidth="2.6" strokeLinecap="round" />
					<path d="M6 10 L26 22" stroke="var(--caution)" strokeWidth="2.6" strokeLinecap="round" />
					<circle cx="16" cy="16" r="3.4" fill="var(--bg)" stroke="var(--text)" strokeWidth="1.8" />
				</svg>
				<span className="hdr-name">cruce</span>
			</div>

			<div className="hdr-project">
				<select value={projectId} onChange={(e) => onProject(e.target.value)} aria-label="Project">
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</select>
				<button type="button" className="hdr-base" onClick={onHistory} title="Canonical history and Cruce notes">
					<span className="mono">main</span>
					<span className="hdr-at">@</span>
					<span className="mono">{short(state.canonical.head)}</span>
				</button>
				<span className={`hdr-backend ${git?.backend}`} title={git?.canonicalRemote ?? "local Git backend"}>
					{git?.backend === "artifacts" ? `Artifacts · ${git.namespace}` : "local git"}
				</span>
			</div>

			<div className="hdr-stats">
				<Stat value={c.active} label={c.active === 1 ? "flight active" : "flights active"} />
				<Stat value={c.congestion} label="congestion" tone={c.congestion ? "caution" : undefined} />
				<Stat value={c.holds} label={c.holds === 1 ? "hold" : "holds"} tone={c.holds ? "hold" : undefined} />
				<button type="button" className={`stat stat-btn ${needs ? "tone-collision" : ""}`} onClick={onAttention} disabled={!needs}>
					<span className="stat-v">{needs}</span>
					<span className="stat-l">{needs === 1 ? "decision required" : "decisions required"}</span>
				</button>
			</div>

			<div className="hdr-right">
				{demo && (
					<div className="demo">
						<div className="demo-progress" title={demo.error ?? demo.nextLabel ?? demo.lastLabel}>
							<div className="demo-bar">
								<div className="demo-fill" style={{ width: `${(demo.next / demo.total) * 100}%` }} />
							</div>
							<span className={`demo-label ${demo.error ? "err" : ""}`}>
								{demo.error ? `Paused: ${demo.error}` : demo.finished ? "Demo complete" : (demo.nextLabel ?? demo.lastLabel)}
							</span>
						</div>
						<div className="demo-buttons">
							{demo.running ? (
								<button type="button" onClick={() => onDemo("pause")} disabled={busy} title="Pause">
									<Icon d="M7 5h3v14H7zM14 5h3v14h-3z" />
								</button>
							) : (
								<button
									type="button"
									className="primary"
									onClick={() => onDemo("play")}
									disabled={busy}
									title={demo.finished ? "Replay" : "Play"}
								>
									<Icon d="M8 5l11 7-11 7z" />
								</button>
							)}
							<button type="button" onClick={() => onDemo("step")} disabled={busy || demo.finished} title="Next step">
								<Icon d="M6 5l9 7-9 7zM17 5h2v14h-2z" />
							</button>
							<button type="button" onClick={() => onDemo("reset")} disabled={busy} title="Reset demo">
								<Icon d="M5 12a7 7 0 1 0 2.05-4.95M5 4v4h4" stroke />
							</button>
							<select
								value={demo.speed}
								onChange={(e) => onDemo("speed", Number(e.target.value))}
								aria-label="Speed"
								className="demo-speed"
							>
								{[0.5, 1, 1.5, 2, 3].map((s) => (
									<option key={s} value={s}>
										{s}×
									</option>
								))}
							</select>
						</div>
					</div>
				)}
				<span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Live" : "Reconnecting…"} />
			</div>
		</header>
	);
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
	return (
		<div className={`stat ${tone ? `tone-${tone}` : ""}`}>
			<span className="stat-v">{value}</span>
			<span className="stat-l">{label}</span>
		</div>
	);
}

export function Icon({ d, stroke }: { d: string; stroke?: boolean }) {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
			<path
				d={d}
				fill={stroke ? "none" : "currentColor"}
				stroke={stroke ? "currentColor" : "none"}
				strokeWidth={stroke ? 2 : 0}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
