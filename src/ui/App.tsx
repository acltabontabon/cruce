import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useState } from "react";
import { PROJECTS } from "../shared/api.ts";
import { ContextPanel } from "./panels/Context.tsx";
import { FlightList } from "./panels/FlightList.tsx";
import { Header } from "./panels/Header.tsx";
import { History } from "./panels/History.tsx";
import { TowerLog } from "./panels/TowerLog.tsx";
import { Radar, type Selection } from "./radar/Radar.tsx";
import { post, useTower } from "./store.ts";
import "./styles.css";

function initialProject() {
	const fromUrl = new URLSearchParams(location.search).get("project");
	return PROJECTS.some((p) => p.id === fromUrl) ? (fromUrl as string) : "demo";
}

export function App() {
	const [projectId, setProjectId] = useState(initialProject);
	const tower = useTower(projectId);
	const [selection, setSelection] = useState<Selection>(null);
	const [hover, setHover] = useState<string | null>(null);
	const [history, setHistory] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [toast, setToast] = useState<string | null>(null);

	const switchProject = (id: string) => {
		setProjectId(id);
		setSelection(null);
		const url = new URL(location.href);
		url.searchParams.set("project", id);
		window.history.replaceState(null, "", url);
	};

	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(null), 4500);
		return () => clearTimeout(t);
	}, [toast]);

	const run = useCallback(async (fn: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await fn();
		} catch (e) {
			setToast((e as Error).message);
		} finally {
			setBusy(false);
		}
	}, []);

	const act = (cmd: Record<string, unknown>) => {
		const token =
			projectId === "live"
				? (localStorage.getItem("cruce.controllerToken") ?? prompt("Controller token for live operations") ?? "")
				: undefined;
		if (token) localStorage.setItem("cruce.controllerToken", token);
		run(() => post(`/api/projects/${projectId}/commands`, cmd, token));
	};

	const demo = (op: "play" | "pause" | "step" | "reset" | "speed", speed?: number) => {
		if (op === "reset") setSelection(null);
		run(() => post(`/api/projects/${projectId}/demo`, { op, speed }));
	};

	const state = tower.state;
	const selectedFlight = selection?.kind === "flight" ? selection.id : null;

	return (
		<ReactFlowProvider>
			<div className="app">
				{state ? (
					<>
						<Header
							state={state}
							git={tower.git}
							demo={tower.demo}
							connected={tower.connected}
							projects={PROJECTS}
							projectId={projectId}
							onProject={switchProject}
							onDemo={demo}
							onHistory={() => setHistory("canonical")}
							onAttention={() => setSelection(null)}
							busy={busy}
						/>
						<div className="body">
							<FlightList
								state={state}
								selected={selectedFlight}
								onSelect={(id) => setSelection({ kind: "flight", id })}
								onHover={setHover}
							/>
							<main className="center">
								<Radar state={state} selection={selection} hover={hover} onSelect={setSelection} onHover={setHover} />
								<TowerLog events={state.log} focusFlight={selectedFlight} onSelectFlight={(id) => setSelection({ kind: "flight", id })} />
							</main>
							<ContextPanel
								state={state}
								git={tower.git}
								selection={selection}
								onSelect={setSelection}
								act={act}
								busy={busy}
								onHistory={setHistory}
							/>
						</div>
					</>
				) : (
					<div className="boot">
						<div className="boot-mark" />
						<div>{tower.error ? `Cannot reach the control tower: ${tower.error}` : "Contacting the control tower…"}</div>
					</div>
				)}
				{history && state && (
					<History projectId={projectId} target={history} state={state} git={tower.git} onClose={() => setHistory(null)} />
				)}
				{toast && (
					<div className="toast" role="status">
						{toast}
					</div>
				)}
			</div>
		</ReactFlowProvider>
	);
}
