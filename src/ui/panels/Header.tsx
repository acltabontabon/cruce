import type { ControllerState } from "../../core/controller.ts";
import type { DemoCommand, DemoStatus, ProjectMeta } from "../../shared/api.ts";
import { Icon, Mark } from "../components.tsx";
import { short } from "../model.ts";

interface Props {
	state: ControllerState;
	demo: DemoStatus | null;
	connected: boolean;
	projects: ProjectMeta[];
	projectId: string;
	view: "work" | "traffic";
	busy: boolean;
	onProject(id: string): void;
	onView(view: "work" | "traffic"): void;
	onDemo(op: DemoCommand["op"], speed?: number): void;
	onHistory(): void;
}
export function Header({ state, demo, connected, projects, projectId, view, busy, onProject, onView, onDemo, onHistory }: Props) {
	return (
		<>
			<header className="app-header">
				<a
					className="brand"
					href="?project=demo"
					onClick={(e) => {
						e.preventDefault();
						onView("work");
					}}
					aria-label="Cruce work"
				>
					<Mark />
					<span>cruce</span>
				</a>
				<span className="header-separator" />
				<div className="repository-picker">
					<Icon name="repo" />
					<select value={projectId} onChange={(e) => onProject(e.target.value)} aria-label="Repository">
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</div>
				{state.project.mode === "demo" && <span className="demo-tag">Demo repository</span>}
				<div className="header-spacer" />
				<span className={`connection-state ${connected ? "connected" : ""}`}>
					<span />
					{connected ? "Live updates" : "Reconnecting"}
				</span>
			</header>
			<div className="navigation-bar">
				<nav aria-label="Primary">
					<button
						type="button"
						className={view === "work" ? "nav-item active" : "nav-item"}
						aria-current={view === "work" ? "page" : undefined}
						onClick={() => onView("work")}
					>
						<Icon name="work" />
						Work
					</button>
					<button
						type="button"
						className={view === "traffic" ? "nav-item active" : "nav-item"}
						aria-current={view === "traffic" ? "page" : undefined}
						onClick={() => onView("traffic")}
					>
						<Icon name="traffic" />
						Traffic
					</button>
				</nav>
				<button type="button" className="revision" onClick={onHistory} aria-label="View repository history">
					<Icon name="commit" />
					<span>{state.project.defaultBranch}</span>
					<span className="mono muted">{short(state.canonical.head)}</span>
				</button>
				{demo && (
					<div className="demo-controls">
						{demo.error && (
							<span className="demo-error" role="status">
								{demo.error}
							</span>
						)}
						<button
							type="button"
							className="btn small"
							disabled={busy}
							onClick={() => onDemo(demo.running ? "pause" : demo.finished ? "replay" : "play")}
						>
							<Icon name={demo.running ? "pause" : "play"} size={13} />
							{demo.running ? "Pause" : demo.finished ? "Replay" : "Continue demo"}
						</button>
						<details className="action-menu">
							<summary aria-label="Demo options">
								<Icon name="more" />
							</summary>
							<div className="menu-content">
								<button type="button" disabled={busy || demo.finished} onClick={() => onDemo("step")}>
									Next step
								</button>
								<button type="button" disabled={busy} onClick={() => onDemo("reset")}>
									Reset to overlap
								</button>
								<button type="button" disabled={busy} onClick={() => onDemo("replay")}>
									Replay from beginning
								</button>
								<label>
									Playback speed
									<select value={demo.speed} aria-label="Playback speed" onChange={(e) => onDemo("speed", Number(e.target.value))}>
										{[0.5, 1, 2, 3].map((speed) => (
											<option value={speed} key={speed}>
												{speed}×
											</option>
										))}
									</select>
								</label>
							</div>
						</details>
					</div>
				)}
			</div>
		</>
	);
}
