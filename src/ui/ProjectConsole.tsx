import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectConnection } from "../shared/coordination.ts";
import { Environments } from "./console/Environments.tsx";
import { Lineage } from "./console/Lineage.tsx";
import { type Execute, href, type Route, readRoute, request, type Unprovisioned, type View } from "./console/model.ts";
import { Overview } from "./console/Overview.tsx";
import { ProposalView } from "./console/ProposalView.tsx";
import { ArtifactView, MissionView } from "./console/Records.tsx";

/** The native Cruce console: missions, proposals, verification, promotion and lineage around exact revisions. */
export function ProjectConsole() {
	const [projects, setProjects] = useState<ProjectConnection[]>([]),
		[projectsLoaded, setProjectsLoaded] = useState(false),
		[selected, setSelected] = useState<string | null>(null),
		[view, setView] = useState<View | Unprovisioned | null>(null),
		[error, setError] = useState<string | null>(null),
		[route, setRoute] = useState<Route>(readRoute),
		[name, setName] = useState(""),
		[busy, setBusy] = useState(false);
	useEffect(() => {
		document.title = "Cruce";
		const change = () => {
			setRoute(readRoute());
			document.getElementById("main-content")?.focus({ preventScroll: true });
		};
		window.addEventListener("hashchange", change);
		return () => window.removeEventListener("hashchange", change);
	}, []);
	const currentProject = useRef(selected);
	currentProject.current = selected;
	const load = useCallback(async () => {
		if (!selected) return;
		try {
			const snapshot = await request<View | Unprovisioned>(`/api/projects/snapshot?projectId=${encodeURIComponent(selected)}`);
			if (currentProject.current !== selected) return;
			setView(snapshot);
			setError(null);
		} catch (e) {
			setError((e as Error).message);
		}
	}, [selected]);
	useEffect(() => {
		let current = true;
		void request<ProjectConnection[]>("/api/projects")
			.then((list) => {
				if (!current) return;
				setProjects(list);
				setSelected(list[0]?.id ?? null);
			})
			.catch((e) => current && setError(e.message))
			.finally(() => current && setProjectsLoaded(true));
		return () => {
			current = false;
		};
	}, []);
	useEffect(() => {
		setView(null);
		void load();
		const timer = setInterval(() => void load(), 15000);
		return () => clearInterval(timer);
	}, [load]);
	const execute: Execute = useCallback(
		async (input) => {
			if (!selected) throw new Error("Choose a project first");
			const result = await request("/api/projects/command", {
				...input,
				projectId: selected,
				...(input.tool.startsWith("get_") || input.tool === "read_artifact" || input.tool === "plan_rollback"
					? {}
					: { idempotencyKey: crypto.randomUUID() }),
			});
			if (!input.tool.startsWith("get_") && input.tool !== "read_artifact" && input.tool !== "plan_rollback") await load();
			return result;
		},
		[selected, load],
	);
	const ready = view?.provisioned ? view : null;
	return (
		<div className="app project-console">
			<a href="#main-content" className="skip-link">
				Skip to project
			</a>
			<header className="project-header">
				<a className="wordmark" href="#/">
					Cruce
					<span className="brand-dot" />
				</a>
				{ready && (
					<nav aria-label="Project" className="console-nav">
						<a href={href({ view: "overview" })} aria-current={route.view === "overview" ? "page" : undefined}>
							Overview
						</a>
						<a href={href({ view: "lineage" })} aria-current={route.view === "lineage" ? "page" : undefined}>
							Lineage
						</a>
						<a href={href({ view: "environments" })} aria-current={route.view === "environments" ? "page" : undefined}>
							Environments
						</a>
					</nav>
				)}
				<div className="spacer" />
				{projects.length > 0 && (
					<label className="project-selector">
						<span className="sr-only">Project</span>
						<select
							value={selected ?? ""}
							onChange={(e) => {
								setSelected(e.target.value);
								location.hash = "#/";
							}}
						>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
					</label>
				)}
				<a className="muted" href="/demo">
					Demo
				</a>
			</header>
			<main id="main-content" className="project-main" tabIndex={-1}>
				{error && selected && (
					<div className="console-error" role="alert">
						{error} <a href="/auth/login">Sign in</a>
					</div>
				)}
				{!selected && error && (
					<section className="console-empty">
						<h1>Sign in to Cruce.</h1>
						<p>Review what changed, why, whether you can trust it, and where it runs.</p>
						<a className="btn" href="/auth/login">
							Sign in
						</a>
						<details>
							<summary>Connection details</summary>
							<p role="alert">{error}</p>
						</details>
					</section>
				)}
				{!projectsLoaded && !error && (
					<p className="muted" role="status">
						Loading…
					</p>
				)}
				{projectsLoaded && !selected && !error && (
					<section className="console-empty">
						<h1>Create a project.</h1>
						<p>
							Each project gets a canonical Git repository in Cloudflare Artifacts. Agents keep working locally with Git and their own
							tools; Cruce adds missions, evidence, verification and promotion.
						</p>
						<form
							onSubmit={(e) => {
								e.preventDefault();
								setBusy(true);
								void request<ProjectConnection>("/api/projects", { name, idempotencyKey: crypto.randomUUID() })
									.then((p) => {
										setProjects([p]);
										setSelected(p.id);
										setName("");
									})
									.catch((e) => setError(e.message))
									.finally(() => setBusy(false));
							}}
						>
							<label>
								Project name
								<input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Payment service" />
							</label>
							<button type="submit" className="btn" disabled={busy}>
								{busy ? "Creating repository…" : "Create project"}
							</button>
							<p className="muted">Creating a project creates its Artifacts repository (Cloudflare Artifacts storage).</p>
						</form>
					</section>
				)}
				{selected && !view && !error && (
					<p role="status" className="muted">
						Loading source and activity…
					</p>
				)}
				{view && !view.provisioned && (
					<section className="console-empty">
						<h1>{view.project.name}</h1>
						<p>This project has no canonical repository yet. Reading a project never creates resources.</p>
						<button
							type="button"
							className="btn"
							disabled={busy}
							onClick={() => {
								setBusy(true);
								void request(`/api/projects/provision?projectId=${encodeURIComponent(view.project.id)}`, {})
									.then(load)
									.catch((e) => setError(e.message))
									.finally(() => setBusy(false));
							}}
						>
							Create Artifacts repository
						</button>
					</section>
				)}
				{ready && route.view === "overview" && <Overview view={ready} execute={execute} />}
				{ready && route.view === "proposal" && <ProposalView key={route.id} view={ready} id={route.id} execute={execute} />}
				{ready && route.view === "mission" && <MissionView view={ready} id={route.id} />}
				{ready && route.view === "artifact" && <ArtifactView key={route.id} view={ready} id={route.id} execute={execute} />}
				{ready && route.view === "lineage" && <Lineage view={ready} subject={route.subject} execute={execute} />}
				{ready && route.view === "environments" && <Environments view={ready} execute={execute} reload={load} />}
			</main>
		</div>
	);
}
