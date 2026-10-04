import { useCallback, useEffect, useRef, useState } from "react";
import { type DemoCommand, PROJECTS } from "../shared/api.ts";
import { Dialog, Icon } from "./components.tsx";
import { ContextPanel } from "./panels/Context.tsx";
import { Header } from "./panels/Header.tsx";
import { History } from "./panels/History.tsx";
import { Traffic } from "./panels/Traffic.tsx";
import { Work } from "./panels/Work.tsx";
import type { Selection } from "./radar/Radar.tsx";
import { post, useTower } from "./store.ts";
import "./styles.css";
import "./responsive.css";

type Route = { projectId: string; view: "work" | "traffic"; selection: Selection; attentionOnly: boolean };
export function readRoute(search = location.search): Route {
	const query = new URLSearchParams(search);
	const projectId = PROJECTS.some((p) => p.id === query.get("project")) ? (query.get("project") as string) : "demo";
	const run = query.get("run"),
		crossing = query.get("crossing"),
		scope = query.get("scope");
	return {
		projectId,
		view: query.get("view") === "traffic" ? "traffic" : "work",
		selection: run
			? { kind: "flight", id: run }
			: crossing
				? { kind: "congestion", key: crossing }
				: scope && /^(?:m:[^\s].*|f:[^\s].*|s:[^#\s][^#]*#[^#\s][^#]*)$/.test(scope)
					? { kind: "resource", id: scope }
					: null,
		attentionOnly: query.get("attention") === "1",
	};
}
export function App() {
	const [route, setRoute] = useState(readRoute);
	const tower = useTower(route.projectId);
	const [historyTarget, setHistoryTarget] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [preparing, setPreparing] = useState(false);
	const [toast, setToast] = useState<string | null>(null);
	const [connectionOpen, setConnectionOpen] = useState(false);
	const [token, setToken] = useState("");
	const [tokenInput, setTokenInput] = useState("");
	const prepared = useRef<string | null>(null);
	const currentProject = useRef(route.projectId);
	currentProject.current = route.projectId;
	const navigate = useCallback(
		(change: Partial<Route>) => {
			const next = { ...route, ...change };
			const url = new URL(location.href);
			url.search = "";
			url.searchParams.set("project", next.projectId);
			if (next.view !== "work") url.searchParams.set("view", next.view);
			if (next.selection?.kind === "flight") url.searchParams.set("run", next.selection.id);
			if (next.selection?.kind === "congestion") url.searchParams.set("crossing", next.selection.key);
			if (next.selection?.kind === "resource") url.searchParams.set("scope", next.selection.id);
			if (next.attentionOnly) url.searchParams.set("attention", "1");
			if (url.href !== location.href) window.history.pushState(null, "", url);
			setRoute(next);
			if (next.projectId !== route.projectId || next.view !== route.view || next.view === "work") {
				window.scrollTo({ top: 0 });
				requestAnimationFrame(() => document.getElementById("main-content")?.focus({ preventScroll: true }));
			}
		},
		[route],
	);
	useEffect(() => {
		const back = () => setRoute(readRoute());
		window.addEventListener("popstate", back);
		// Remove the old client’s persisted credential. New credentials live only in this session.
		localStorage.removeItem("cruce.controllerToken");
		return () => window.removeEventListener("popstate", back);
	}, []);
	useEffect(() => {
		if (currentProject.current !== route.projectId) return;
		setHistoryTarget(null);
		setToast(null);
		setPreparing(false);
		setPending(false);
	}, [route.projectId]);
	useEffect(() => {
		document.title = `Cruce · ${route.view === "work" ? "Work" : "Traffic"}`;
	}, [route.view]);
	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), 7000);
		return () => clearTimeout(timer);
	}, [toast]);
	useEffect(() => {
		if (
			tower.state?.project.id !== route.projectId ||
			tower.state.project.mode !== "demo" ||
			tower.state.flights.length ||
			(tower.demo?.next ?? 0) !== 0 ||
			prepared.current === route.projectId
		)
			return;
		const project = route.projectId;
		prepared.current = project;
		setPreparing(true);
		post(`/api/projects/${project}/demo`, { op: "prepare" })
			.catch((e) => {
				if (currentProject.current === project) setToast(e.message);
			})
			.finally(() => {
				if (currentProject.current === project) setPreparing(false);
			});
	}, [tower.state, tower.demo, route.projectId]);
	const run = async (fn: () => Promise<unknown>) => {
		const project = route.projectId;
		setPending(true);
		try {
			return await fn();
		} catch (e) {
			if (currentProject.current === project) setToast((e as Error).message);
			throw e;
		} finally {
			if (currentProject.current === project) setPending(false);
		}
	};
	const act = async (command: Record<string, unknown>) => {
		if (route.projectId === "live" && !token) {
			setConnectionOpen(true);
			throw new Error("Add your controller token, then try again. Your task has been kept.");
		}
		return run(() => post(`/api/projects/${route.projectId}/commands`, command, token || undefined));
	};
	const demo = (op: DemoCommand["op"], speed?: number) => {
		if (op === "reset" || op === "replay") navigate({ selection: null });
		void run(() => post(`/api/projects/${route.projectId}/demo`, { op, speed })).catch(() => {});
	};
	const state = tower.state?.project.id === route.projectId ? tower.state : null;
	const busy = pending || preparing || !tower.connected;
	return (
		<div className="app">
			<a href="#main-content" className="skip-link">
				Skip to content
			</a>
			{state ? (
				<>
					<Header
						state={state}
						demo={tower.demo}
						connected={tower.connected}
						projects={PROJECTS}
						projectId={route.projectId}
						view={route.view}
						busy={busy}
						onProject={(projectId) => navigate({ projectId, view: "work", selection: null, attentionOnly: false })}
						onView={(view) => navigate({ view, selection: null, attentionOnly: false })}
						onDemo={demo}
						onHistory={() => setHistoryTarget("canonical")}
						onConnection={() => setConnectionOpen(true)}
					/>
					<main id="main-content" className="main-content" tabIndex={-1}>
						{preparing && !state.flights.some((f) => f.plan) ? (
							<div className="preparing-demo">
								<span className="loading-dot" />
								<h1>Preparing the demo repository</h1>
								<p>Creating three workspaces and checking their plans.</p>
							</div>
						) : route.view === "traffic" ? (
							<Traffic
								key={route.projectId}
								state={state}
								git={tower.git}
								selection={route.selection}
								onSelect={(selection) => navigate({ selection })}
								onOpen={(selection) => navigate({ view: "work", selection })}
							/>
						) : route.selection ? (
							<div className="detail-page">
								<button type="button" className="back-link" onClick={() => navigate({ selection: null })}>
									<Icon name="back" size={15} />
									All work
								</button>
								<ContextPanel
									state={state}
									git={tower.git}
									projectId={route.projectId}
									selection={route.selection}
									onSelect={(selection) => navigate({ selection })}
									act={act}
									busy={busy}
									onHistory={setHistoryTarget}
									integrationBlockers={tower.integrationBlockers}
									onTraffic={() => navigate({ view: "traffic" })}
								/>
							</div>
						) : (
							<Work
								state={state}
								liveAgents={tower.liveAgents}
								busy={busy}
								attentionOnly={route.attentionOnly}
								onAttention={(attentionOnly) => navigate({ attentionOnly })}
								onSelect={(selection) => navigate({ selection })}
								onLaunch={(input) => act({ type: "launch", runtime: "sandbox", ...input })}
								act={act}
							/>
						)}
					</main>
					{historyTarget && (
						<History
							key={route.projectId + historyTarget}
							projectId={route.projectId}
							target={historyTarget}
							state={state}
							onClose={() => setHistoryTarget(null)}
						/>
					)}
				</>
			) : (
				<main className="boot" id="main-content">
					<span className="loading-dot" />
					<h1>{tower.error ? "Couldn’t connect" : "Opening your repository"}</h1>
					<p>{tower.error ?? "Connecting to Cruce…"}</p>
					{tower.error && (
						<button className="btn" type="button" onClick={() => location.reload()}>
							Try again
						</button>
					)}
				</main>
			)}
			{connectionOpen && (
				<Dialog
					title="Controller access"
					onClose={() => {
						setConnectionOpen(false);
						setTokenInput("");
					}}
				>
					<form
						className="connection-form"
						onSubmit={(e) => {
							e.preventDefault();
							setToken(tokenInput.trim());
							setTokenInput("");
							setConnectionOpen(false);
							setToast("Controller token set for this session.");
						}}
					>
						<p>Live operations require your controller token. It stays in memory for this browser session.</p>
						<label htmlFor="controller-token">Controller token</label>
						<input
							id="controller-token"
							type="password"
							autoComplete="off"
							value={tokenInput}
							onChange={(e) => setTokenInput(e.target.value)}
							required
						/>
						<div className="inline-actions">
							<button type="submit" className="btn primary" disabled={!tokenInput.trim()}>
								Use token
							</button>
							{token && (
								<button
									type="button"
									className="btn"
									onClick={() => {
										setToken("");
										setConnectionOpen(false);
									}}
								>
									Clear session access
								</button>
							)}
						</div>
					</form>
				</Dialog>
			)}
			{toast && (
				<div className="toast" role="status">
					<span>{toast}</span>
					<button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setToast(null)}>
						<Icon name="close" size={14} />
					</button>
				</div>
			)}
		</div>
	);
}
