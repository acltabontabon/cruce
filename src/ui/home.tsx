import { useEffect, useState } from "react";
import type { Namespace, User } from "../shared/platform.ts";
import { Empty } from "./controls.tsx";
import { Icon, Pill } from "./design.tsx";
import { request } from "./request.ts";
import type { NamespaceView } from "./types.ts";

export type Summary = NonNullable<NamespaceView["repositorySummaries"]>[number];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The short attention list for a repository row; empty when nothing needs a person. */
export function AttentionPills({ summary }: { summary?: Summary }) {
	if (!summary) return <span className="muted">Status unavailable</span>;
	const { review, ready, stale, behind } = summary.attention;
	const pills = [
		review ? <Pill key="review" tone="accent">{`${review} to review`}</Pill> : null,
		ready ? <Pill key="ready" tone="success">{`${ready} ready to promote`}</Pill> : null,
		stale ? <Pill key="stale" tone="warning">{`${stale} stale`}</Pill> : null,
		behind ? <Pill key="behind" tone="warning">{`${behind} behind canonical`}</Pill> : null,
	].filter(Boolean);
	return (
		<span className="row-pills">
			{pills.length ? pills : <span className="muted">{summary.active ? plural(summary.active, "active workspace") : "Quiet"}</span>}
		</span>
	);
}

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
	const needle = filter.trim().toLowerCase();
	const rows = me.namespaces
		.flatMap((w) =>
			(spaces[w.id]?.repositories ?? []).map((repository) => ({
				namespace: w,
				repository,
				summary: spaces[w.id]?.repositorySummaries?.find((s) => s.id === repository.id),
			})),
		)
		.filter((row) => `${row.repository.name} ${row.namespace.name} ${row.namespace.handle}`.toLowerCase().includes(needle))
		.sort((a, b) => {
			const score = (s?: Summary) => (s ? s.attention.review * 4 + s.attention.ready * 3 + s.attention.stale + s.attention.behind : 0);
			return score(b.summary) - score(a.summary) || a.repository.name.localeCompare(b.repository.name);
		});
	const namespaces = me.namespaces.filter((w) =>
		`${w.name} ${w.handle} ${spaces[w.id]?.repositories.map((r) => r.name).join(" ") ?? ""}`.toLowerCase().includes(needle),
	);
	return (
		<>
			<div className="page-head">
				<h1>Your repositories</h1>
				<label className="namespace-search">
					<Icon name="search" />
					<input
						aria-label="Filter namespaces"
						placeholder="Filter repositories or namespaces…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
				</label>
			</div>
			{rows.length ? (
				<div className="rows">
					{rows.map(({ namespace, repository, summary }) => (
						<button
							type="button"
							className="repo-row"
							key={`${namespace.id}/${repository.id}`}
							onClick={() => open(namespace.id, repository.id)}
						>
							<span className="row-main">
								<strong>{repository.name}</strong>
								<small>
									{namespace.name} · <code>{repository.defaultBranch}</code>
								</small>
							</span>
							<AttentionPills summary={summary} />
							<Icon name="arrow" />
						</button>
					))}
				</div>
			) : loading ? (
				<p className="muted">Loading repositories…</p>
			) : (
				<Empty>{needle ? "No repositories match that filter." : "No repositories yet. Open a namespace to create one."}</Empty>
			)}
			<div className="section-heading">
				<h2>Namespaces</h2>
				<button type="button" onClick={create}>
					<Icon name="plus" />
					Create namespace
				</button>
			</div>
			<div className="rows">
				{namespaces.map((w) => {
					const data = spaces[w.id];
					return (
						<div className="namespace-row" key={w.id}>
							<button className="namespace-card-title" aria-label={w.name} type="button" onClick={() => open(w.id)}>
								<span className="namespace-avatar">{w.name.slice(0, 1)}</span>
								<span className="row-main">
									<strong>{w.name}</strong>
									<small>
										{w.kind === "personal" ? "Personal" : "Shared"}
										{data && ` · ${data.role}`}
										{data && ` · ${plural(data.repositories.length, "repository", "repositories")}`}
										{data && !data.account && " · Cloudflare account not connected"}
									</small>
								</span>
								<Icon name="arrow" />
							</button>
							{failures[w.id] && (
								<div role="alert" className="row-alert">
									<p>{failures[w.id]}</p>
									<button type="button" onClick={() => setRetry((n) => n + 1)}>
										Retry
									</button>
								</div>
							)}
						</div>
					);
				})}
				{!namespaces.length && <Empty>No matching namespaces.</Empty>}
			</div>
		</>
	);
}
