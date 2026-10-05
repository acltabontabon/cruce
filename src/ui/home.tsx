import { useEffect, useState } from "react";
import type { Namespace, User } from "../shared/platform.ts";
import { BRAND } from "./brand.tsx";
import { count, Empty } from "./controls.tsx";
import { Icon } from "./design.tsx";
import { request } from "./request.ts";
import { MiniTopology } from "./topology.tsx";
import type { NamespaceView } from "./types.ts";
export function NamespaceHome({
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
					<p className="eyebrow">Independent paths. Shared context.</p>
					<h1>
						{BRAND.tagline[0]}
						<br />
						<span>{BRAND.tagline[1]}</span>
					</h1>
					<p className="page-description">Follow the work. Inspect the revision. Decide what moves forward.</p>
				</div>
				<button type="button" onClick={create}>
					<Icon name="plus" />
					Create namespace
				</button>
			</div>
			<div className="home-toolbar">
				<p>
					{count(me.namespaces.length, "namespace")} <span className="toolbar-dot">/</span>{" "}
					{loading
						? "Loading repositories…"
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
						placeholder="Filter namespaces or repositories…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
				</label>
			</div>
			{!filter && motion.length > 0 && (
				<section className="motion-panel">
					<div className="section-heading">
						<h2>Work in motion</h2>
						<span className="observed-label">Reported activity</span>
					</div>
					{motion.map((row) => (
						<button
							type="button"
							className="motion-row"
							key={`${row.namespace.id}/${row.id}`}
							onClick={() => open(row.namespace.id, row.id)}
						>
							<MiniTopology topology={row.topology} />
							<span className="motion-identity">
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
			<div className="namespace-groups">
				{matches.map((w) => {
					const data = spaces[w.id];
					return (
						<section className={`namespace-card ${w.kind}`} key={w.id}>
							<div className="namespace-group-heading">
								<button className="namespace-card-title" aria-label={w.name} type="button" onClick={() => open(w.id)}>
									<span className="namespace-avatar">{w.name.slice(0, 1)}</span>
									<span>
										<h2>{w.name}</h2>
										<code>/{w.handle}</code>
									</span>
								</button>
								<span className="space-kind">
									{w.kind === "personal" ? "Personal" : "Shared"} {data && `· ${data.role}`}
								</span>
							</div>
							{failures[w.id] ? (
								<div role="alert">
									<p>{failures[w.id]}</p>
									<button type="button" onClick={() => setRetry((n) => n + 1)}>
										Retry
									</button>
								</div>
							) : data ? (
								<div className="namespace-repositories">
									{data.repositories.length ? (
										data.repositories.map((r) => {
											const summary = data.repositorySummaries?.find((s) => s.id === r.id);
											return (
												<button type="button" className="home-repo" key={r.id} onClick={() => open(w.id, r.id)}>
													<Icon name="branch" />
													<strong>{r.name}</strong>
													<code>{r.defaultBranch}</code>
													<span className="muted">{summary ? count(summary.active, "active workspace") : "Activity unavailable"}</span>
													<Icon name="arrow" />
												</button>
											);
										})
									) : (
										<div className="namespace-card-empty">
											<p>No repositories yet. A place for your next independent effort.</p>
											<button type="button" className="text-button" onClick={() => open(w.id)}>
												Open namespace <Icon name="arrow" />
											</button>
										</div>
									)}
								</div>
							) : (
								<p className="muted">Loading repositories…</p>
							)}
						</section>
					);
				})}
			</div>
			{!matches.length && <Empty>No matching namespaces. Try a namespace name, handle, or repository.</Empty>}
			<div className="home-footer">
				<Icon name="branch" />
				<p>Isolated workspaces. Exact revisions. Human decisions.</p>
			</div>
		</>
	);
}

export function AccountPage({ me, open }: { me: { user: User; namespaces: Namespace[] }; open: (namespaceId: string) => void }) {
	return (
		<>
			<div className="page-title namespace-title">
				<div>
					<p className="eyebrow">Your corner of {BRAND.name}</p>
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
