import { useEffect, useState } from "react";
import type { Namespace, Repository, User } from "../shared/platform.ts";
import { Empty } from "./controls.tsx";
import { Icon, Initials, PageHeader, Pill, Section } from "./design.tsx";
import { MiniLanes } from "./lanes.tsx";
import { request } from "./request.ts";
import { actorLabel, short } from "./status.ts";
import type { NamespaceView } from "./types.ts";

export type Summary = NonNullable<NamespaceView["repositorySummaries"]>[number];
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
type Open = (namespaceId: string, repositoryId?: string, tab?: string, id?: string) => void;

/** The short attention list for a repository row; quiet when nothing needs a person. */
export function AttentionPills({ summary }: { summary?: Summary }) {
	if (!summary) return <span className="row-quiet">Status unavailable</span>;
	const { review, ready, stale, behind } = summary.attention;
	const pills = [
		review ? <Pill key="review" tone="accent">{`${review} to review`}</Pill> : null,
		ready ? <Pill key="ready" tone="success">{`${ready} ready to promote`}</Pill> : null,
		stale ? <Pill key="stale" tone="warning">{`${stale} stale`}</Pill> : null,
		behind ? <Pill key="behind" tone="warning">{`${behind} behind canonical`}</Pill> : null,
	].filter(Boolean);
	return <span className="row-pills">{pills.length ? pills : <span className="row-quiet">Nothing waiting</span>}</span>;
}

export function RepositoryRow({
	repository,
	summary,
	scope,
	open,
}: {
	repository: Repository;
	summary?: Summary;
	scope?: string;
	open: () => void;
}) {
	return (
		<button type="button" className="repo-row" onClick={open}>
			<span className="row-main">
				<strong>{repository.name}</strong>
				<small className="row-meta">
					{scope && <span>{scope}</span>}
					<code>{repository.defaultBranch}</code>
					{summary && <span>{summary.active ? plural(summary.active, "active workspace") : "No active workspaces"}</span>}
				</small>
			</span>
			{summary?.lanes && <MiniLanes lanes={summary.lanes} />}
			<AttentionPills summary={summary} />
			<Icon name="arrow" className="row-arrow" />
		</button>
	);
}

/** Counts across repositories for the stat strip. */
export function totals(summaries: (Summary | undefined)[]) {
	return summaries.reduce(
		(sum, s) => ({
			review: sum.review + (s?.attention.review ?? 0),
			ready: sum.ready + (s?.attention.ready ?? 0),
			active: sum.active + (s?.active ?? 0),
		}),
		{ review: 0, ready: 0, active: 0 },
	);
}

export function SkeletonRows({ label }: { label: string }) {
	return (
		<div className="rows skeleton" aria-busy="true">
			<p className="sr-only">{label}</p>
			{[0, 1, 2].map((n) => (
				<span key={n} className="skeleton-row" aria-hidden="true">
					<span />
					<span />
				</span>
			))}
		</div>
	);
}

type Row = { namespace: Namespace; repository: Repository; summary?: Summary };
const decisionKinds = {
	review: { label: "Needs review", tone: "accent", action: "Review", primary: true, order: 0 },
	ready: { label: "Ready to promote", tone: "success", action: "Promote", primary: true, order: 1 },
	stale: { label: "Stale", tone: "warning", action: "Open", primary: false, order: 2 },
} as const;

/** Every change waiting on a person, across repositories, each with the one action that moves it forward. */
function Decisions({ rows, open, partial }: { rows: Row[]; open: Open; partial: boolean }) {
	const decisions = rows
		.flatMap((row) => (row.summary?.changes ?? []).map((change) => ({ ...row, change })))
		.sort((a, b) => decisionKinds[a.change.status].order - decisionKinds[b.change.status].order || b.change.number - a.change.number);
	return (
		<Section title="Needs you" count={decisions.length}>
			{decisions.length ? (
				<div className="rows">
					{decisions.map(({ namespace, repository, change }) => {
						const kind = decisionKinds[change.status];
						const why =
							change.status === "review"
								? `${change.actor ? `${actorLabel({ name: change.actor, kind: "agent" })} published` : "Published"} ${short(change.revision)}. Confirm its checks, then approve this exact revision.`
								: change.status === "ready"
									? `Every check passed for ${short(change.revision)}. Promoting moves canonical to exactly this revision.`
									: "Canonical moved past its base. Its workspace merges canonical with Git and publishes again.";
						return (
							<button
								type="button"
								key={`${repository.id}/${change.id}`}
								className={`decision-row ${kind.tone}`}
								onClick={() => open(namespace.id, repository.id, "changes", change.id)}
							>
								<span className="decision-edge" aria-hidden="true" />
								<span className="row-main">
									<span className="decision-where">
										{namespace.handle}/{repository.name}
									</span>
									<span className="decision-title">
										<span className="row-number">#{change.number}</span>
										{change.title}
										<Pill tone={kind.tone}>{kind.label}</Pill>
									</span>
									<span className="decision-why">{why}</span>
								</span>
								<span className={`decision-action${kind.primary ? " primary" : ""}`} aria-hidden="true">
									{kind.action}
								</span>
							</button>
						);
					})}
				</div>
			) : (
				<p className="calm">{partial ? "Nothing waiting in the repositories that loaded." : "Nothing needs you right now."}</p>
			)}
		</Section>
	);
}

/** Facts worth knowing that need no decision yet: work behind canonical, quiet checkouts, shared paths. */
function HeadsUp({ rows, open }: { rows: Row[]; open: Open }) {
	const items = rows.flatMap(({ namespace, repository, summary }) => {
		if (!summary) return [];
		const quiet = (summary.lanes ?? []).filter((lane) => lane.quiet).length;
		return [
			summary.attention.behind && {
				key: "behind",
				label: "Behind",
				tone: "warning",
				text: `${plural(summary.attention.behind, "workspace")} behind canonical`,
			},
			quiet && { key: "quiet", label: "Quiet", tone: "neutral", text: `${plural(quiet, "workspace")} stopped reporting` },
			summary.overlaps && {
				key: "shared",
				label: "Shared",
				tone: "warning",
				text: `${plural(summary.overlaps, "file")} changed in more than one workspace`,
			},
		]
			.filter((item): item is { key: string; label: string; tone: string; text: string } => !!item)
			.map((item) => ({ ...item, namespace, repository }));
	});
	if (!items.length) return null;
	return (
		<Section title="Heads-up" count={items.length} action={<span className="row-quiet">No decision needed yet</span>}>
			<div className="rows">
				{items.map((item) => (
					<button
						type="button"
						key={`${item.repository.id}/${item.key}`}
						className="heads-row"
						onClick={() => open(item.namespace.id, item.repository.id, "workspaces")}
					>
						<Pill tone={item.tone}>{item.label}</Pill>
						<span className="row-main">
							{item.text}
							<span className="decision-where">
								{" · "}
								{item.namespace.handle}/{item.repository.name}
							</span>
						</span>
						<Icon name="arrow" className="row-arrow" />
					</button>
				))}
			</div>
		</Section>
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
	open: Open;
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
		let pending = false;
		const load = async () => {
			if (pending) return;
			pending = true;
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
			pending = false;
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
	const all = me.namespaces.flatMap(
		(w) => spaces[w.id]?.repositories.map((r) => spaces[w.id]?.repositorySummaries?.find((s) => s.id === r.id)) ?? [],
	);
	const partial = Object.keys(failures).length > 0 || all.some((summary) => !summary);
	return (
		<>
			<PageHeader kicker="All namespaces" title="Your repositories">
				<label className="filter-field">
					<Icon name="search" />
					<input
						aria-label="Filter namespaces"
						placeholder="Filter repositories…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
				</label>
			</PageHeader>
			<div className="overview">
				{partial && (
					<p role="status">
						Some repository status is unavailable. Counts cover available repositories.{" "}
						<button type="button" onClick={() => setRetry((n) => n + 1)}>
							Retry unavailable repositories
						</button>
					</p>
				)}
				<div className="overview-main">
					{loading && !rows.length ? (
						<Section title="Needs you">
							<SkeletonRows label="Loading what needs you…" />
						</Section>
					) : (
						<Decisions rows={rows} open={open} partial={partial} />
					)}
					<HeadsUp rows={rows} open={open} />
					<Section title="Repositories" count={rows.length}>
						{rows.length ? (
							<div className="rows">
								{rows.map(({ namespace, repository, summary }) => (
									<RepositoryRow
										key={`${namespace.id}/${repository.id}`}
										repository={repository}
										summary={summary}
										scope={namespace.name}
										open={() => open(namespace.id, repository.id)}
									/>
								))}
							</div>
						) : loading ? (
							<SkeletonRows label="Loading repositories…" />
						) : (
							<Empty>{needle ? "No repositories match that filter." : "No repositories yet. Open a namespace to create one."}</Empty>
						)}
					</Section>
				</div>
				<aside className="overview-side" aria-label="Namespaces">
					<Section
						title="Namespaces"
						count={me.namespaces.length}
						action={
							<button type="button" className="ghost" onClick={create}>
								<Icon name="plus" />
								Create namespace
							</button>
						}
					>
						<div className="rows">
							{namespaces.map((w) => {
								const data = spaces[w.id];
								return (
									<div className="namespace-row" key={w.id}>
										<button className="namespace-link" aria-label={w.name} type="button" onClick={() => open(w.id)}>
											<Initials name={w.name} className={w.kind} />
											<span className="row-main">
												<strong>{w.name}</strong>
												<small className="row-meta">
													<span>{w.kind === "personal" ? "Personal" : "Shared"}</span>
													{data && <span>{data.role}</span>}
													{data && <span>{plural(data.repositories.length, "repository", "repositories")}</span>}
													{data && !data.storage.ready && <span>Installation storage unavailable</span>}
												</small>
											</span>
											<Icon name="arrow" className="row-arrow" />
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
					</Section>
				</aside>
			</div>
		</>
	);
}
