import { useEffect, useState } from "react";
import { ATTENTION_ORDER } from "../core/attention.ts";
import type { AttentionItem, Namespace, Repository, User } from "../shared/platform.ts";
import { Empty } from "./controls.tsx";
import { Icon, Initials, PageHeader, Pill, Section } from "./design.tsx";
import { MiniLanes } from "./lanes.tsx";
import { request } from "./request.ts";
import { ACTION_LABELS, blockerSummary, GROUP_LABELS, ownerName, type People, short, waitingOn } from "./status.ts";
import type { NamespaceView } from "./types.ts";

export type Summary = NonNullable<NamespaceView["repositorySummaries"]>[number];
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
type Open = (namespaceId: string, repositoryId?: string, tab?: string, id?: string, filter?: string) => void;

/** The short attention list for a repository row; quiet when nothing needs a person. */
export function AttentionPills({ summary }: { summary?: Summary }) {
	if (!summary) return <span className="row-quiet">Status unavailable</span>;
	const { recovery, promote, review, preparation, reconciliation, mine } = summary.attention;
	const pills = [
		mine ? <Pill key="mine" tone="accent">{`${mine} for you`}</Pill> : null,
		recovery ? <Pill key="recovery" tone="danger">{`${plural(recovery, "operation")} to recover`}</Pill> : null,
		promote ? <Pill key="promote" tone="success">{`${promote} ready to promote`}</Pill> : null,
		review ? <Pill key="review" tone="accent">{`${review} to review`}</Pill> : null,
		preparation ? <Pill key="preparation" tone="warning">{`${preparation} to prepare`}</Pill> : null,
		reconciliation ? <Pill key="reconciliation" tone="warning">{`${reconciliation} to reconcile`}</Pill> : null,
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
			{repository.lifecycle?.state === "archived" ? (
				<Pill tone="neutral">Archived</Pill>
			) : repository.lifecycle?.state === "deleting" ? (
				<Pill tone="danger">Deleting</Pill>
			) : (
				<AttentionPills summary={summary} />
			)}
			<Icon name="arrow" className="row-arrow" />
		</button>
	);
}

/** Counts across repositories for the stat strip. */
export function totals(summaries: (Summary | undefined)[]) {
	return summaries.reduce(
		(sum, s) => ({
			mine: sum.mine + (s?.attention.mine ?? 0),
			review: sum.review + (s?.attention.review ?? 0),
			ready: sum.ready + (s?.attention.promote ?? 0),
			active: sum.active + (s?.active ?? 0),
		}),
		{ mine: 0, review: 0, ready: 0, active: 0 },
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

type Row = { namespace: Namespace; repository: Repository; summary?: Summary; who: People };

/** One attention item: where, what, who owns it, the exact revision, the primary blocker, and this viewer's next step. */
function AttentionRow({ row, item, open }: { row: Row; item: AttentionItem; open: Open }) {
	const kind = GROUP_LABELS[item.group];
	const action = item.mine ? ACTION_LABELS[item.actions[0]] : waitingOn(item);
	return (
		<button
			type="button"
			className={`decision-row ${kind.tone}`}
			onClick={() => open(row.namespace.id, row.repository.id, item.subject === "change" ? "changes" : "workspaces", item.id)}
		>
			<span className="decision-edge" aria-hidden="true" />
			<span className="row-main">
				<span className="decision-where">
					{row.namespace.handle}/{row.repository.name}
				</span>
				<span className="decision-title">
					{item.number !== undefined && <span className="row-number">#{item.number}</span>}
					{item.title}
					<Pill tone={kind.tone}>{kind.label}</Pill>
				</span>
				<span className="decision-owner">
					Owner: {ownerName(item.ownerId, row.who)} · <code title={item.revision}>{short(item.revision)}</code>
					{item.base && (
						<>
							{item.subject === "change" ? " on review base " : " compared with canonical "}
							<code title={item.base}>{short(item.base)}</code>
						</>
					)}
				</span>
				<span className="decision-why">{blockerSummary(item)}</span>
			</span>
			<span className={`decision-action${item.mine ? " primary" : " waiting-on"}`} aria-hidden="true">
				{action}
			</span>
		</button>
	);
}

/** Says when a capped summary omits items, with the route to the full filtered list. */
function Truncated({ rows, mine, open }: { rows: Row[]; mine: boolean; open: Open }) {
	const capped = rows.flatMap((row) => {
		if (!row.summary) return [];
		const shown = row.summary.items.filter((item) => item.mine === mine).length,
			total = mine ? row.summary.attention.mine : row.summary.attention.total - row.summary.attention.mine;
		return shown < total ? [{ row, shown, total }] : [];
	});
	if (!capped.length) return null;
	return (
		<ul className="truncated">
			{capped.map(({ row, shown, total }) => (
				<li key={row.repository.id}>
					Showing {shown} of {total} in {row.repository.name}.{" "}
					<button
						type="button"
						className="text-button"
						onClick={() => open(row.namespace.id, row.repository.id, "workspaces", "", mine ? "needs-you" : "")}
					>
						Open the full list
					</button>
				</li>
			))}
		</ul>
	);
}

function order(a: AttentionItem, b: AttentionItem) {
	return ATTENTION_ORDER.indexOf(a.group) - ATTENTION_ORDER.indexOf(b.group) || b.at - a.at || (b.number ?? 0) - (a.number ?? 0);
}

/** Decisions this viewer can make now across repositories, then visible work waiting on its owner or a maintainer. */
function Decisions({ rows, open, partial }: { rows: Row[]; open: Open; partial: boolean }) {
	const all = rows
		.filter((row) => !row.repository.lifecycle || row.repository.lifecycle.state === "active")
		.flatMap((row) => (row.summary?.items ?? []).map((item) => ({ row, item })));
	const mine = all.filter(({ item }) => item.mine).sort((a, b) => order(a.item, b.item)),
		others = all.filter(({ item }) => !item.mine).sort((a, b) => order(a.item, b.item));
	const mineTotal = rows.reduce((n, row) => n + (row.summary?.attention.mine ?? 0), 0),
		othersTotal = rows.reduce((n, row) => n + (row.summary ? row.summary.attention.total - row.summary.attention.mine : 0), 0);
	return (
		<>
			<Section title="Needs you" count={mineTotal}>
				{mine.length ? (
					<div className="rows">
						{mine.map(({ row, item }) => (
							<AttentionRow key={`${row.repository.id}/${item.id}`} row={row} item={item} open={open} />
						))}
					</div>
				) : (
					<p className="calm">{partial ? "Nothing needs you in the repositories that loaded." : "Nothing needs you right now."}</p>
				)}
				<Truncated rows={rows} mine open={open} />
			</Section>
			{othersTotal > 0 && (
				<details className="group waiting">
					<summary>{`Waiting on others · ${othersTotal}`}</summary>
					<p className="panel-note">Visible work whose next step belongs to its owner or a maintainer. You can still inspect it.</p>
					<div className="rows">
						{others.map(({ row, item }) => (
							<AttentionRow key={`${row.repository.id}/${item.id}`} row={row} item={item} open={open} />
						))}
					</div>
					<Truncated rows={rows} mine={false} open={open} />
				</details>
			)}
		</>
	);
}

/** Facts worth knowing that need no decision: quiet checkouts, shared reported paths, and unknown ancestry. */
function HeadsUp({ rows, open }: { rows: Row[]; open: Open }) {
	const items = rows.flatMap(({ namespace, repository, summary }) => {
		if (!summary) return [];
		const quiet = (summary.lanes ?? []).filter((lane) => lane.quiet).length;
		return [
			quiet && {
				key: "quiet",
				label: "Quiet",
				tone: "neutral",
				text: `${plural(quiet, "workspace")} not reporting; checkouts remain attached`,
			},
			summary.overlaps && {
				key: "shared",
				label: "Shared",
				tone: "warning",
				text: `${plural(summary.overlaps, "path")} reported by more than one workspace`,
			},
			summary.attention.ancestryUnavailable && {
				key: "unknown",
				label: "Unknown",
				tone: "neutral",
				text: `Ancestry unavailable for ${plural(summary.attention.ancestryUnavailable, "workspace")}`,
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
				who: { viewerId: me.user.id, people: spaces[w.id]?.people },
			})),
		)
		.filter((row) => `${row.repository.name} ${row.namespace.name} ${row.namespace.handle}`.toLowerCase().includes(needle))
		.sort((a, b) => {
			const score = (s?: Summary) =>
				s
					? s.attention.recovery * 5 +
						s.attention.mine * 4 +
						s.attention.promote * 3 +
						s.attention.review * 2 +
						s.attention.preparation +
						s.attention.reconciliation
					: 0;
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
												<small className="namespace-meta">
													<span>
														{w.kind === "personal" ? "Personal" : "Shared"}
														{data && ` · ${data.role[0].toUpperCase()}${data.role.slice(1)}`}
													</span>
													{data && <span>{plural(data.repositories.length, "repository", "repositories")}</span>}
													{data && !data.storage.ready && <span className="namespace-storage">Installation storage unavailable</span>}
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
