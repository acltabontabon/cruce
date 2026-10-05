import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type {
	Artifact,
	Command,
	Repository,
	RepositorySnapshot,
	ResourcePolicy,
	Team,
	User,
	Workspace,
	WorkspaceRole,
} from "../shared/platform.ts";
import { ArtifactInspection, Code } from "./inspect.tsx";
import "./styles.css";

const short = (s?: string) => s?.slice(0, 8) ?? "—";
const time = (n: number) => new Date(n).toLocaleString();
const tabs = ["overview", "code", "work", "artifacts", "deployments", "settings"];
type WorkspaceView = {
	repositorySummaries?: { id: string; active: number; overlaps: number; latestArtifact?: Artifact }[];
	activity?: { id: string; repositoryId: string; repositoryName: string; summary: string; at: number }[];
	workspace: Workspace;
	role: WorkspaceRole;
	repositories: Repository[];
	members: Record<string, WorkspaceRole>;
	people: { id: string; name: string; email: string }[];
	teams: Team[];
	policy: ResourcePolicy;
	account?: { accountId: string; label: string };
	permissions: { maintain: boolean; owner: boolean };
};
class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
async function request<T>(url: string, body?: unknown, method = body ? "POST" : "GET", signal?: AbortSignal): Promise<T> {
	const response = await fetch(url, {
		method,
		credentials: "same-origin",
		signal,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await response.json();
	if (!response.ok) throw new RequestError(response.status, data.error ?? "Request failed");
	return data;
}
function readRoute() {
	const query = new URLSearchParams(location.search),
		[tab, id] = location.hash.replace(/^#\/?/, "").split("/");
	return {
		workspaceId: query.get("workspace") ?? "",
		repositoryId: query.get("repository") ?? "",
		tab: tabs.includes(tab) ? tab : "overview",
		id: id ?? "",
	};
}
function Empty({ children }: { children: ReactNode }) {
	return <p className="empty">{children}</p>;
}
function Form({ submit, label, children }: { submit: (data: FormData) => Promise<unknown>; label: string; children: ReactNode }) {
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
	return (
		<form
			onSubmit={async (e: FormEvent<HTMLFormElement>) => {
				e.preventDefault();
				const form = e.currentTarget;
				setBusy(true);
				setError("");
				try {
					await submit(new FormData(form));
				} catch (e) {
					setError((e as Error).message);
				} finally {
					setBusy(false);
				}
			}}
		>
			{children}
			{error && <p role="alert">{error}</p>}
			<button disabled={busy} type="submit">
				{busy ? "Saving…" : label}
			</button>
		</form>
	);
}
const value = (d: FormData, key: string) => String(d.get(key) ?? "");
export function App() {
	const [route, setRoute] = useState(readRoute),
		[me, setMe] = useState<{ user: User; workspaces: Workspace[] }>(),
		[workspace, setWorkspace] = useState<WorkspaceView>(),
		[view, setView] = useState<RepositorySnapshot>(),
		[error, setError] = useState<Error>(),
		[notice, setNotice] = useState(""),
		[refresh, setRefresh] = useState(0),
		[finder, setFinder] = useState(false),
		[search, setSearch] = useState(""),
		[catalog, setCatalog] = useState<{ workspace: Workspace; repository: Repository }[]>([]),
		[workspaceTab, setWorkspaceTab] = useState("repositories");
	const retries = useRef(new Map<string, string>()),
		generation = useRef(0),
		[busy, setBusy] = useState(false);
	const reload = useCallback(() => setRefresh((n) => n + 1), []);
	const navigate = useCallback((workspaceId: string, repositoryId = "", tab = "overview", id = "") => {
		const url = new URL(location.href);
		url.pathname = "/";
		url.search = "";
		url.searchParams.set("workspace", workspaceId);
		if (repositoryId) url.searchParams.set("repository", repositoryId);
		url.hash = `/${tab}${id ? `/${id}` : ""}`;
		const previous = readRoute();
		history.pushState(null, "", url);
		if (previous.workspaceId !== workspaceId || previous.repositoryId !== repositoryId) {
			generation.current++;
			setView(undefined);
		}
		setNotice("");
		setError(undefined);
		setRoute(readRoute());
		setFinder(false);
	}, []);
	useEffect(() => {
		const change = () => {
			generation.current++;
			setRoute(readRoute());
			setNotice("");
		};
		const key = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setFinder((v) => !v);
			}
			if (e.key === "Escape") setFinder(false);
		};
		window.addEventListener("popstate", change);
		window.addEventListener("hashchange", change);
		window.addEventListener("keydown", key);
		return () => {
			window.removeEventListener("popstate", change);
			window.removeEventListener("hashchange", change);
			window.removeEventListener("keydown", key);
		};
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		void request<{ user: User; workspaces: Workspace[] }>("/api/me", undefined, "GET", controller.signal)
			.then((data) => {
				setMe(data);
				if (!readRoute().workspaceId) setRoute((r) => ({ ...r, workspaceId: data.user.personalWorkspaceId }));
			})
			.catch((e) => {
				if (e.name !== "AbortError") setError(e);
			});
		return () => controller.abort();
	}, []);
	useEffect(() => {
		if (!route.workspaceId) return;
		void refresh; // Explicit invalidation after a successful mutation.
		const controller = new AbortController();
		setWorkspace(undefined);
		const load = () =>
			request<WorkspaceView>(`/api/workspaces/${route.workspaceId}`, undefined, "GET", controller.signal)
				.then((data) => {
					if (!controller.signal.aborted) setWorkspace(data);
				})
				.catch((e) => {
					if (e.name !== "AbortError") setError(e);
				});
		void load();
		const timer = setInterval(() => void load(), 15000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [route.workspaceId, refresh]);
	useEffect(() => {
		if (!route.repositoryId || !route.workspaceId) {
			setView(undefined);
			return;
		}
		void refresh; // Explicit invalidation after a successful mutation.
		const controller = new AbortController(),
			ticket = ++generation.current;
		const load = () =>
			request<RepositorySnapshot>(
				`/api/workspaces/${route.workspaceId}/repositories/${route.repositoryId}`,
				undefined,
				"GET",
				controller.signal,
			)
				.then((data) => {
					if (generation.current === ticket) {
						setView(data);
						setError(undefined);
					}
				})
				.catch((e) => {
					if (e.name !== "AbortError" && generation.current === ticket) {
						setError(e);
						if (e.status === 401 || e.status === 403) setView(undefined);
					}
				});
		void load();
		const timer = setInterval(() => void load(), 15000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [route.workspaceId, route.repositoryId, refresh]);
	useEffect(() => {
		if (!finder || !me) return;
		let active = true;
		void Promise.all(
			me.workspaces.map(async (w) => {
				try {
					return (await request<Repository[]>(`/api/workspaces/${w.id}/repositories`)).map((repository) => ({ workspace: w, repository }));
				} catch {
					return [];
				}
			}),
		).then((rows) => {
			if (active) setCatalog(rows.flat());
		});
		return () => {
			active = false;
		};
	}, [finder, me]);
	const mutate = async <T,>(url: string, body: Record<string, unknown>, method = "POST") => {
		const fingerprint = JSON.stringify({ url, body, method }),
			key = retries.current.get(fingerprint) ?? crypto.randomUUID();
		retries.current.set(fingerprint, key);
		const result = await request<T>(
			url,
			{
				...body,
				...(method === "POST" && (body.tool || url.endsWith("repositories") || url === "/api/workspaces") ? { idempotencyKey: key } : {}),
			},
			method,
		);
		retries.current.delete(fingerprint);
		reload();
		return result;
	};
	const execute = async (command: Partial<Command> & { tool: string }) => {
		if (!view) throw new Error("Repository unavailable");
		const url = `/api/workspaces/${route.workspaceId}/repositories/${route.repositoryId}/command`;
		if (command.tool.startsWith("get_") || command.tool === "read_artifact") return request(url, command);
		setBusy(true);
		try {
			const result = await mutate(url, command);
			setNotice("Saved.");
			return result;
		} finally {
			setBusy(false);
		}
	};
	const base = `/api/workspaces/${route.workspaceId}`;
	if (!me)
		return (
			<main className="welcome">
				<strong>Cruce</strong>
				<h1>{error ? "Sign in to Cruce" : "Loading Cruce…"}</h1>
				{error && (
					<>
						<p>{error.message}</p>
						<a href="/auth/login">Sign in</a>
					</>
				)}
			</main>
		);
	if (location.pathname.startsWith("/invite/"))
		return (
			<main className="welcome">
				<h1>Join workspace</h1>
				<Form
					label="Accept invitation"
					submit={async () => {
						const workspaceId = location.pathname.split("/")[2];
						await request(`/api/workspaces/${workspaceId}/accept`, { token: location.hash.slice(1) });
						location.href = `/?workspace=${workspaceId}`;
					}}
				>
					<p>Signed in as {me.user.email}. This invitation must match your verified email.</p>
				</Form>
			</main>
		);
	return (
		<div className="shell">
			<a className="skip" href="#content">
				Skip to content
			</a>
			<aside>
				<a className="brand" href="/">
					Cruce <span>α</span>
				</a>
				<label>
					Workspace
					<select
						aria-label="Workspace"
						value={route.workspaceId}
						onChange={(e) => {
							setWorkspaceTab("repositories");
							navigate(e.target.value);
						}}
					>
						{me.workspaces.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name}
								{w.kind === "personal" ? " · Personal" : ""}
							</option>
						))}
					</select>
				</label>
				<button type="button" className="finder-trigger" onClick={() => setFinder(true)}>
					Find repository <kbd>⌘K</kbd>
				</button>
				<nav aria-label="Workspace navigation">
					{["repositories", ...(workspace?.workspace.kind === "shared" ? ["members", "teams"] : []), "settings"].map((tab) => (
						<button
							type="button"
							key={tab}
							className={!route.repositoryId && workspaceTab === tab ? "selected" : ""}
							onClick={() => {
								setWorkspaceTab(tab);
								navigate(route.workspaceId);
							}}
						>
							{tab}
						</button>
					))}
				</nav>
				<div className="sidebar-bottom">
					<details>
						<summary>Create workspace</summary>
						<Form
							label="Create workspace"
							submit={async (d) => {
								const w = await mutate<Workspace>("/api/workspaces", { name: value(d, "name"), handle: value(d, "handle") });
								setMe({ ...me, workspaces: [...me.workspaces, w] });
								navigate(w.id);
							}}
						>
							<label>
								Name
								<input name="name" required />
							</label>
							<label>
								Workspace handle
								<input name="handle" required pattern="[a-z0-9-]+" />
							</label>
						</Form>
					</details>
					<details>
						<summary>{me.user.name} · Account</summary>
						<p>{me.user.email}</p>
						<p>Authentication: Cloudflare Access</p>
						<a href="/auth/logout">Sign out</a>
					</details>
				</div>
			</aside>
			<main id="content" tabIndex={-1}>
				<header>
					<div className="breadcrumb">
						<button type="button" onClick={() => navigate(route.workspaceId)}>
							{workspace?.workspace.handle ?? "Workspace"}
						</button>
						{view && (
							<>
								{" "}
								/ <strong>{view.repository.name}</strong>
							</>
						)}
					</div>
					<span className="muted">
						{view
							? view.repository.source.kind === "local"
								? "Local Git · reported observations"
								: "Artifacts hosted Git"
							: "Private workspace"}
					</span>
				</header>
				{error && (
					<div role="alert" className="alert">
						{error.message}
						<button type="button" onClick={reload}>
							Retry
						</button>
					</div>
				)}
				{notice && <p role="status">{notice}</p>}
				{route.repositoryId ? (
					<>
						<nav className="tabs" aria-label="Repository navigation">
							{tabs.map((tab) => (
								<button
									type="button"
									key={tab}
									className={route.tab === tab ? "selected" : ""}
									onClick={() => navigate(route.workspaceId, route.repositoryId, tab)}
								>
									{tab}
								</button>
							))}
						</nav>
						{view ? (
							<>
								{route.tab === "overview" && (
									<>
										<div className="page-title">
											<h1>{view.repository.name}</h1>
											<code>
												{view.repository.defaultBranch} · {short(view.sourceHead ?? view.refs.at(-1)?.revision)}
											</code>
										</div>
										<div className="status-strip">
											<span>{view.sessions.filter((s) => s.state === "active").length} active sessions</span>
											<span>{view.overlaps.length} overlaps</span>
											<span>{view.artifacts.length} artifacts</span>
										</div>
										<h2>Active work</h2>
										<Sessions view={view} open={(id) => navigate(route.workspaceId, route.repositoryId, "work", id)} />
										<Overlaps view={view} />
										<div className="columns">
											<section>
												<h2>Latest artifact</h2>
												{view.artifacts.length ? (
													<ArtifactRow
														artifact={view.artifacts.at(-1)!}
														open={(id) => navigate(route.workspaceId, route.repositoryId, "artifacts", id)}
													/>
												) : (
													<Empty>No artifacts published yet.</Empty>
												)}
											</section>
											<section>
												<h2>Environments</h2>
												{!view.environments.length && <Empty>No deployment environments configured.</Empty>}
												{view.environments.map((env) => {
													const live = view.deployments.filter((d) => d.environmentId === env.id && d.state === "deployed").at(-1);
													return (
														<p key={env.id}>
															{env.name} <code>{live ? short(live.revision) : "Not deployed"}</code>
														</p>
													);
												})}
											</section>
										</div>
										<Activity view={view} />
									</>
								)}
								{route.tab === "work" && (
									<>
										<h1>Work</h1>
										<Sessions view={view} open={(id) => navigate(route.workspaceId, route.repositoryId, "work", id)} all />
										<Overlaps view={view} />
										{route.id && view.sessions.find((s) => s.id === route.id) && <SessionDetail view={view} id={route.id} />}
										<h2>Changes</h2>
										{!view.proposals.length && (
											<Empty>No changes proposed. Publish committed source from a session to request review.</Empty>
										)}
										{view.proposals.map((p) => (
											<details key={p.id} open={route.id === p.id}>
												<summary>
													#{p.number} {p.title} <code>{short(p.revision)}</code> · {p.state}
												</summary>
												<p>
													Base <code>{short(p.base)}</code> → <code>{short(p.revision)}</code>
												</p>
												<p>{view.readiness[p.id]?.reasons.join(" · ") || "Ready for human promotion"}</p>
												<button type="button" onClick={() => navigate(route.workspaceId, route.repositoryId, "code", p.id)}>
													Inspect diff
												</button>
												{p.reviews.map((r, i) => (
													<div key={r.id} className="record">
														<p>
															{r.actor.name} · {r.outcome} · {r.reason}
														</p>
														{r.resolution ? (
															<p>
																Resolved by {r.resolution.actor.name}: {r.resolution.reason}
															</p>
														) : (
															r.outcome !== "approve" &&
															view.permissions.maintain && (
																<Form
																	label="Resolve concern"
																	submit={(d) =>
																		execute({ tool: "resolve_review", proposalId: p.id, reviewIndex: i, reason: value(d, "reason") })
																	}
																>
																	<label>
																		Resolution reason
																		<input name="reason" required />
																	</label>
																</Form>
															)
														)}
													</div>
												))}
												{view.permissions.write && p.state === "open" && (
													<Form
														label="Submit review"
														submit={(d) =>
															execute({
																tool: "review_proposal",
																proposalId: p.id,
																revision: p.revision,
																outcome: value(d, "outcome") as "approve",
																reason: value(d, "reason"),
															})
														}
													>
														<label>
															Review
															<select name="outcome">
																<option value="approve">Approve</option>
																<option value="concern">Concern</option>
																<option value="disagree">Disagree</option>
															</select>
														</label>
														<label>
															Reason
															<input name="reason" required />
														</label>
													</Form>
												)}
												{view.permissions.maintain && p.state === "open" && (
													<>
														<Form
															label="Attest verification"
															submit={(d) =>
																execute({
																	tool: "record_verification",
																	proposalId: p.id,
																	revision: p.revision,
																	kind: value(d, "kind"),
																	outcome: value(d, "outcome") as "pass",
																	reason: value(d, "reason"),
																	humanAttested: true,
																})
															}
														>
															<label>
																Kind
																<input name="kind" defaultValue="tests" required />
															</label>
															<label>
																Outcome
																<select name="outcome">
																	<option value="pass">Pass</option>
																	<option value="fail">Fail</option>
																</select>
															</label>
															<label>
																What you inspected
																<input name="reason" required />
															</label>
														</Form>
														{view.repository.source.kind === "artifacts" ? (
															<button
																type="button"
																disabled={busy || !view.readiness[p.id]?.ready}
																onClick={() => void execute({ tool: "promote_proposal", proposalId: p.id }).catch((e) => setError(e))}
															>
																Promote source
															</button>
														) : (
															<p>After approval, merge and push with normal Git. Cruce records the observed ref separately.</p>
														)}
													</>
												)}
											</details>
										))}
									</>
								)}
								{route.tab === "code" && (
									<Code key={`${view.repository.id}-${route.id}`} view={view} execute={execute} proposalId={route.id} />
								)}
								{route.tab === "artifacts" && (
									<>
										<h1>Artifacts</h1>
										{!view.artifacts.length && (
											<Empty>No artifacts yet. Publish exact committed source or evidence from your session.</Empty>
										)}
										{view.artifacts.map((a) => (
											<ArtifactRow
												key={a.id}
												artifact={a}
												open={(id) => navigate(route.workspaceId, route.repositoryId, "artifacts", id)}
											/>
										))}
										{route.id && <ArtifactDetail key={route.id} id={route.id} view={view} execute={execute} />}
									</>
								)}
								{route.tab === "deployments" && (
									<>
										<h1>Deployments</h1>
										<p className="muted">Deployments consume immutable source artifacts. Build output is shown only when captured.</p>
										{!view.environments.length && (
											<Empty>
												No environments configured. Connect Cloudflare in workspace settings, then configure an environment here.
											</Empty>
										)}
										{view.environments.map((env) => (
											<section key={env.id}>
												<h2>
													{env.name} <small>{env.kind}</small>
												</h2>
												<p>
													Worker <code>{env.workerName}</code> · deployment repository <code>{env.deployRepository}</code>
												</p>
												<p className="muted">Connect this repository to Workers Builds in Cloudflare. Production branch: main.</p>
												{view.permissions.write && (env.kind === "preview" || view.permissions.maintain) && (
													<Form
														label={env.kind === "production" ? "Deploy to production" : "Request preview"}
														submit={(d) =>
															execute({
																tool: env.kind === "production" ? "deploy_artifact" : "request_preview",
																environmentId: env.id,
																artifactId: value(d, "artifactId"),
															})
														}
													>
														<label>
															Source artifact
															<select name="artifactId" required>
																<option value="">Choose artifact</option>
																{view.artifacts
																	.filter((a) => a.kind === "source")
																	.map((a) => (
																		<option key={a.id} value={a.id}>
																			{a.title} · {short(a.revision)}
																		</option>
																	))}
															</select>
														</label>
														<p className="cost">Consumes Cloudflare build and deployment resources under workspace policy.</p>
													</Form>
												)}
												{view.deployments
													.filter((d) => d.environmentId === env.id)
													.toReversed()
													.map((d) => (
														<div key={d.id} className="record">
															<strong>{d.state}</strong> <code>{short(d.revision)}</code>
															<p>
																{d.actor.name} · {time(d.at)} · artifact{" "}
																<button
																	type="button"
																	onClick={() => navigate(route.workspaceId, route.repositoryId, "artifacts", d.artifactId)}
																>
																	{short(d.artifactId)}
																</button>
															</p>
															{d.url && (
																<a href={d.url} target="_blank" rel="noreferrer">
																	Open deployment
																</a>
															)}
															<p>
																Build {d.buildId ?? "not observed"} · runtime version {d.runtimeVersion ?? "not observed"}
															</p>
															<p>Last observed {time(d.updatedAt)}</p>
															{d.error && <p role="alert">{d.error}</p>}
															{d.smoke && <p>Runtime smoke checks {d.smoke.ok ? "passed" : "failed"}</p>}
															{d.state === "deployed" && view.permissions.maintain && (
																<button
																	type="button"
																	disabled={busy}
																	onClick={() =>
																		void execute({
																			tool: "deploy_artifact",
																			artifactId: d.artifactId,
																			environmentId: env.id,
																			deploymentId: d.id,
																		}).catch((e) => setError(e))
																	}
																>
																	Redeploy this artifact
																</button>
															)}
														</div>
													))}
											</section>
										))}
										{view.permissions.maintain && (
											<details>
												<summary>Configure environment</summary>
												<Form
													label="Save environment"
													submit={(d) =>
														execute({
															tool: "configure_environment",
															environment: {
																name: value(d, "name"),
																kind: value(d, "kind") as "preview",
																workerName: value(d, "workerName"),
																smokeChecks: [{ path: "/", expectStatus: 200 }],
															},
														})
													}
												>
													<label>
														Name
														<input name="name" required />
													</label>
													<label>
														Kind
														<select name="kind">
															<option value="preview">Preview / staging</option>
															<option value="production">Production</option>
														</select>
													</label>
													<label>
														Cloudflare Worker
														<input name="workerName" required pattern="[a-z0-9-]+" />
													</label>
												</Form>
											</details>
										)}
									</>
								)}
								{route.tab === "settings" && (
									<>
										<h1>Repository settings</h1>
										<p>
											<code>{view.repository.id}</code> · {view.repository.source.kind}
										</p>
										<h2>Connect your checkout</h2>
										<pre>{`node /path/to/cruce/runner/cruce.mjs connect --workspace ${route.workspaceId} --repository ${route.repositoryId} --server ${location.origin} --client codex`}</pre>
										<p>
											For a human session, use <code>human</code> instead of <code>connect</code>, then{" "}
											<code>start --title "Your work"</code>.
										</p>
										{view.permissions.maintain && workspace && (
											<>
												<Form
													label="Rename repository"
													submit={(d) => mutate(`${base}/repositories/${route.repositoryId}`, { name: value(d, "name") }, "PATCH")}
												>
													<label>
														Repository name
														<input name="name" defaultValue={view.repository.name} required />
													</label>
												</Form>
												<h2>Repository access</h2>
												{view.repository.grants.map((g) => (
													<p key={`${g.subject}:${g.id}`}>
														{g.subject}:{" "}
														{workspace.people.find((p) => p.id === g.id)?.name ?? workspace.teams.find((t) => t.id === g.id)?.name ?? g.id}{" "}
														· {g.role}{" "}
														<button
															type="button"
															onClick={() =>
																void mutate(
																	`${base}/repositories/${route.repositoryId}`,
																	{ grants: view.repository.grants.filter((x) => x !== g) },
																	"PATCH",
																).catch(setError)
															}
														>
															Remove
														</button>
													</p>
												))}
												<Form
													label="Grant access"
													submit={(d) => {
														const [subject, id] = value(d, "subject").split(":");
														return mutate(
															`${base}/repositories/${route.repositoryId}`,
															{
																grants: [
																	...view.repository.grants.filter((g) => g.subject !== subject || g.id !== id),
																	{ subject, id, role: value(d, "role") },
																],
															},
															"PATCH",
														);
													}}
												>
													<label>
														Member or team
														<select name="subject">
															{workspace.people.map((p) => (
																<option key={p.id} value={`user:${p.id}`}>
																	{p.name}
																</option>
															))}
															{workspace.teams.map((t) => (
																<option key={t.id} value={`team:${t.id}`}>
																	Team: {t.name}
																</option>
															))}
														</select>
													</label>
													<label>
														Access
														<select name="role">
															<option value="read">Read</option>
															<option value="write">Write</option>
															<option value="maintain">Maintain</option>
														</select>
													</label>
												</Form>
												<Form
													label="Save repository policy"
													submit={(d) =>
														mutate(
															`${base}/repositories/${route.repositoryId}`,
															{
																policy: {
																	...view.repository.policy,
																	protectedPaths: value(d, "paths").split("\n").filter(Boolean),
																	requiredEvidence: value(d, "evidence")
																		.split(",")
																		.map((s) => s.trim())
																		.filter(Boolean),
																},
															},
															"PATCH",
														)
													}
												>
													<label>
														Protected paths, one per line
														<textarea name="paths" defaultValue={view.repository.policy.protectedPaths.join("\n")} />
													</label>
													<label>
														Required evidence kinds
														<input name="evidence" defaultValue={view.repository.policy.requiredEvidence.join(",")} />
													</label>
												</Form>
											</>
										)}
									</>
								)}
							</>
						) : (
							<Empty>Loading repository…</Empty>
						)}
					</>
				) : workspace ? (
					<>
						<div className="page-title">
							<div>
								<p className="eyebrow">{workspace.workspace.kind} workspace</p>
								<h1>{workspace.workspace.name}</h1>
							</div>
						</div>
						{workspaceTab === "repositories" && (
							<>
								<h2>Repositories</h2>
								{workspace.repositories.length ? (
									<div className="repo-list">
										{workspace.repositories.map((r) => (
											<button type="button" key={r.id} onClick={() => navigate(workspace.workspace.id, r.id)}>
												<strong>{r.name}</strong>
												<span>
													{r.source.kind === "local" ? "Local Git" : "Artifacts"} · {r.defaultBranch}
													{workspace.repositorySummaries?.find((s) => s.id === r.id) && (
														<small>
															{workspace.repositorySummaries.find((s) => s.id === r.id)!.active} active sessions ·{" "}
															{workspace.repositorySummaries.find((s) => s.id === r.id)!.overlaps} overlaps
														</small>
													)}
												</span>
												<span>→</span>
											</button>
										))}
									</div>
								) : (
									<Empty>No repositories yet. Open local Git to coordinate developers and agents.</Empty>
								)}
								{workspace.activity?.length ? (
									<section>
										<h2>Recent activity</h2>
										<ol className="activity">
											{workspace.activity.map((e) => (
												<li key={`${e.repositoryId}:${e.id}`}>
													<time>{time(e.at)}</time>
													<span>
														<button type="button" onClick={() => navigate(workspace.workspace.id, e.repositoryId)}>
															{e.repositoryName}
														</button>{" "}
														{e.summary}
													</span>
												</li>
											))}
										</ol>
									</section>
								) : null}
								{workspace.permissions.maintain && (
									<details>
										<summary>New repository</summary>
										<Form
											label="Add repository"
											submit={async (d) => {
												const repo = await mutate<Repository>(`${base}/repositories`, {
													name: value(d, "name"),
													source: value(d, "source"),
													defaultBranch: value(d, "branch"),
												});
												navigate(workspace.workspace.id, repo.id);
											}}
										>
											<label>
												Repository name
												<input name="name" required pattern="[a-z0-9-]+" />
											</label>
											<label>
												Source
												<select name="source">
													<option value="local">Open local repository</option>
													<option value="artifacts">Create Artifacts repository</option>
												</select>
											</label>
											<label>
												Default branch
												<input name="branch" defaultValue="main" required />
											</label>
											<p className="muted">
												Local Git keeps its existing remote. Artifacts creation requires a connected workspace account and consumes storage
												resources.
											</p>
										</Form>
									</details>
								)}
							</>
						)}
						{workspaceTab === "members" && (
							<>
								<h2>Members</h2>
								{workspace.people.map((p) => (
									<div className="record" key={p.id}>
										<strong>{p.name}</strong> {p.email} · {workspace.members[p.id]}
										{workspace.permissions.maintain && workspace.members[p.id] !== "owner" && (
											<Form
												label="Update member"
												submit={(d) =>
													mutate(`${base}/members`, { userId: p.id, ...(value(d, "role") === "remove" ? {} : { role: value(d, "role") }) })
												}
											>
												<label>
													Workspace role
													<select name="role" defaultValue={workspace.members[p.id]}>
														<option value="viewer">Viewer</option>
														<option value="developer">Developer</option>
														{workspace.permissions.owner && <option value="maintainer">Maintainer</option>}
														<option value="remove">Remove member</option>
													</select>
												</label>
											</Form>
										)}
									</div>
								))}
								{workspace.permissions.maintain && (
									<Form
										label="Create invitation link"
										submit={async (d) => {
											const result = await mutate<{ url: string }>(`${base}/invitations`, {
												email: value(d, "email"),
												role: value(d, "role"),
											});
											setNotice(result.url);
										}}
									>
										<label>
											Email
											<input name="email" type="email" required />
										</label>
										<label>
											Role
											<select name="role">
												<option value="developer">Developer</option>
												<option value="viewer">Viewer</option>
												{workspace.permissions.owner && <option value="maintainer">Maintainer</option>}
											</select>
										</label>
									</Form>
								)}
							</>
						)}
						{workspaceTab === "teams" && (
							<>
								<h2>Teams</h2>
								{!workspace.teams.length && <Empty>No teams yet. Teams group workspace members for repository access.</Empty>}
								{[...workspace.teams, { id: "", name: "", members: [] }].map((t) => (
									<TeamForm key={t.id || "new"} team={t} workspace={workspace} save={(body) => mutate(`${base}/teams`, body)} />
								))}
							</>
						)}
						{workspaceTab === "settings" && (
							<>
								<h2>Workspace settings</h2>
								{workspace.permissions.maintain && (
									<Form
										label="Save workspace"
										submit={async (d) => {
											const w = await mutate<Workspace>(base, { name: value(d, "name"), handle: value(d, "handle") }, "PATCH");
											setMe({ ...me, workspaces: me.workspaces.map((old) => (old.id === w.id ? w : old)) });
										}}
									>
										<label>
											Name
											<input name="name" defaultValue={workspace.workspace.name} required />
										</label>
										<label>
											Handle
											<input name="handle" defaultValue={workspace.workspace.handle} required />
										</label>
									</Form>
								)}
								<h2>Cloudflare account</h2>
								<p>
									{workspace.account
										? `${workspace.account.label} · ${workspace.account.accountId}`
										: "Not connected. Local Git coordination works without Cloudflare resources."}
								</p>
								{workspace.permissions.owner && (
									<Form
										label="Connect account"
										submit={(d) =>
											mutate(`${base}/account`, { accountId: value(d, "accountId"), token: value(d, "token"), label: value(d, "label") })
										}
									>
										<label>
											Label
											<input name="label" required />
										</label>
										<label>
											Account ID
											<input name="accountId" required autoComplete="off" />
										</label>
										<label>
											API token
											<input name="token" type="password" required autoComplete="off" />
										</label>
										<p className="muted">Credentials are sealed and never returned to agents.</p>
									</Form>
								)}
								{workspace.permissions.maintain && (
									<Form
										label="Save resource policy"
										submit={(d) =>
											mutate(`${base}/policy`, {
												dailyLimit: Number(value(d, "dailyLimit")),
												previewsPerSession: Number(value(d, "previewsPerSession")),
												rules: Object.fromEntries(Object.keys(workspace.policy.rules).map((key) => [key, value(d, key)])),
											})
										}
									>
										<h2>Shared resource budgets</h2>
										<label>
											Daily operations
											<input name="dailyLimit" type="number" min="0" max="10000" defaultValue={workspace.policy.dailyLimit} />
										</label>
										<label>
											Previews per session
											<input
												name="previewsPerSession"
												type="number"
												min="0"
												max="1000"
												defaultValue={workspace.policy.previewsPerSession}
											/>
										</label>
										{Object.entries(workspace.policy.rules).map(([key, rule]) => (
											<label key={key}>
												{key}
												<select name={key} defaultValue={rule}>
													{key !== "production.deploy" && <option value="allow">Allow</option>}
													<option value="approval">Human approval</option>
													<option value="deny">Deny</option>
												</select>
											</label>
										))}
									</Form>
								)}
							</>
						)}
					</>
				) : (
					<Empty>Loading workspace…</Empty>
				)}
			</main>
			{finder && (
				<div className="modal-backdrop">
					<section
						role="dialog"
						aria-modal="true"
						aria-label="Find repository"
						className="finder"
						onKeyDown={(e) => {
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("input,button"));
								const current = items.indexOf(document.activeElement as HTMLElement);
								items[(current + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
							}
						}}
					>
						<label>
							Find repository
							<input
								ref={(node) => {
									node?.focus();
								}}
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="workspace/repository"
							/>
						</label>
						{catalog
							.filter((r) => `${r.workspace.handle}/${r.repository.name}`.includes(search.toLowerCase()))
							.map((r) => (
								<button type="button" key={r.repository.id} onClick={() => navigate(r.workspace.id, r.repository.id)}>
									{r.workspace.handle}/{r.repository.name}
								</button>
							))}
						<button type="button" onClick={() => setFinder(false)}>
							Close
						</button>
					</section>
				</div>
			)}
		</div>
	);
}
function Sessions({ view, open, all = false }: { view: RepositorySnapshot; open: (id: string) => void; all?: boolean }) {
	const sessions = view.sessions.filter((s) => all || ["active", "preparing", "disconnected"].includes(s.state));
	return sessions.length ? (
		<div className="session-list">
			{sessions.map((s) => (
				<button type="button" key={s.id} onClick={() => open(s.id)}>
					<span className={`presence ${s.state}`} />
					<span>
						<strong>{s.actor.name}</strong>
						<small>{s.actor.kind}</small>
					</span>
					<span>
						{s.title}
						<small>
							<code>{s.branch ?? "No ref"}</code> · {s.changes.length} files
						</small>
					</span>
					<span>
						{s.state}
						<small>Last observed {time(s.lastActivity)}</small>
					</span>
				</button>
			))}
		</div>
	) : (
		<Empty>No active sessions. Sessions appear when you or an agent begins work through the local bridge.</Empty>
	);
}
function Overlaps({ view }: { view: RepositorySnapshot }) {
	return view.overlaps.length ? (
		<section className="overlap">
			<h2>Shared surfaces</h2>
			{view.overlaps.map((o) => (
				<p key={o.id}>
					<code>{o.surface}</code> · {o.sessions.map((id) => view.sessions.find((s) => s.id === id)?.actor.name).join(" and ")} · reported
					overlap
				</p>
			))}
			<small>Overlap is awareness, not a Git conflict.</small>
		</section>
	) : null;
}
function SessionDetail({ view, id }: { view: RepositorySnapshot; id: string }) {
	const s = view.sessions.find((s) => s.id === id)!;
	return (
		<section>
			<h2>{s.title}</h2>
			<p>
				{s.actor.name} · {s.mode} · {s.state}
			</p>
			<p>
				Started from <code>{s.baseRevision}</code>
			</p>
			<p>
				Head <code>{s.headRevision}</code>
			</p>
			{s.context && <p>{s.context}</p>}
			<ul>
				{s.changes.map((c) => (
					<li key={c.path}>
						<code>
							{c.previousPath ? `${c.previousPath} → ` : ""}
							{c.path}
						</code>{" "}
						· {c.status}
						{c.binary ? " · binary" : ""}
					</li>
				))}
			</ul>
			<details>
				<summary>Execution details</summary>
				<p>
					{s.execution?.kind ?? "Awaiting attachment"} · {s.execution?.id ?? ""}
				</p>
				<p>
					{s.commits.length} reported commits · {time(s.startedAt)}
				</p>
			</details>
		</section>
	);
}
function Activity({ view }: { view: RepositorySnapshot }) {
	return (
		<section>
			<h2>Recent activity</h2>
			{view.activity.length ? (
				<ol className="activity">
					{view.activity
						.slice(-20)
						.toReversed()
						.map((e) => (
							<li key={e.id}>
								<time>{time(e.at)}</time>
								<span>{e.summary}</span>
							</li>
						))}
				</ol>
			) : (
				<Empty>No activity yet.</Empty>
			)}
		</section>
	);
}
function ArtifactRow({ artifact: a, open }: { artifact: Artifact; open: (id: string) => void }) {
	return (
		<button type="button" className="artifact-row" onClick={() => open(a.id)}>
			<strong>{a.title}</strong>
			<span>
				{a.kind} · <code>{short(a.revision)}</code>
			</span>
			<small>
				{a.actor.name} · {a.trust.replaceAll("_", " ")}
			</small>
		</button>
	);
}
type Execute = (cmd: Partial<Command> & { tool: string }) => Promise<unknown>;
function ArtifactDetail({ id, view, execute }: { id: string; view: RepositorySnapshot; execute: Execute }) {
	const a = view.artifacts.find((a) => a.id === id);

	if (!a) return null;
	return (
		<section>
			<h2>{a.title}</h2>
			<dl>
				<dt>Revision</dt>
				<dd>
					<code>{a.revision}</code>
				</dd>
				<dt>Session</dt>
				<dd>{view.sessions.find((s) => s.id === a.sessionId)?.title}</dd>
				<dt>Storage</dt>
				<dd>{a.storage.repository}</dd>
				<dt>Content hash</dt>
				<dd>
					<code>{a.contentHash}</code>
				</dd>
			</dl>
			<ArtifactInspection key={id} id={id} execute={execute} />
			{view.permissions.write && a.kind === "source" && (
				<Form label="Propose change" submit={(d) => execute({ tool: "create_proposal", artifactId: a.id, title: value(d, "title") })}>
					<label>
						Change title
						<input name="title" defaultValue={a.title} required />
					</label>
				</Form>
			)}
		</section>
	);
}
function TeamForm({
	team,
	workspace,
	save,
}: {
	team: Team;
	workspace: WorkspaceView;
	save: (body: Record<string, unknown>) => Promise<unknown>;
}) {
	const stableId = useRef(team.id || crypto.randomUUID());
	if (!workspace.permissions.maintain) return <p>{team.name}</p>;
	return (
		<details>
			<summary>{team.name || "Create team"}</summary>
			<Form
				label={team.id ? "Save team" : "Create team"}
				submit={(d) => save({ id: stableId.current, name: value(d, "name"), members: d.getAll("members").map(String) })}
			>
				<label>
					Team name
					<input name="name" defaultValue={team.name} required />
				</label>
				{workspace.people.map((p) => (
					<label className="checkbox" key={p.id}>
						<input type="checkbox" name="members" value={p.id} defaultChecked={team.members.includes(p.id)} />
						{p.name}
					</label>
				))}
			</Form>
		</details>
	);
}
