import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { gitRemotePath } from "../shared/git-access.ts";
import type {
	Artifact,
	Command,
	Namespace,
	NamespaceRole,
	Repository,
	RepositorySnapshot,
	ResourcePolicy,
	Team,
	User,
} from "../shared/platform.ts";
import { BranchArt, Dialog, Icon } from "./design.tsx";
import { ArtifactInspection, Code, WorkspaceUpdateInspection } from "./inspect.tsx";
import "./styles.css";

const count = (n: number, label: string, plural = `${label}s`) => `${n} ${n === 1 ? label : plural}`;
const short = (s?: string) => s?.slice(0, 8) ?? "—";
const time = (n: number) => new Date(n).toLocaleString();
const namespaceTabs = ["repositories", "members", "teams", "settings"];
const tabs = ["overview", "code", "work", "artifacts", "settings"];
type NamespaceView = {
	repositorySummaries?: { id: string; active: number; overlaps: number; latestArtifact?: Artifact }[];
	activity?: { id: string; repositoryId: string; repositoryName: string; summary: string; at: number }[];
	namespace: Namespace;
	role: NamespaceRole;
	repositories: Repository[];
	members: Record<string, NamespaceRole>;
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
		namespaceId: query.get("namespace") ?? "",
		screen:
			query.get("page") === "account"
				? "account"
				: query.get("page") === "namespaces" || !query.has("namespace")
					? "namespaces"
					: "namespace",
		repositoryId: query.get("repository") ?? "",
		tab: [...tabs, ...namespaceTabs].includes(tab) ? tab : "overview",
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
		[me, setMe] = useState<{ user: User; namespaces: Namespace[] }>(),
		[namespace, setNamespace] = useState<NamespaceView>(),
		[view, setView] = useState<RepositorySnapshot>(),
		[error, setError] = useState<Error>(),
		[notice, setNotice] = useState(""),
		[refresh, setRefresh] = useState(0),
		[finder, setFinder] = useState(false),
		[search, setSearch] = useState(""),
		[finderLoading, setFinderLoading] = useState(false),
		[finderError, setFinderError] = useState(""),
		[catalog, setCatalog] = useState<{ namespace: Namespace; repository: Repository }[]>([]),
		[overlay, setOverlay] = useState<"namespace" | "create-namespace" | "repository">();
	const namespaceTab = namespaceTabs.includes(route.tab) ? route.tab : "repositories";
	const routeRef = useRef(route);
	routeRef.current = route;
	const retries = useRef(new Map<string, string>()),
		generation = useRef(0),
		[busy, setBusy] = useState(false);
	const reload = useCallback(() => setRefresh((n) => n + 1), []);
	const navigate = useCallback((namespaceId: string, repositoryId = "", tab = "overview", id = "") => {
		const url = new URL(location.href);
		url.pathname = "/";
		url.search = "";
		url.searchParams.set("namespace", namespaceId);
		if (repositoryId) url.searchParams.set("repository", repositoryId);
		url.hash = `/${tab}${id ? `/${id}` : ""}`;
		const previous = readRoute();
		history.pushState(null, "", url);
		if (previous.namespaceId !== namespaceId || previous.repositoryId !== repositoryId) {
			generation.current++;
			setView(undefined);
		}
		setNotice("");
		setError(undefined);
		setRoute(readRoute());
		setFinder(false);
		setOverlay(undefined);
	}, []);
	const navigatePage = useCallback(
		(screen: "namespaces" | "account") => {
			const url = new URL(location.href);
			url.pathname = "/";
			url.search = "";
			url.hash = "";
			url.searchParams.set("page", screen);
			if (route.namespaceId) url.searchParams.set("namespace", route.namespaceId);
			history.pushState(null, "", url);
			generation.current++;
			setView(undefined);
			setNotice("");
			setError(undefined);
			setFinder(false);
			setOverlay(undefined);
			setRoute(readRoute());
		},
		[route.namespaceId],
	);

	useEffect(() => {
		void route;
		document.getElementById("content")?.focus({ preventScroll: true });
	}, [route]);

	useEffect(() => {
		const change = () => {
			const next = readRoute();
			if (next.namespaceId !== routeRef.current.namespaceId || next.repositoryId !== routeRef.current.repositoryId) {
				generation.current++;
				setView(undefined);
			}
			setRoute(next);
			setNotice("");
			setOverlay(undefined);
			setFinder(false);
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
		void request<{ user: User; namespaces: Namespace[] }>("/api/me", undefined, "GET", controller.signal)
			.then((data) => {
				setMe(data);
				if (!readRoute().namespaceId) setRoute((r) => ({ ...r, namespaceId: data.user.personalNamespaceId }));
			})
			.catch((e) => {
				if (e.name !== "AbortError") setError(e);
			});
		return () => controller.abort();
	}, []);
	useEffect(() => {
		if (me && !route.namespaceId) setRoute((current) => ({ ...current, namespaceId: me.user.personalNamespaceId }));
	}, [me, route.namespaceId]);

	useEffect(() => {
		if (!route.namespaceId) return;
		void refresh; // Explicit invalidation after a successful mutation.
		const controller = new AbortController();
		setNamespace(undefined);
		const load = () =>
			request<NamespaceView>(`/api/namespaces/${route.namespaceId}`, undefined, "GET", controller.signal)
				.then((data) => {
					if (!controller.signal.aborted) setNamespace(data);
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
	}, [route.namespaceId, refresh]);
	useEffect(() => {
		if (!route.repositoryId || !route.namespaceId) {
			setView(undefined);
			return;
		}
		void refresh; // Explicit invalidation after a successful mutation.
		const controller = new AbortController(),
			ticket = ++generation.current;
		const load = () =>
			request<RepositorySnapshot>(
				`/api/namespaces/${route.namespaceId}/repositories/${route.repositoryId}`,
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
	}, [route.namespaceId, route.repositoryId, refresh]);
	useEffect(() => {
		if (!finder || !me) return;
		void refresh;
		const controller = new AbortController();
		setFinderLoading(true);
		setFinderError("");
		setCatalog([]);
		void Promise.all(
			me.namespaces.map(async (w) => {
				try {
					return (await request<Repository[]>(`/api/namespaces/${w.id}/repositories`, undefined, "GET", controller.signal)).map(
						(repository) => ({ namespace: w, repository }),
					);
				} catch (e) {
					if (!controller.signal.aborted) setFinderError((e as Error).message);
					return [];
				}
			}),
		).then((rows) => {
			if (!controller.signal.aborted) {
				setCatalog(rows.flat());
				setFinderLoading(false);
			}
		});
		return () => controller.abort();
	}, [finder, me, refresh]);

	const mutate = async <T,>(url: string, body: Record<string, unknown>, method = "POST") => {
		const fingerprint = JSON.stringify({ url, body, method }),
			key = retries.current.get(fingerprint) ?? crypto.randomUUID();
		retries.current.set(fingerprint, key);
		const result = await request<T>(
			url,
			{
				...body,
				...(method === "POST" && (body.tool || url.endsWith("repositories") || url === "/api/namespaces") ? { idempotencyKey: key } : {}),
			},
			method,
		);
		retries.current.delete(fingerprint);
		reload();
		return result;
	};
	const execute = async (command: Partial<Command> & { tool: string }) => {
		if (!view) throw new Error("Repository unavailable");
		const url = `/api/namespaces/${route.namespaceId}/repositories/${route.repositoryId}/command`;
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
	const base = `/api/namespaces/${route.namespaceId}`;
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
				<h1>Join namespace</h1>
				<Form
					label="Accept invitation"
					submit={async () => {
						const namespaceId = location.pathname.split("/")[2];
						await request(`/api/namespaces/${namespaceId}/accept`, { token: location.hash.slice(1) });
						location.href = `/?namespace=${namespaceId}`;
					}}
				>
					<p>Signed in as {me.user.email}. This invitation must match your verified email.</p>
				</Form>
			</main>
		);
	return (
		<div className="shell">
			<button type="button" className="skip" onClick={() => document.getElementById("content")?.focus()}>
				Skip to content
			</button>
			<aside>
				<a
					className="brand"
					href="/?page=namespaces"
					onClick={(e) => {
						if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
							e.preventDefault();
							navigatePage("namespaces");
						}
					}}
				>
					<span className="brand-mark">
						<Icon name="branch" />
					</span>
					Cruce <span className="alpha">ALPHA</span>
				</a>
				<button
					type="button"
					className="namespace-switcher"
					aria-label="Switch namespace"
					aria-haspopup="dialog"
					onClick={() => setOverlay("namespace")}
				>
					<span className="namespace-avatar">{(namespace?.namespace.name ?? "W").slice(0, 1).toUpperCase()}</span>
					<span>
						<strong>{namespace?.namespace.name ?? "Namespace"}</strong>
						<small>{namespace?.namespace.kind === "shared" ? "Shared namespace" : "Personal namespace"}</small>
					</span>
					<Icon name="chevron" />
				</button>
				<button type="button" className="finder-trigger" onClick={() => setFinder(true)}>
					<Icon name="search" />
					Find repository <kbd>⌘K</kbd>
				</button>
				<button
					type="button"
					className={`all-namespaces ${route.screen === "namespaces" ? "selected" : ""}`}
					onClick={() => navigatePage("namespaces")}
				>
					<Icon name="repositories" />
					All namespaces
					<Icon name="arrow" />
				</button>
				{route.screen === "namespace" && (
					<>
						<p className="nav-label">Namespace</p>
						<nav aria-label="Namespace navigation">
							{["repositories", ...(namespace?.namespace.kind === "shared" ? ["members", "teams"] : []), "settings"].map((tab) => (
								<button
									type="button"
									key={tab}
									className={route.screen === "namespace" && !route.repositoryId && namespaceTab === tab ? "selected" : ""}
									aria-current={route.screen === "namespace" && !route.repositoryId && namespaceTab === tab ? "page" : undefined}
									onClick={() => navigate(route.namespaceId, "", tab)}
								>
									<Icon name={tab} />
									{tab}
									{tab === "repositories" && <span className="nav-count">{namespace?.repositories.length ?? "—"}</span>}
								</button>
							))}
						</nav>
					</>
				)}
				{view && (
					<div className="current-repository">
						<p className="nav-label">Current repository</p>
						<button type="button" onClick={() => setFinder(true)}>
							<Icon name="branch" />
							<span>{view.repository.name}</span>
							<Icon name="chevron" />
						</button>
						<small>Artifacts hosted Git</small>
					</div>
				)}
				<div className="sidebar-bottom">
					<p className="sidebar-note">
						Independent work.
						<br />
						<span>Shared direction.</span>
					</p>
					<button
						type="button"
						className="account-trigger"
						aria-current={route.screen === "account" ? "page" : undefined}
						aria-label="Your account"
						onClick={() => navigatePage("account")}
					>
						<span className="account-avatar">{me.user.name.slice(0, 1).toUpperCase()}</span>
						<span>
							<strong>{me.user.name}</strong>
							<small>Account</small>
						</span>
						<Icon name="chevron" />
					</button>
				</div>
			</aside>
			<main id="content" tabIndex={-1}>
				<header>
					<div className="breadcrumb">
						<button
							type="button"
							onClick={() =>
								route.screen === "namespace" ? navigate(route.namespaceId) : navigatePage(route.screen as "namespaces" | "account")
							}
						>
							{route.screen === "namespaces"
								? "All namespaces"
								: route.screen === "account"
									? "Your account"
									: (namespace?.namespace.handle ?? "Namespace")}
						</button>
						{view && (
							<>
								{" "}
								/ <strong>{view.repository.name}</strong>
							</>
						)}
					</div>
					<span className="context-badge">
						<Icon name={view ? "branch" : "lock"} />
						{view ? "Artifacts hosted Git" : route.screen === "namespace" ? "Private namespace" : "Your Cruce"}
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
				{route.screen === "namespaces" ? (
					<NamespaceHome me={me} refresh={refresh} open={navigate} create={() => setOverlay("create-namespace")} />
				) : route.screen === "account" ? (
					<AccountPage me={me} open={navigate} />
				) : route.repositoryId ? (
					<>
						<nav className="tabs" aria-label="Repository navigation">
							{tabs.map((tab) => (
								<button
									type="button"
									key={tab}
									className={route.tab === tab ? "selected" : ""}
									aria-current={route.tab === tab ? "page" : undefined}
									onClick={() => navigate(route.namespaceId, route.repositoryId, tab)}
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
										{view.sourceHead && (
											<details className="clone-instructions">
												<summary>Clone</summary>
												<pre>
													<code>{`git clone ${location.origin}${gitRemotePath(view.repository.namespaceId, view.repository.id)}`}</code>
												</pre>
												<p>
													Use your Cruce OAuth connection with a Git credential helper. Canonical is read-only; each workspace has its own
													writable fork.
												</p>
											</details>
										)}
										<div className="status-strip">
											<span>{view.workspaces.filter((s) => s.state === "active").length} active workspaces</span>
											<span>{count(view.overlaps.length, "overlap")}</span>
											<span>{count(view.artifacts.length, "artifact")}</span>
											<span>
												{count(
													view.workspaces.filter((workspace) => workspace.actor.kind === "agent" && workspace.state === "active").length,
													"agent",
												)}{" "}
												working
											</span>
										</div>
										{view.proposals.some((p) => p.state === "open") && (
											<section className="review-queue">
												<div className="section-heading">
													<h2>Review queue</h2>
													<span>Exact revisions · human decisions</span>
												</div>
												{view.proposals
													.filter((p) => p.state === "open")
													.map((p) => (
														<button
															type="button"
															className="review-row"
															key={p.id}
															onClick={() => navigate(route.namespaceId, route.repositoryId, "work", p.id)}
														>
															<span className="review-number">#{p.number}</span>
															<span>
																<strong>{p.title}</strong>
																<small>
																	{view.workspaces.find((workspace) => workspace.id === p.workspaceId)?.actor.name ?? "Workspace"} ·{" "}
																	<code>{short(p.revision)}</code>
																</small>
															</span>
															<span className={`readiness-badge ${view.readiness[p.id]?.ready ? "ready" : ""}`}>
																{view.readiness[p.id]?.ready
																	? "Ready for promotion"
																	: (view.readiness[p.id]?.reasons[0] ?? "Readiness unavailable")}
															</span>
															<Icon name="arrow" />
														</button>
													))}
											</section>
										)}
										<h2>Active workspaces</h2>
										<Workspaces view={view} open={(id) => navigate(route.namespaceId, route.repositoryId, "work", id)} />
										<Overlaps view={view} />
										<section>
											<h2>Latest artifact</h2>
											{view.artifacts.length ? (
												<ArtifactRow
													artifact={view.artifacts.at(-1)!}
													open={(id) => navigate(route.namespaceId, route.repositoryId, "artifacts", id)}
												/>
											) : (
												<Empty>No artifacts published yet.</Empty>
											)}
										</section>
										<Activity view={view} />
									</>
								)}
								{route.tab === "work" && (
									<>
										<h1>Work</h1>
										<Workspaces view={view} open={(id) => navigate(route.namespaceId, route.repositoryId, "work", id)} all />
										<Overlaps view={view} />
										{route.id && view.workspaces.find((s) => s.id === route.id) && (
											<WorkspaceDetail view={view} id={route.id} execute={execute} />
										)}
										<h2>Changes</h2>
										{!view.proposals.length && (
											<Empty>No changes proposed. Publish committed source from a workspace to request review.</Empty>
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
												<button type="button" onClick={() => navigate(route.namespaceId, route.repositoryId, "code", p.id)}>
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

														<button
															type="button"
															disabled={busy || !view.readiness[p.id]?.ready}
															onClick={() => void execute({ tool: "promote_proposal", proposalId: p.id }).catch((e) => setError(e))}
														>
															Promote source
														</button>
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
											<Empty>No artifacts yet. Publish exact committed source or evidence from your workspace.</Empty>
										)}
										{view.artifacts.map((a) => (
											<ArtifactRow
												key={a.id}
												artifact={a}
												open={(id) => navigate(route.namespaceId, route.repositoryId, "artifacts", id)}
											/>
										))}
										{route.id && <ArtifactDetail key={route.id} id={route.id} view={view} execute={execute} />}
									</>
								)}
								{route.tab === "settings" && (
									<>
										<h1>Repository settings</h1>
										<p>
											<code>{view.repository.id}</code> · Artifacts
										</p>
										<h2>Connect your checkout</h2>
										<pre>{`node /path/to/cruce/runner/cruce.mjs connect --namespace ${route.namespaceId} --repository ${route.repositoryId} --server ${location.origin} --client codex`}</pre>
										<p>
											For a human workspace, use <code>human</code> instead of <code>connect</code>, then{" "}
											<code>start --title "Your work"</code>.
										</p>
										{view.permissions.maintain && namespace && (
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
														{namespace.people.find((p) => p.id === g.id)?.name ?? namespace.teams.find((t) => t.id === g.id)?.name ?? g.id}{" "}
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
															{namespace.people.map((p) => (
																<option key={p.id} value={`user:${p.id}`}>
																	{p.name}
																</option>
															))}
															{namespace.teams.map((t) => (
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
				) : namespace ? (
					<>
						<div className="page-title namespace-title">
							<div>
								<p className="eyebrow">Your namespace, connected</p>
								<h1>{namespaceTab === "repositories" ? "Repositories" : namespaceTab[0].toUpperCase() + namespaceTab.slice(1)}</h1>
								<p className="page-description">
									{namespaceTab === "repositories"
										? "Repositories, agent workspaces, and the changes ready for your attention."
										: `Manage ${namespaceTab} for ${namespace.namespace.name}.`}
								</p>
							</div>
							{namespaceTab === "repositories" && namespace.permissions.maintain && namespace.repositories.length > 0 && (
								<button className="primary" type="button" onClick={() => setOverlay("repository")}>
									<Icon name="plus" />
									New repository
								</button>
							)}
						</div>
						{namespaceTab === "repositories" && (
							<>
								{namespace.repositories.length ? (
									<div className="repo-list">
										{namespace.repositories.map((r) => (
											<button type="button" key={r.id} onClick={() => navigate(namespace.namespace.id, r.id)}>
												<span className="repo-symbol">
													<Icon name="cloud" />
												</span>
												<strong>{r.name}</strong>
												<span>
													Artifacts · {r.defaultBranch}
													{namespace.repositorySummaries?.find((s) => s.id === r.id) && (
														<small>
															{namespace.repositorySummaries.find((s) => s.id === r.id)!.active} active workspaces ·{" "}
															{namespace.repositorySummaries.find((s) => s.id === r.id)!.overlaps} overlaps
														</small>
													)}
												</span>
												<Icon name="arrow" />
											</button>
										))}
									</div>
								) : (
									<section className="repository-empty">
										<BranchArt />
										<div className="empty-copy">
											<span className="eyebrow">Great work starts here</span>
											<h2>
												Independent agents.
												<br />
												Connected work.
											</h2>
											<p>
												No repositories yet. Bring your local Git into Cruce to coordinate developers and agents, with context that follows
												the commit.
											</p>
											{namespace.permissions.maintain && (
												<button type="button" className="primary" onClick={() => setOverlay("repository")}>
													<Icon name="plus" />
													New repository
													<Icon name="arrow" />
												</button>
											)}
										</div>
									</section>
								)}
								{namespace.activity?.length ? (
									<section>
										<h2>Recent activity</h2>
										<ol className="activity">
											{namespace.activity.map((e) => (
												<li key={`${e.repositoryId}:${e.id}`}>
													<time>{time(e.at)}</time>
													<span>
														<button type="button" onClick={() => navigate(namespace.namespace.id, e.repositoryId)}>
															{e.repositoryName}
														</button>{" "}
														{e.summary}
													</span>
												</li>
											))}
										</ol>
									</section>
								) : null}
								<div className="namespace-guide">
									<div>
										<span className="guide-number">01</span>
										<h3>Bring your Git</h3>
										<p>Create a repository, then clone it with Git.</p>
									</div>
									<div>
										<span className="guide-number">02</span>
										<h3>Connect your agents</h3>
										<p>Authorize a local agent connection. Each writer gets its own worktree and workspace.</p>
									</div>
									<div>
										<span className="guide-number">03</span>
										<h3>Review the exact change</h3>
										<p>Inspect agent commits and evidence. Human approval controls promotion.</p>
									</div>
								</div>
							</>
						)}
						{namespaceTab === "members" && (
							<>
								{namespace.people.map((p) => (
									<div className="record" key={p.id}>
										<strong>{p.name}</strong> {p.email} · {namespace.members[p.id]}
										{namespace.permissions.maintain && namespace.members[p.id] !== "owner" && (
											<Form
												label="Update member"
												submit={(d) =>
													mutate(`${base}/members`, { userId: p.id, ...(value(d, "role") === "remove" ? {} : { role: value(d, "role") }) })
												}
											>
												<label>
													Namespace role
													<select name="role" defaultValue={namespace.members[p.id]}>
														<option value="viewer">Viewer</option>
														<option value="developer">Developer</option>
														{namespace.permissions.owner && <option value="maintainer">Maintainer</option>}
														<option value="remove">Remove member</option>
													</select>
												</label>
											</Form>
										)}
									</div>
								))}
								{namespace.permissions.maintain && (
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
												{namespace.permissions.owner && <option value="maintainer">Maintainer</option>}
											</select>
										</label>
									</Form>
								)}
							</>
						)}
						{namespaceTab === "teams" && (
							<>
								{!namespace.teams.length && <Empty>No teams yet. Teams group namespace members for repository access.</Empty>}
								{[...namespace.teams, { id: "", name: "", members: [] }].map((t) => (
									<TeamForm key={t.id || "new"} team={t} namespace={namespace} save={(body) => mutate(`${base}/teams`, body)} />
								))}
							</>
						)}
						{namespaceTab === "settings" && (
							<>
								<h2>Namespace settings</h2>
								{namespace.permissions.maintain && (
									<Form
										label="Save namespace"
										submit={async (d) => {
											const w = await mutate<Namespace>(base, { name: value(d, "name"), handle: value(d, "handle") }, "PATCH");
											setMe({ ...me, namespaces: me.namespaces.map((old) => (old.id === w.id ? w : old)) });
										}}
									>
										<label>
											Name
											<input name="name" defaultValue={namespace.namespace.name} required />
										</label>
										<label>
											Handle
											<input name="handle" defaultValue={namespace.namespace.handle} required />
										</label>
									</Form>
								)}
								<h2>Cloudflare account</h2>
								<p>
									{namespace.account
										? `${namespace.account.label} · ${namespace.account.accountId}`
										: "Not connected. Connect an Artifacts account to create repositories and workspaces."}
								</p>
								{namespace.permissions.owner && (
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
								{namespace.permissions.maintain && (
									<Form
										label="Save resource policy"
										submit={(d) =>
											mutate(`${base}/policy`, {
												dailyLimit: Number(value(d, "dailyLimit")),
												rules: Object.fromEntries(Object.keys(namespace.policy.rules).map((key) => [key, value(d, key)])),
											})
										}
									>
										<h2>Shared resource budgets</h2>
										<label>
											Daily operations
											<input name="dailyLimit" type="number" min="0" max="10000" defaultValue={namespace.policy.dailyLimit} />
										</label>
										{Object.entries(namespace.policy.rules).map(([key, rule]) => (
											<label key={key}>
												{key}
												<select name={key} defaultValue={rule}>
													<option value="allow">Allow</option>
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
					<Empty>Loading namespace…</Empty>
				)}
			</main>
			{overlay === "namespace" && (
				<Dialog title="Switch namespace" close={() => setOverlay(undefined)} className="namespace-picker">
					<p className="muted">Choose where you work.</p>
					<button type="button" className="namespace-option all-option" onClick={() => navigatePage("namespaces")}>
						<Icon name="repositories" />
						<span>View all namespaces</span>
						<Icon name="arrow" />
					</button>
					{me.namespaces.map((w) => (
						<button className="namespace-option" type="button" key={w.id} onClick={() => navigate(w.id)}>
							<span className="namespace-avatar">{w.name.slice(0, 1).toUpperCase()}</span>
							<span>
								<strong>{w.name}</strong>
								<small>{w.kind === "personal" ? "Personal namespace" : "Shared namespace"}</small>
							</span>
							{route.namespaceId === w.id && <Icon name="check" />}
						</button>
					))}
					<button type="button" className="create-namespace-trigger" onClick={() => setOverlay("create-namespace")}>
						<Icon name="plus" />
						Create namespace
					</button>
				</Dialog>
			)}
			{overlay === "create-namespace" && (
				<Dialog title="Create namespace" close={() => setOverlay(undefined)}>
					<p className="muted">A shared place for your team's repositories.</p>
					<Form
						label="Create namespace"
						submit={async (d) => {
							const w = await mutate<Namespace>("/api/namespaces", { name: value(d, "name"), handle: value(d, "handle") });
							setMe({ ...me, namespaces: [...me.namespaces, w] });
							navigate(w.id);
						}}
					>
						<label>
							Name
							<input name="name" required placeholder="e.g. Acme engineering" />
						</label>
						<label>
							Namespace handle
							<input name="handle" required pattern="[a-z0-9-]+" placeholder="acme" />
						</label>
					</Form>
				</Dialog>
			)}
			{overlay === "repository" && namespace?.permissions.maintain && (
				<Dialog title="New repository" close={() => setOverlay(undefined)} className="repository-dialog">
					<p className="muted">Add a repository to {namespace.namespace.name}.</p>
					<Form
						label="Add repository"
						submit={async (d) => {
							const repo = await mutate<Repository>(`${base}/repositories`, {
								name: value(d, "name"),
								defaultBranch: value(d, "branch"),
							});
							navigate(namespace.namespace.id, repo.id);
						}}
					>
						<p className="cost">
							Creates canonical Git storage in your connected Cloudflare account. Agent workspaces consume isolated forks under namespace
							policy.
						</p>
						{!namespace.account && <p>Connect Cloudflare in namespace settings before creating a repository.</p>}
						<div className="form-fields">
							<label>
								Repository name
								<input name="name" required pattern="[a-z0-9-]+" placeholder="e.g. auth-service" />
							</label>
							<label>
								Default branch
								<input name="branch" defaultValue="main" required />
							</label>
						</div>
					</Form>
				</Dialog>
			)}

			{finder && (
				<Dialog title="Find repository" close={() => setFinder(false)} className="finder">
					<fieldset
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
								placeholder="namespace/repository"
							/>
						</label>
						{finderLoading && <p className="muted">Finding repositories…</p>}
						{finderError && (
							<div role="alert">
								{finderError}
								<button type="button" onClick={reload}>
									Retry
								</button>
							</div>
						)}
						{!finderLoading &&
							!finderError &&
							!catalog.some((r) => `${r.namespace.handle}/${r.repository.name}`.toLowerCase().includes(search.toLowerCase())) && (
								<p className="muted">No matching repositories.</p>
							)}
						{catalog
							.filter((r) => `${r.namespace.handle}/${r.repository.name}`.toLowerCase().includes(search.toLowerCase()))
							.map((r) => (
								<button type="button" key={r.repository.id} onClick={() => navigate(r.namespace.id, r.repository.id)}>
									{r.namespace.handle}/{r.repository.name}
								</button>
							))}
					</fieldset>
				</Dialog>
			)}
		</div>
	);
}
function NamespaceHome({
	me,
	refresh,
	open,
	create,
}: {
	me: { user: User; namespaces: Namespace[] };
	refresh: number;
	open: (namespaceId: string, repositoryId?: string) => void;
	create: () => void;
}) {
	const [spaces, setSpaces] = useState<Record<string, NamespaceView>>({}),
		[failures, setFailures] = useState<Record<string, string>>({}),
		[loading, setLoading] = useState(true),
		[retry, setRetry] = useState(0),
		[filter, setFilter] = useState("");
	useEffect(() => {
		void refresh;
		void retry;
		const controller = new AbortController();
		setLoading(true);
		setSpaces({});
		setFailures({});
		let sequence = 0;
		const load = async () => {
			const ticket = ++sequence;
			await Promise.all(
				me.namespaces.map(async (w) => {
					try {
						const result = await request<NamespaceView>(`/api/namespaces/${w.id}`, undefined, "GET", controller.signal);
						if (!controller.signal.aborted && ticket === sequence) {
							setSpaces((current) => ({ ...current, [w.id]: result }));
							setFailures((current) => {
								const next = { ...current };
								delete next[w.id];
								return next;
							});
						}
					} catch (e) {
						if (!controller.signal.aborted && ticket === sequence) {
							setFailures((current) => ({ ...current, [w.id]: (e as Error).message }));
							setSpaces((current) => {
								const next = { ...current };
								delete next[w.id];
								return next;
							});
						}
					}
				}),
			);
			if (!controller.signal.aborted && ticket === sequence) setLoading(false);
		};
		void load();
		const timer = setInterval(() => void load(), 15000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [me.namespaces, refresh, retry]);
	const motion = Object.values(spaces)
		.flatMap((w) =>
			(w.repositorySummaries ?? [])
				.filter((summary) => summary.active > 0 || summary.overlaps > 0)
				.map((summary) => ({ ...summary, namespace: w.namespace, repository: w.repositories.find((r) => r.id === summary.id) })),
		)
		.filter((row) => row.repository);

	const matches = me.namespaces.filter((w) =>
		`${w.name} ${w.handle} ${spaces[w.id]?.repositories.map((r) => r.name).join(" ") ?? ""}`.toLowerCase().includes(filter.toLowerCase()),
	);
	return (
		<>
			<div className="page-title home-title">
				<div>
					<h1>
						Agent work.
						<br />
						<span>Shared direction.</span>
					</h1>
					<p className="page-description">Follow agent workspaces across repositories. Inspect the commit. Decide what moves forward.</p>
				</div>
				<button type="button" className="primary" onClick={create}>
					<Icon name="plus" />
					Create namespace
				</button>
			</div>
			<div className="home-toolbar">
				<p>
					{count(me.namespaces.length, "namespace")} <span className="toolbar-dot">/</span>{" "}
					{loading
						? "— repositories"
						: count(
								Object.values(spaces).reduce((n, w) => n + w.repositories.length, 0),
								"repository",
								"repositories",
							)}
					{Object.keys(failures).length > 0 && <small>Counts include available namespaces.</small>}
				</p>
				<label className="namespace-search">
					<Icon name="search" />
					<input
						aria-label="Filter namespaces"
						placeholder="Find a namespace or repository…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
				</label>
			</div>
			{!filter && motion.length > 0 && (
				<section className="motion-panel">
					<div className="section-heading">
						<div>
							<p className="eyebrow">Across your namespaces</p>
							<h2>Work in motion</h2>
						</div>
						<span className="observed-label">
							<span className="presence active" />
							Reported activity
						</span>
					</div>
					{motion.map((row) => (
						<button
							type="button"
							key={`${row.namespace.id}/${row.id}`}
							className="motion-row"
							onClick={() => open(row.namespace.id, row.id)}
						>
							<Icon name="branch" />
							<span>
								<strong>{row.repository!.name}</strong>
								<small>{row.namespace.name}</small>
							</span>
							<span className="motion-count">{count(row.active, "active workspace")}</span>
							<span className="surface-count">{count(row.overlaps, "shared surface")}</span>
							<Icon name="arrow" />
						</button>
					))}
				</section>
			)}
			<div className="namespace-grid">
				{matches.map((w) => {
					const data = spaces[w.id];
					return (
						<section className={`namespace-card ${w.kind}`} key={w.id}>
							<div className="namespace-card-top">
								<span className="namespace-avatar">{w.name.slice(0, 1).toUpperCase()}</span>
								<span className="space-kind">{w.kind === "personal" ? "Personal" : "Shared"}</span>
							</div>
							<button className="namespace-card-title" type="button" onClick={() => open(w.id)}>
								<h2>{w.name}</h2>
								<Icon name="arrow" />
							</button>
							<p className="namespace-handle">/{w.handle}</p>
							<div className="namespace-card-body">
								{failures[w.id] ? (
									<div role="alert">
										<p>{failures[w.id]}</p>
										<button type="button" onClick={() => setRetry((n) => n + 1)}>
											Retry
										</button>
									</div>
								) : data ? (
									<>
										<p className="namespace-card-meta">
											{count(data.repositories.length, "repository", "repositories")} <span>· {data.role}</span>
										</p>
										{data.repositories.length ? (
											data.repositories.slice(0, 3).map((r) => (
												<button className="home-repo" key={r.id} type="button" onClick={() => open(w.id, r.id)}>
													<Icon name="cloud" />
													<span>{r.name}</span>
													<Icon name="arrow" />
												</button>
											))
										) : (
											<p className="namespace-card-empty">
												A clean slate for your agents.
												<br />
												Open this namespace to add your first repository.
											</p>
										)}
									</>
								) : (
									<p className="muted">Loading repositories…</p>
								)}
							</div>
							<button className="open-namespace" type="button" onClick={() => open(w.id)}>
								Open namespace
								<Icon name="arrow" />
							</button>
						</section>
					);
				})}
			</div>
			{!matches.length && <Empty>No matching namespaces. Try a namespace name, handle, or repository.</Empty>}
			<div className="home-footer">
				<Icon name="branch" />
				<p>
					Agents work independently. Context stays connected.<span>Isolated worktrees. Exact revisions. Human decisions.</span>
				</p>
			</div>
		</>
	);
}
function AccountPage({ me, open }: { me: { user: User; namespaces: Namespace[] }; open: (namespaceId: string) => void }) {
	return (
		<>
			<div className="page-title namespace-title">
				<div>
					<p className="eyebrow">Your corner of Cruce</p>
					<h1>Your account</h1>
					<p className="page-description">Your identity and the places you belong.</p>
				</div>
			</div>
			<div className="account-layout">
				<section className="profile-panel">
					<div className="profile-cover">
						<Icon name="branch" />
					</div>
					<div className="profile-content">
						<span className="account-avatar">{me.user.name.slice(0, 1).toUpperCase()}</span>
						<h2>{me.user.name}</h2>
						<p>{me.user.email}</p>
						<span className="identity-badge">
							<Icon name="check" />
							Authenticated with Cloudflare Access
						</span>
						<p className="muted">
							Your account identity is managed by your sign-in provider. Namespace access is managed separately in each namespace.
						</p>
						<a className="sign-out" href="/auth/logout">
							Sign out
							<Icon name="arrow" />
						</a>
					</div>
				</section>
				<section className="account-memberships">
					<p className="eyebrow">Namespace access</p>
					<h2>A place in every namespace.</h2>
					<p className="muted">Repository permissions follow your current namespace membership and repository grants.</p>
					{me.namespaces.map((w) => (
						<button className="membership-row" type="button" key={w.id} onClick={() => open(w.id)}>
							<span className="namespace-avatar">{w.name.slice(0, 1).toUpperCase()}</span>
							<span>
								<strong>{w.name}</strong>
								<small>{w.kind === "personal" ? "Personal namespace" : "Shared namespace"}</small>
							</span>
							<Icon name="arrow" />
						</button>
					))}
				</section>
			</div>
		</>
	);
}

function Workspaces({ view, open, all = false }: { view: RepositorySnapshot; open: (id: string) => void; all?: boolean }) {
	const workspaces = view.workspaces
		.filter((s) => all || ["active", "preparing", "disconnected"].includes(s.state))
		.sort((a, b) => Number(b.actor.kind === "agent") - Number(a.actor.kind === "agent"));
	return workspaces.length ? (
		<div className="workspace-list">
			{workspaces.map((s) => (
				<button type="button" key={s.id} onClick={() => open(s.id)}>
					<span className={`presence ${s.state}`} />
					<span>
						<strong>{s.actor.name}</strong>
						<small className={`actor-kind ${s.actor.kind}`}>{s.actor.kind}</small>
					</span>
					<span>
						{s.title}
						<small>
							<code>{s.branch ?? "No ref"}</code> · +{count(s.commits.length, "commit")} · {count(s.changes.length, "file")}
						</small>
					</span>
					<span>
						{s.state}
						{view.workspaceUpdates[s.id]?.status === "available" && <small>Upstream updates available</small>}
						<small>Last observed {time(s.lastActivity)}</small>
					</span>
				</button>
			))}
		</div>
	) : (
		<Empty>No active workspaces. Workspaces appear when you or an agent begins work through the local bridge.</Empty>
	);
}
function Overlaps({ view }: { view: RepositorySnapshot }) {
	return view.overlaps.length ? (
		<section className="overlap">
			<h2>Shared surfaces</h2>
			{view.overlaps.map((o) => (
				<p key={o.id}>
					<code>{o.surface}</code> · {o.workspaces.map((id) => view.workspaces.find((s) => s.id === id)?.actor.name).join(" and ")} ·
					reported overlap
				</p>
			))}
			<small>Overlap is awareness, not a Git conflict.</small>
		</section>
	) : null;
}
function WorkspaceDetail({ view, id, execute }: { view: RepositorySnapshot; id: string; execute: Execute }) {
	const s = view.workspaces.find((s) => s.id === id)!;
	const updates = view.workspaceUpdates[id];
	const [cleanupError, setCleanupError] = useState("");
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
			<p>
				{updates.status === "unknown"
					? "Upstream revision unavailable"
					: updates.status === "current"
						? "Upstream matches the workspace baseline"
						: "Upstream updates available"}
				{updates.revision && (
					<>
						{" "}
						· <code>{short(updates.revision)}</code> · {updates.trust}
					</>
				)}
			</p>
			{updates.status === "available" && (
				<p>Fetch canonical with Git, merge when ready and verify before publishing. Your starting revision stays fixed.</p>
			)}
			<WorkspaceUpdateInspection key={`${id}:${updates.revision}:${s.headRevision}:${view.version}`} id={id} execute={execute} />
			{s.integratedRevision && (
				<p>
					Last integrated upstream <code>{s.integratedRevision}</code>
				</p>
			)}
			{s.fork ? (
				<>
					<p>Artifacts fork · {s.fork.state}</p>
					{s.fork.state === "ready" && (
						<pre>
							<code>{`git fetch ${location.origin}${gitRemotePath(view.repository.namespaceId, view.repository.id, s.id)}`}</code>
						</pre>
					)}
					{view.permissions.human && view.permissions.maintain && s.fork.state !== "deleted" && (
						<button
							type="button"
							disabled={!view.forkCleanup[s.id]?.ready}
							title={view.forkCleanup[s.id]?.reasons.join("; ")}
							onClick={() =>
								void execute({ tool: "cleanup_workspace", workspaceId: s.id }).catch((error) => setCleanupError(error.message))
							}
						>
							{s.fork.state === "deleting" ? "Check fork deletion" : "Clean up retained fork"}
						</button>
					)}
				</>
			) : (
				<p>No hosted fork provisioned</p>
			)}
			{cleanupError && <p role="alert">{cleanupError}</p>}
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
				{s.fork?.name && (
					<p>
						Hosted storage <code>{s.fork.name}</code>
					</p>
				)}
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
				<dt>Workspace</dt>
				<dd>{view.workspaces.find((s) => s.id === a.workspaceId)?.title}</dd>
				{a.baseRevision && (
					<>
						<dt>Review base</dt>
						<dd>
							<code>{a.baseRevision}</code>
						</dd>
					</>
				)}
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
	namespace,
	save,
}: {
	team: Team;
	namespace: NamespaceView;
	save: (body: Record<string, unknown>) => Promise<unknown>;
}) {
	const stableId = useRef(team.id || crypto.randomUUID());
	if (!namespace.permissions.maintain) return <p>{team.name}</p>;
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
				{namespace.people.map((p) => (
					<label className="checkbox" key={p.id}>
						<input type="checkbox" name="members" value={p.id} defaultChecked={team.members.includes(p.id)} />
						{p.name}
					</label>
				))}
			</Form>
		</details>
	);
}
