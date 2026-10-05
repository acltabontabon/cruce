import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, Namespace, Repository, RepositorySnapshot, Team, User } from "../shared/platform.ts";
import { BRAND } from "./brand.tsx";
import { Empty, Form, time, value } from "./controls.tsx";
import { BranchArt, Dialog, Icon } from "./design.tsx";
import { NamespaceHome } from "./home.tsx";
import { Code } from "./inspect.tsx";
import { ConsoleHeader } from "./navigation.tsx";
import { RepositoryOverview, WorkScreen } from "./repository.tsx";
import { request } from "./request.ts";
import { Shell } from "./shell.tsx";
import type { NamespaceView } from "./types.ts";
import "./styles.css";

const namespaceTabs = ["repositories", "members", "teams", "settings"];
const tabs = ["overview", "code", "work", "settings"];
function readRoute() {
	const query = new URLSearchParams(location.search),
		[tab, id] = location.hash.replace(/^#\/?/, "").split("/");
	const screen =
		query.get("page") === "account" || query.get("page") === "namespaces" || !query.has("namespace") ? "namespaces" : "namespace";
	return {
		screen,
		accountRequested: query.get("page") === "account",
		namespaceId: screen === "namespace" ? (query.get("namespace") ?? "") : "",
		repositoryId: screen === "namespace" ? (query.get("repository") ?? "") : "",
		tab:
			screen === "namespace" && query.get("repository") && tab === "artifacts"
				? tab
				: [...tabs, ...namespaceTabs].includes(tab)
					? tab
					: "overview",
		id: id ?? "",
	};
}

export function App() {
	const [route, setRoute] = useState(readRoute),
		[me, setMe] = useState<{ user: User; namespaces: Namespace[] }>(),
		[namespace, setNamespace] = useState<NamespaceView>(),
		[view, setView] = useState<RepositorySnapshot>(),
		[error, setError] = useState<Error>(),
		[notice, setNotice] = useState(""),
		[refresh, setRefresh] = useState(0),
		[overlay, setOverlay] = useState<"create-namespace" | "repository">();
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
		if (previous.namespaceId !== namespaceId) setNamespace(undefined);
		setNotice("");
		setError(undefined);
		setRoute(readRoute());
		setOverlay(undefined);
	}, []);
	const navigateHome = useCallback(() => {
		const url = new URL(location.href);
		url.pathname = "/";
		url.search = "";
		url.hash = "";
		history.pushState(null, "", url);
		generation.current++;
		setView(undefined);
		setNamespace(undefined);
		setNotice("");
		setError(undefined);
		setOverlay(undefined);
		setRoute(readRoute());
	}, []);

	useEffect(() => {
		if (route.tab !== "artifacts" || view?.repository.id !== route.repositoryId || view.repository.namespaceId !== route.namespaceId)
			return;
		const record = view.artifacts.find((a) => a.id === route.id);
		const url = new URL(location.href);
		url.hash = `/${record?.kind === "evidence" ? "work" : "code"}${route.id ? `/${route.id}` : ""}`;
		history.replaceState(null, "", url);
		setRoute(readRoute());
	}, [route, view]);

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
			if (next.namespaceId !== routeRef.current.namespaceId) setNamespace(undefined);
			setRoute(next);
			setNotice("");
			setOverlay(undefined);
		};
		window.addEventListener("popstate", change);
		window.addEventListener("hashchange", change);
		return () => {
			window.removeEventListener("popstate", change);
			window.removeEventListener("hashchange", change);
		};
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		void request<{ user: User; namespaces: Namespace[] }>("/api/me", undefined, "GET", controller.signal)
			.then((data) => {
				setMe(data);
			})
			.catch((e) => {
				if (e.name !== "AbortError") setError(e);
			});
		return () => controller.abort();
	}, []);
	useEffect(() => {
		if (route.screen === "namespace") return;
		const url = new URL(location.href);
		if (url.searchParams.get("page") === "account") {
			url.search = "";
			url.hash = "";
			history.replaceState(null, "", url);
			setRoute({ ...readRoute(), accountRequested: true });
			return;
		}
		if (!url.searchParams.has("namespace") && !url.searchParams.has("repository")) return;
		url.searchParams.delete("namespace");
		url.searchParams.delete("repository");
		url.hash = "";
		history.replaceState(null, "", url);
	}, [route.screen]);

	useEffect(() => {
		setNamespace(undefined);
		if (!route.namespaceId) return;
		void refresh; // Explicit invalidation after a successful mutation.
		const controller = new AbortController();
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

	const mutate = async <T,>(url: string, body: Record<string, unknown>, method = "POST") => {
		const fingerprint = JSON.stringify({ url, body, method }),
			key = (body.idempotencyKey as string | undefined) ?? retries.current.get(fingerprint) ?? crypto.randomUUID();
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
				<strong>{BRAND.name}</strong>
				<h1>{error ? `Sign in to ${BRAND.name}` : `Loading ${BRAND.name}…`}</h1>
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
		<Shell
			navigation={
				<ConsoleHeader
					me={me}
					screen={route.screen}
					namespaceId={route.namespaceId}
					namespace={
						namespace?.namespace.id === route.namespaceId
							? namespace.namespace
							: me.namespaces.find((item) => item.id === route.namespaceId)
					}
					repositoryId={route.repositoryId}
					repository={
						view?.repository.id === route.repositoryId && view.repository.namespaceId === route.namespaceId
							? view.repository
							: namespace?.namespace.id === route.namespaceId
								? namespace.repositories.find((item) => item.id === route.repositoryId)
								: undefined
					}
					repositories={namespace?.namespace.id === route.namespaceId ? namespace.repositories : []}
					routeKey={`${route.screen}/${route.namespaceId}/${route.repositoryId}/${route.tab}/${route.id}`}
					open={navigate}
					home={navigateHome}
					accountRequested={route.accountRequested}
					create={() => setOverlay("create-namespace")}
				/>
			}
		>
			<main
				id="content"
				tabIndex={-1}
				data-screen={route.screen === "namespace" ? (route.repositoryId ? route.tab : namespaceTab) : route.screen}
			>
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
									<RepositoryOverview view={view} open={(tab, id) => navigate(route.namespaceId, route.repositoryId, tab, id)} />
								)}
								{route.tab === "work" && (
									<WorkScreen
										view={view}
										id={route.id}
										execute={execute}
										busy={busy}
										open={(tab, id) => navigate(route.namespaceId, route.repositoryId, tab, id)}
									/>
								)}
								{route.tab === "code" && (
									<Code
										key={`${view.repository.id}-${route.id}`}
										view={view}
										execute={execute}
										id={route.id}
										open={(tab, id) => navigate(route.namespaceId, route.repositoryId, tab, id)}
									/>
								)}
								{route.tab === "settings" && (
									<>
										<h1>Repository settings</h1>
										<p>
											<code>{view.repository.id}</code> · Cloudflare Artifacts
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
						<nav className="tabs" aria-label="Namespace navigation">
							{["repositories", ...(namespace.namespace.kind === "shared" ? ["members", "teams"] : []), "settings"].map((tab) => (
								<button
									type="button"
									key={tab}
									className={namespaceTab === tab ? "selected" : ""}
									aria-current={namespaceTab === tab ? "page" : undefined}
									onClick={() => navigate(route.namespaceId, "", tab)}
								>
									{tab}
								</button>
							))}
						</nav>

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
													Cloudflare Artifacts · {r.defaultBranch}
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
										: "Not connected. Connect a Cloudflare account to create repositories and workspaces."}
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
											<input name="accountId" required autoComplete="off" spellCheck={false} />
										</label>
										<label>
											API token
											<input name="token" type="password" required autoComplete="new-password" spellCheck={false} />
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
		</Shell>
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
