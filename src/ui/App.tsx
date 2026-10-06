import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, Namespace, Repository, RepositorySnapshot, User } from "../shared/platform.ts";
import { BRAND } from "./brand.tsx";
import { Empty, Form, PrefixedInput, value } from "./controls.tsx";
import { Dialog } from "./design.tsx";
import { NamespaceHome } from "./home.tsx";
import { NamespacePage, namespaceViews } from "./namespace.tsx";
import { ConsoleHeader } from "./navigation.tsx";
import { RepositoryPage, repositoryTabs } from "./repository.tsx";
import { request } from "./request.ts";
import { Shell } from "./shell.tsx";
import type { NamespaceView } from "./types.ts";
import "./styles.css";

const namespaceTabs = namespaceViews;
const tabs: readonly string[] = repositoryTabs;
/** Retired repository routes resolve to their new homes so saved links keep working. */
const legacyTabs: Record<string, string> = { overview: "changes", code: "history", artifacts: "history" };
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
			screen === "namespace" && query.get("repository")
				? tab === "work"
					? tab
					: (legacyTabs[tab] ?? (tabs.includes(tab) ? tab : "changes"))
				: namespaceTabs.includes(tab)
					? tab
					: "repositories",
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
	const navigate = useCallback((namespaceId: string, repositoryId = "", tab = "", id = "") => {
		tab ||= repositoryId ? "changes" : "repositories";
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
		// Retired work/<id> links point at a change, a workspace or a stored record; resolve once the snapshot is known.
		if (route.tab !== "work" || view?.repository.id !== route.repositoryId || view.repository.namespaceId !== route.namespaceId) return;
		const tab = view.proposals.some((p) => p.id === route.id)
			? "changes"
			: view.workspaces.some((w) => w.id === route.id)
				? "workspaces"
				: view.artifacts.some((a) => a.id === route.id)
					? "history"
					: "changes";
		const url = new URL(location.href);
		const known = tab !== "changes" || view.proposals.some((p) => p.id === route.id);
		url.hash = `/${tab}${route.id && known ? `/${route.id}` : ""}`;
		history.replaceState(null, "", url);
		setRoute(readRoute());
	}, [route, view]);

	useEffect(() => {
		void route;
		document.getElementById("content")?.focus({ preventScroll: true });
	}, [route]);
	useEffect(() => {
		// Tab titles name the thing on screen so several open tabs stay distinguishable.
		const repo = view?.repository.id === route.repositoryId ? view : undefined;
		const change = repo && route.tab === "changes" ? repo.proposals.find((p) => p.id === route.id) : undefined;
		const workspace = repo && route.tab === "workspaces" ? repo.workspaces.find((w) => w.id === route.id) : undefined;
		const parts = repo
			? [
					change ? `Review #${change.number}` : workspace ? workspace.title : route.tab[0].toUpperCase() + route.tab.slice(1),
					repo.repository.name,
				]
			: namespace?.namespace.id === route.namespaceId && route.namespaceId
				? route.tab === "settings"
					? ["Settings", namespace.namespace.name]
					: [namespace.namespace.name]
				: ["Your repositories"];
		document.title = [...parts, BRAND.name].join(" · ");
	}, [route, view, namespace]);

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
		// Keep the current namespace on screen while a refresh loads; only a different namespace clears it.
		setNamespace((current) => (current?.namespace.id === route.namespaceId ? current : undefined));
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

	const mutate = async <T,>(url: string, body: Record<string, unknown>, method = "POST", refreshAfter = true) => {
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
		if (refreshAfter) reload();
		return result;
	};
	const execute = async (command: Partial<Command> & { tool: string }) => {
		if (!view) throw new Error("Repository unavailable");
		const url = `/api/namespaces/${route.namespaceId}/repositories/${route.repositoryId}/command`;
		if (command.tool.startsWith("get_") || command.tool === "read_artifact") return request(url, command);
		if (command.tool === "inspect_source" || command.tool === "recover_source") return mutate(url, command, "POST", false);
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
					view ? (
						<RepositoryPage
							view={view}
							namespace={namespace?.namespace.id === route.namespaceId ? namespace : undefined}
							tab={route.tab === "work" ? "changes" : route.tab}
							id={route.tab === "work" ? "" : route.id}
							execute={execute}
							busy={busy}
							open={(tab, id) => navigate(route.namespaceId, route.repositoryId, tab, id)}
							mutate={mutate}
							base={base}
							onError={setError}
						/>
					) : (
						<Empty>Loading repository…</Empty>
					)
				) : namespace ? (
					<NamespacePage
						namespace={namespace}
						tab={namespaceTab}
						base={base}
						mutate={mutate}
						open={(repositoryId, tab) => navigate(route.namespaceId, repositoryId, tab)}
						newRepository={() => setOverlay("repository")}
						renamed={(w) => setMe({ ...me, namespaces: me.namespaces.map((old) => (old.id === w.id ? w : old)) })}
					/>
				) : (
					<Empty>Loading namespace…</Empty>
				)}
			</main>
			{overlay === "create-namespace" && (
				<Dialog title="Create namespace" close={() => setOverlay(undefined)}>
					<p className="dialog-lead">A shared place for your team's repositories, people and limits.</p>
					<Form
						label="Create namespace"
						primary
						cancel={() => setOverlay(undefined)}
						submit={async (d) => {
							const w = await mutate<Namespace>("/api/namespaces", { name: value(d, "name"), handle: value(d, "handle") });
							setMe({ ...me, namespaces: [...me.namespaces, w] });
							navigate(w.id);
						}}
					>
						<NamespaceFields />
					</Form>
				</Dialog>
			)}
			{overlay === "repository" && namespace?.permissions.maintain && (
				<Dialog title="New repository" close={() => setOverlay(undefined)} className="repository-dialog">
					<p className="dialog-lead">Add a repository to {namespace.namespace.name}.</p>
					<Form
						label="Add repository"
						primary
						cancel={() => setOverlay(undefined)}
						submit={async (d) => {
							const repo = await mutate<Repository>(`${base}/repositories`, {
								name: value(d, "name"),
								defaultBranch: value(d, "branch"),
							});
							navigate(namespace.namespace.id, repo.id);
						}}
					>
						<div className="form-fields repository-fields">
							<PrefixedInput
								label="Repository name"
								prefix={`${namespace.namespace.handle} /`}
								name="name"
								required
								pattern="[a-z0-9-]+"
								placeholder="auth-service"
							/>
							<label>
								Default branch
								<input name="branch" defaultValue="main" required />
							</label>
						</div>
						<p className="cost">
							Creates canonical Git storage managed by this Cruce installation. Agent workspaces consume isolated forks under namespace
							policy.
						</p>
						{!namespace.storage.ready && <p role="alert">{namespace.storage.reason}</p>}
					</Form>
				</Dialog>
			)}
		</Shell>
	);
}

/** Name and handle for a new namespace; the handle follows the name until someone edits it. */
function NamespaceFields() {
	const [name, setName] = useState(""),
		[handle, setHandle] = useState(""),
		[edited, setEdited] = useState(false);
	const slug = (text: string) =>
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 39);
	return (
		<>
			<label>
				Name
				<input
					name="name"
					required
					placeholder="e.g. Acme engineering"
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						if (!edited) setHandle(slug(e.target.value));
					}}
				/>
			</label>
			<PrefixedInput
				label="Namespace handle"
				prefix="@"
				hint="Lowercase letters, numbers and dashes. Used in links and Git remotes."
				name="handle"
				required
				pattern="[a-z0-9-]+"
				placeholder="acme"
				value={handle}
				onChange={(e) => {
					setEdited(true);
					setHandle(e.target.value);
				}}
			/>
		</>
	);
}
