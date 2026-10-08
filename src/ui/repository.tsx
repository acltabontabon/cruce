import { useState } from "react";
import { gitRemotePath } from "../shared/git-access.ts";
import type { AttentionGroup, Promotion, Proposal, RepositoryLifecycleView, RepositorySnapshot } from "../shared/platform.ts";
import { ChangeDetail } from "./change.tsx";
import { Form, value } from "./controls.tsx";
import { BackLink, CopyCommand, Dialog, Icon, Initials, PageHeader, Pill, Section, SettingRow } from "./design.tsx";
import { laneIndex } from "./lanes.ts";
import { LaneBullet, LaneTrack } from "./lanes.tsx";
import { START_PROMPT } from "./local-setup.tsx";
import { ArchivedRecord, EarlierWork, RetainedActivity, RetainedRecordDetail, RetainedRecordRow } from "./records.tsx";
import { type Execute, RevisionBrowser } from "./source.tsx";
import {
	ACTION_LABELS,
	activityText,
	actorLabel,
	ago,
	attention,
	attentionItem,
	blockerSummary,
	canonicalRelation,
	changeGroups,
	changeStatus,
	ended,
	GROUP_LABELS,
	lastPromotion,
	ownerName,
	type People,
	short,
	waitingOn,
} from "./status.ts";
import type { NamespaceView } from "./types.ts";
import { WorkspaceDetail, WorkspaceList } from "./work.tsx";

type Open = (tab: string, id?: string, filter?: string) => void;
export type Mutate = <T>(url: string, body: Record<string, unknown>, method?: string) => Promise<T>;
export const repositoryTabs = ["changes", "workspaces", "history", "settings"] as const;

function plural(n: number, one: string, many = `${one}s`) {
	return `${n} ${n === 1 ? one : many}`;
}

/** Shown when creation stopped before canonical Git existed; the retry replays the original setup operation. */
function CanonicalSetup({ view, execute }: { view: RepositorySnapshot; execute: Execute }) {
	const [error, setError] = useState(""),
		[working, setWorking] = useState(false);
	if (!view.canonicalSetup.required && !view.canonicalSetup.settlementPending) return null;
	return (
		<div className="alert canonical-setup" role="status">
			<p>
				{view.canonicalSetup.settlementPending ? (
					<>Canonical Git is ready. Finish recording setup with the original resource reservation.</>
				) : (
					<>
						<strong>Canonical storage was not created.</strong> Repository creation stopped before Cruce could set up this repository's
						canonical Git storage in this Cruce installation, so cloning and workspaces are unavailable.{" "}
						{view.canonicalSetup.retry
							? "Retrying reuses the original setup operation and its reservation."
							: "A repository maintainer can retry setup."}
					</>
				)}
			</p>
			{view.canonicalSetup.retry && (
				<button
					type="button"
					disabled={working}
					onClick={() => {
						setWorking(true);
						setError("");
						void execute({ tool: "retry_repository_setup" })
							.catch((e) => setError((e as Error).message))
							.finally(() => setWorking(false));
					}}
				>
					{working ? "Retrying setup…" : view.canonicalSetup.settlementPending ? "Finish setup" : "Retry setup"}
				</button>
			)}
			{error && <p role="alert">{error}</p>}
		</div>
	);
}

/** One item per thing that needs attention; each count opens the filtered list behind it. Missing knowledge stays separate. */
function AttentionBar({ view, open }: { view: RepositorySnapshot; open: Open }) {
	const a = attention(view);
	const items: { count?: number; label: string; tab: string; filter?: string; tone: string }[] = [];
	const counted = (count: number, one: string, many: string, tab: string, tone: string, filter?: string) => {
		if (count) items.push({ count, label: count === 1 ? one : many, tab, tone, filter });
	};
	counted(a.recovery, "operation needs attention", "operations need attention", "changes", "danger", "recovery");
	counted(a.promote, "change ready to promote", "changes ready to promote", "changes", "success", "promote");
	counted(a.review, "change needs human review", "changes need human review", "changes", "accent", "review");
	counted(a.preparation, "change needs preparation", "changes need preparation", "changes", "warning", "preparation");
	counted(a.reconcileChanges, "change needs a Git update", "changes need Git updates", "changes", "warning", "reconciliation");
	counted(a.reconcileWorkspaces, "workspace needs a Git update", "workspaces need Git updates", "workspaces", "warning", "reconcile");
	counted(a.unproposed, "workspace published, not proposed", "workspaces published, not proposed", "workspaces", "accent", "unproposed");
	counted(a.overlaps, "path reported by more than one workspace", "paths reported by more than one workspace", "workspaces", "warning");
	if (view.reconciliation?.observation.state === "degraded")
		items.push({ label: "Observation degraded", tab: "workspaces", tone: "warning" });
	counted(a.ancestryUnavailable, "workspace with ancestry unavailable", "workspaces with ancestry unavailable", "workspaces", "neutral");
	if (
		view.reconciliation &&
		(view.reconciliation.workspaces.length || view.reconciliation.proposals.length) &&
		!items.some((item) => item.tab === "workspaces")
	)
		items.push({ label: "Inspect reconciliation", tab: "workspaces", tone: "neutral" });
	counted(a.quiet, "workspace not reporting", "workspaces not reporting", "workspaces", "neutral");
	return (
		<section className="attention" aria-label="Needs attention">
			{items.length ? (
				items.map((item) => (
					<button
						type="button"
						key={item.label}
						className={`attention-item ${item.tone}`}
						onClick={() => open(item.tab, undefined, item.filter)}
					>
						{item.count !== undefined && <b>{item.count}</b>} {item.label}
					</button>
				))
			) : (
				<p className="attention-clear">Nothing needs attention right now.</p>
			)}
		</section>
	);
}

/** A change row leads with the accountable owner, the exact revision and what blocks it. */
function ChangeRow({ view, p, open, who }: { view: RepositorySnapshot; p: Proposal; open: Open; who: People }) {
	const s = changeStatus(view, p),
		item = attentionItem(view, p.id),
		workspace = view.workspaces.find((w) => w.id === p.workspaceId);
	return (
		<button type="button" className="change-row" onClick={() => open("changes", p.id)}>
			<LaneTrack lane={laneIndex(view).get(p.workspaceId)} done={s.key === "promoted"} />
			<span className="row-number">#{p.number}</span>
			<span className="row-main">
				<strong>{p.title}</strong>
				<small className="row-meta">
					{workspace && <span className="owner">Owner: {ownerName(workspace.ownerId, who)}</span>}
					<span>
						<code title={p.revision}>{short(p.revision)}</code> on review base <code title={p.base}>{short(p.base)}</code>
					</span>
					{workspace && <span>{workspace.title}</span>}
				</small>
				{item && (
					<small className="row-blocker">
						{blockerSummary(item)}
						{" · "}
						<span className={item.mine ? "next-mine" : undefined}>{item.mine ? ACTION_LABELS[item.actions[0]] : waitingOn(item)}</span>
					</small>
				)}
			</span>
			<Pill tone={s.tone}>{s.label}</Pill>
			<Icon name="arrow" className="row-arrow" />
		</button>
	);
}

function CloseSuperseded({ view, execute }: { view: RepositorySnapshot; execute: Execute }) {
	const [working, setWorking] = useState(false),
		[error, setError] = useState("");
	const superseded = view.proposals.map((p) => ({ p, status: changeStatus(view, p) })).filter(({ status }) => status.key === "superseded");
	if (!superseded.length || !view.permissions.maintain || !view.permissions.human) return null;
	return (
		<div className="group-actions">
			<button
				type="button"
				disabled={working}
				onClick={() => {
					setWorking(true);
					setError("");
					// One reasoned rejection per change; each keeps its own operation identity.
					void superseded
						.reduce<Promise<unknown>>(
							(chain, { p, status }) => chain.then(() => execute({ tool: "reject_proposal", proposalId: p.id, reason: status.label })),
							Promise.resolve(),
						)
						.catch((e) => setError((e as Error).message))
						.finally(() => setWorking(false));
				}}
			>
				{working ? "Closing…" : `Close ${plural(superseded.length, "superseded change")}`}
			</button>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}

function CanonicalPanel({ view, open }: { view: RepositorySnapshot; open: Open }) {
	const promotions = view.promotions.filter((p) => p.state === "complete").sort((a, b) => b.at - a.at);
	return (
		<Section
			title="Canonical"
			action={
				view.sourceAvailable && (
					<button type="button" className="ghost" onClick={() => open("history", "canonical")}>
						Files
					</button>
				)
			}
		>
			<div className="canonical-card">
				<p className="canonical-head">
					<Icon name="branch" />
					<code>{view.repository.defaultBranch}</code>
					<code className="revision" title={view.sourceHead}>
						{view.sourceHead ? short(view.sourceHead) : "unavailable"}
					</code>
				</p>
				{promotions.length ? (
					<ol className="mini-timeline">
						{promotions.slice(0, 3).map((promotion) => {
							const change = view.proposals.find((p) => p.id === promotion.proposalId);
							return (
								<li key={promotion.id}>
									<code>{short(promotion.to)}</code>
									<span>
										{change ? `${change.title} #${change.number}` : "Promotion"} · {ago(promotion.at)}
									</span>
								</li>
							);
						})}
					</ol>
				) : (
					<p className="panel-note">Nothing promoted yet.</p>
				)}
				<button type="button" className="text-button" onClick={() => open("history")}>
					Full history <Icon name="arrow" />
				</button>
			</div>
		</Section>
	);
}

function LiveWorkspaces({ view, open, who }: { view: RepositorySnapshot; open: Open; who: People }) {
	const live = view.workspaces.filter((w) => !ended(w)).sort((a, b) => b.lastActivity - a.lastActivity),
		colours = laneIndex(view);
	return (
		<Section
			title="Workspaces"
			count={live.length}
			action={
				live.length > 0 && (
					<button type="button" className="ghost" onClick={() => open("workspaces")}>
						All
					</button>
				)
			}
		>
			{live.length ? (
				<div className="rows">
					{live.slice(0, 5).map((w) => {
						const relation = canonicalRelation(view, w);
						return (
							<button type="button" key={w.id} className="mini-row" onClick={() => open("workspaces", w.id)}>
								<LaneBullet lane={colours.get(w.id)} />
								<span className="row-main">
									<strong>{w.title}</strong>
									<small>Owner: {ownerName(w.ownerId, who)}</small>
								</span>
								<span className={`dot ${relation.tone}`} title={relation.label} />
							</button>
						);
					})}
				</div>
			) : (
				<p className="panel-note">No active workspaces. One appears when you or an agent starts work through Cruce.</p>
			)}
		</Section>
	);
}

const changeFilters = ["mine", "recovery", "promote", "review", "preparation", "reconciliation"] as const;
function ChangesScreen({
	view,
	open,
	execute,
	who,
	filter,
}: {
	view: RepositorySnapshot;
	open: Open;
	execute: Execute;
	who: People;
	filter: string;
}) {
	const groups = changeGroups(view);
	const active = (changeFilters as readonly string[]).includes(filter) ? filter : "";
	const proposal = (id: string) => view.proposals.find((p) => p.id === id);
	const shown = groups.attention
		.filter(({ group }) => !active || active === "mine" || active === group)
		.map(({ group, items }) => ({ group, items: items.filter((item) => active !== "mine" || item.mine) }));
	const open_ = shown.reduce((n, { items }) => n + items.length, 0),
		all = groups.attention.reduce((n, { items }) => n + items.length, 0);
	return (
		<div className="overview changes-screen">
			<div className="overview-main">
				<nav className="segmented filters" aria-label="Filter changes">
					<button type="button" aria-pressed={!active} onClick={() => open("changes")}>
						All open
					</button>
					<button type="button" aria-pressed={active === "mine"} onClick={() => open("changes", undefined, "mine")}>
						Needs you
					</button>
					{active && active !== "mine" && (
						<button type="button" aria-pressed="true" onClick={() => open("changes")}>
							{GROUP_LABELS[active as AttentionGroup].label} · show all
						</button>
					)}
				</nav>
				{active && (
					<p className="panel-note" role="status">
						Showing {open_} of {all} open {all === 1 ? "change" : "changes"}.
					</p>
				)}
				{shown
					.filter(({ items }) => items.length)
					.map(({ group, items }) => (
						<Section key={group} title={GROUP_LABELS[group].label} count={items.length}>
							<div className="rows">
								{items.map((item) => {
									const p = proposal(item.id);
									return p ? <ChangeRow key={p.id} view={view} p={p} open={open} who={who} /> : null;
								})}
							</div>
						</Section>
					))}
				{!open_ &&
					(view.proposals.length ? (
						<p className="panel-note">{active === "mine" ? "Nothing here needs you right now." : "No open changes match."}</p>
					) : (
						<div className="empty-state">
							<h3>No changes yet</h3>
							<p>
								When an agent or developer publishes a revision and proposes it, it shows up here for review against canonical. Use Set up
								locally above to start.
							</p>
						</div>
					))}
				{groups.inactive.length > 0 && (
					<details className="group">
						<summary>{plural(groups.inactive.length, "superseded change")}</summary>
						<CloseSuperseded view={view} execute={execute} />
						<div className="rows">
							{groups.inactive.map((p) => (
								<ChangeRow key={p.id} view={view} p={p} open={open} who={who} />
							))}
						</div>
					</details>
				)}
				{groups.done.length > 0 && (
					<details className="group">
						<summary>{plural(groups.done.length, "promoted or closed change")}</summary>
						<div className="rows">
							{groups.done.map((p) => (
								<ChangeRow key={p.id} view={view} p={p} open={open} who={who} />
							))}
						</div>
					</details>
				)}
			</div>
			<aside className="overview-side" aria-label="Repository state">
				<CanonicalPanel view={view} open={open} />
				<LiveWorkspaces view={view} open={open} who={who} />
			</aside>
		</div>
	);
}

/** One readable promotion record: the exact revision, who approved it, who promoted it, its workspace owner and evidence. */
function PromotionEntry({ view, promotion, open, who }: { view: RepositorySnapshot; promotion: Promotion; open: Open; who: People }) {
	const change = view.proposals.find((p) => p.id === promotion.proposalId);
	const workspace = change && view.workspaces.find((w) => w.id === change.workspaceId);
	const approval = change?.reviews
		.filter((r) => r.revision === promotion.to && r.outcome === "approve" && r.approvalAuthority === "human-maintainer")
		.at(-1);
	const evidence = change
		? view.verifications.filter((v) => v.proposalId === change.id && v.revision === promotion.to && v.outcome === "pass")
		: [];
	const lane = change && laneIndex(view).get(change.workspaceId);
	return (
		<li className={lane ? `lane-${lane}` : undefined}>
			<code title={promotion.to}>{short(promotion.to)}</code>
			<span>
				{change ? (
					<button type="button" className="text-button" onClick={() => open("changes", change.id)}>
						{change.title} #{change.number}
					</button>
				) : (
					"Promotion"
				)}{" "}
				· promoted by {actorLabel(promotion.actor)} · {ago(promotion.at)}
				<small className="promotion-facts">
					{approval ? `Approved by ${actorLabel(approval.actor)}` : "Approval record unavailable"}
					{workspace && (
						<>
							{" · from "}
							<button type="button" className="text-button" onClick={() => open("workspaces", workspace.id)}>
								{workspace.title}
							</button>
							{`, owner ${ownerName(workspace.ownerId, who)}`}
						</>
					)}
					{" · moved from "}
					<code title={promotion.from}>{short(promotion.from)}</code>
					{evidence.length
						? ` · ${[...new Set(evidence.map((v) => `${v.kind} ${v.trust === "reported" ? "reported" : "attested"}`))].join(", ")}`
						: " · no passing evidence recorded"}
				</small>
			</span>
		</li>
	);
}

function HistoryScreen({
	view,
	id,
	execute,
	open,
	who,
}: {
	view: RepositorySnapshot;
	id: string;
	execute: Execute;
	open: Open;
	who: People;
}) {
	// "canonical" browses the current canonical revision; it is checked first so record IDs can't shadow it.
	const record = id === "canonical" ? undefined : view.artifacts.find((a) => a.id === id);
	if (record)
		return (
			<article className="detail-page">
				<BackLink label="History" onClick={() => open("history")} />
				<RetainedRecordDetail id={record.id} view={view} execute={execute} open={open} />
				{record.kind === "source" && view.sourceAvailable && (
					<RevisionBrowser key={record.id} revision={record.revision} execute={execute} />
				)}
			</article>
		);
	if (id === "canonical")
		return (
			<article className="detail-page">
				<BackLink label="History" onClick={() => open("history")} />
				<PageHeader kicker={<span>Canonical {view.repository.defaultBranch}</span>} title="Browse source" />
				{view.sourceAvailable ? (
					<RevisionBrowser revision={view.sourceHead ?? ""} execute={execute} editable />
				) : (
					<p className="empty">Source becomes browsable once canonical exists or a revision is published.</p>
				)}
			</article>
		);
	// Finished work leaves the live view once its fork is cleaned up; any ID it contains still opens it.
	if (id) return <ArchivedRecord key={id} id={id} execute={execute} open={open} who={who} missing="That record is unavailable." />;
	const promotions = view.promotions.filter((p) => p.state === "complete").sort((a, b) => b.at - a.at);
	const created = view.activity.find((e) => e.kind === "repository_created");
	const publications = view.artifacts.filter((a) => a.kind === "source").toReversed(),
		evidence = view.artifacts.filter((a) => a.kind === "evidence").toReversed();
	return (
		<div className="overview history-screen">
			<div className="overview-main">
				<Section
					title={`Canonical ${view.repository.defaultBranch}`}
					action={
						<button type="button" className="ghost" onClick={() => open("history", "canonical")}>
							Browse files
						</button>
					}
				>
					<ol className="canonical-timeline">
						{promotions.map((promotion) => (
							<PromotionEntry key={promotion.id} view={view} promotion={promotion} open={open} who={who} />
						))}
						{created && (
							<li>
								<code>{short(created.ids[1])}</code>
								<span>Repository created · {ago(created.at)}</span>
							</li>
						)}
						{view.sourceHead && !promotions.length && created?.ids[1] !== view.sourceHead && (
							<li>
								<code>{short(view.sourceHead)}</code>
								<span>Current canonical revision</span>
							</li>
						)}
						{!view.sourceHead && !promotions.length && !created && <li className="muted">No canonical history recorded yet.</li>}
					</ol>
				</Section>
				<Section title="Activity">
					{view.activity.length ? (
						<ol className="feed">
							{view.activity
								.slice(-40)
								.toReversed()
								.map((e) => (
									<li key={e.id}>
										<time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
											{ago(e.at)}
										</time>
										<span>{activityText(e)}</span>
									</li>
								))}
						</ol>
					) : (
						<p className="panel-note">No activity yet.</p>
					)}
					<RetainedActivity execute={execute} />
				</Section>
			</div>
			<aside className="overview-side" aria-label="Retained records">
				<Section title="Published revisions" count={publications.length}>
					{publications.length ? (
						<div className="rows">
							{publications.map((a) => (
								<RetainedRecordRow key={a.id} record={a} open={(id) => open("history", id)} />
							))}
						</div>
					) : (
						<p className="panel-note">Revisions appear here once a workspace publishes them.</p>
					)}
				</Section>
				<Section title="Earlier work" count={view.archiveCount}>
					<EarlierWork execute={execute} total={view.archiveCount} open={(id) => open("history", id)} who={who} />
				</Section>
				{evidence.length > 0 && (
					<Section title="Evidence" count={evidence.length}>
						<div className="rows">
							{evidence.map((a) => (
								<RetainedRecordRow key={a.id} record={a} open={(id) => open("history", id)} />
							))}
						</div>
					</Section>
				)}
			</aside>
		</div>
	);
}

type SetupMethod = "clone" | "attach";
/** What one repository needs locally. Installing, authorizing Git and connecting tools happen once, in Local setup. */
function ConnectGuide({ view, initial = "clone", openSetup }: { view: RepositorySnapshot; initial?: SetupMethod; openSetup: () => void }) {
	const [method, setMethod] = useState<SetupMethod>(initial);
	const url = `${location.origin}${gitRemotePath(view.repository.namespaceId, view.repository.id)}`;
	return (
		<div className="connect-guide">
			<p className="muted">
				First time on this machine? Install the client, authorize Git and connect your tools once in{" "}
				<a
					href="/?page=setup"
					onClick={(event) => {
						if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
						event.preventDefault();
						openSetup();
					}}
				>
					Local setup
				</a>
				.
			</p>
			<nav className="segmented" aria-label="Setup method">
				{(["clone", "attach"] as const).map((mode) => (
					<button type="button" key={mode} aria-pressed={method === mode} disabled={!view.sourceHead} onClick={() => setMethod(mode)}>
						{mode === "clone" ? "Clone" : "Existing checkout"}
					</button>
				))}
			</nav>
			{!view.sourceHead ? (
				<p className="cost">Canonical Git is not ready. A maintainer must finish repository setup before local work can start.</p>
			) : method === "clone" ? (
				<ol className="steps">
					<li>
						<h3>Clone canonical</h3>
						<CopyCommand text={`git clone ${url} ${view.repository.name}`} />
						<p>Canonical is read-only. A workspace pushes to its own fork.</p>
					</li>
					<li>
						<h3>Start work</h3>
						<p>Start Claude Code, Codex or Cursor in the clone, then ask it:</p>
						<CopyCommand text={START_PROMPT} />
						<button type="button" onClick={() => setMethod("attach")}>
							Work in the checkout yourself
						</button>
					</li>
				</ol>
			) : (
				<ol className="steps">
					<li>
						<h3>For your connected tools</h3>
						<CopyCommand text={`git remote add cruce ${url}`} />
						<p>Lets your tools find this repository. Your files, branch, history and existing remotes stay as they are.</p>
					</li>
					<li>
						<h3>To work yourself</h3>
						<p>Authorize this terminal and start a workspace. Cruce adds a separate workspace remote and a local writer lock.</p>
						<CopyCommand
							text={`cruce human --server ${location.origin} --namespace ${view.repository.namespaceId} --repository ${view.repository.id}\ncruce start --title "Describe your work"`}
						/>
						<p>
							Use a branch that can be reviewed from canonical. Commit with Git, then push to the added{" "}
							<code>cruce-&lt;workspace-id&gt;</code> remote with an explicit branch ref. Run <code>cruce publish</code> after pushing. The
							paired terminal cannot approve or promote.
						</p>
					</li>
				</ol>
			)}
			{view.sourceHead && (
				<p className="cost">
					{method === "clone" ? "Cloning reads cloud Git storage. " : ""}Starting a workspace creates an isolated fork and uses namespace
					resource operations. Cruce coordinates the Git work; your tools run it.
				</p>
			)}
		</div>
	);
}

function RepositoryLifecycleSettings({ view, execute, leave }: { view: RepositorySnapshot; execute: Execute; leave: () => void }) {
	const [confirming, setConfirming] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const lifecycle = view.lifecycle;
	if (!lifecycle) return null;
	const archived = lifecycle.state === "archived";
	const deleting = lifecycle.state === "deleting";
	return (
		<SettingRow
			title="Repository lifecycle"
			detail="Archive preserves source and history. Permanent deletion removes this repository's cloud storage and coordination records."
		>
			{lifecycle.transition ? (
				<>
					<p role="status">Repository change is awaiting a retry. Writes remain disabled.</p>
					<Form label="Retry repository change" submit={() => execute(lifecycle.transition!)}>
						<span>Resumes the same requested change.</span>
					</Form>
				</>
			) : deleting ? (
				<>
					<p role="status">Deletion is in progress. This repository is read-only while cloud cleanup finishes.</p>
					{lifecycle.deletion?.reason && <p role="alert">{lifecycle.deletion.reason}</p>}
					{lifecycle.owner && lifecycle.deletion && (
						<Form
							label="Retry deletion"
							submit={async () => {
								const result = (await execute({
									tool: "delete_repository",
									confirmation: view.repository.name,
									idempotencyKey: lifecycle.deletion!.idempotencyKey,
								})) as { state: string };
								if (result.state === "deleted") leave();
							}}
						>
							<span>Resumes the same authorized operation.</span>
						</Form>
					)}
				</>
			) : (
				<>
					<p>
						{archived
							? "Archived. Source and history remain available; writes are disabled."
							: lifecycle.deletionBlockers.length
								? "Finish all work before archiving. Deletion waits for the items below."
								: lifecycle.blockers.length
									? "Finish all work before archiving. Deleting ends unfinished work with the repository."
									: "Archive makes this repository read-only. Deletion removes it permanently."}
					</p>
					{lifecycle.blockers.length > 0 && (
						<ul>
							{lifecycle.blockers.map((blocker) => (
								<li key={blocker}>{blocker}</li>
							))}
						</ul>
					)}
					{lifecycle.owner && lifecycle.operations && lifecycle.operations.length > 0 && (
						<section className="lifecycle-operations" aria-label="Unfinished cloud operations">
							<p>
								{lifecycle.operations.length === 1 ? "This cloud operation" : "These cloud operations"} never finished, and Cruce can't tell
								whether {lifecycle.operations.length === 1 ? "it" : "they"} changed anything. Release one when no agent will retry it.
								Releasing runs, retries and deletes nothing; a later retry of that operation is refused.
							</p>
							<ul>
								{lifecycle.operations.map((operation) => (
									<li key={operation.id}>
										<Form label="Release" submit={() => execute({ tool: "release_resource_operation", reservationId: operation.id })}>
											<span>
												{OPERATION_LABELS[operation.action]}
												{operation.workspaceId &&
													` · ${view.workspaces.find((w) => w.id === operation.workspaceId)?.title ?? operation.workspaceId}`}{" "}
												· started {new Date(operation.at).toLocaleString()} ·{" "}
												{operation.state === "uncertain" ? "outcome unknown" : "never finished"}
											</span>
										</Form>
									</li>
								))}
							</ul>
						</section>
					)}
					{lifecycle.owner ? (
						<div className="lifecycle-actions">
							<Form
								label={archived ? "Restore repository" : "Archive repository"}
								disabled={!archived && lifecycle.blockers.length > 0}
								submit={() => execute({ tool: archived ? "restore_repository" : "archive_repository" })}
							>
								<span>{archived ? "Allow new work again." : "Make read-only. You can restore it later."}</span>
							</Form>
							<button
								type="button"
								className="danger-button"
								disabled={lifecycle.deletionBlockers.length > 0}
								onClick={() => {
									setConfirmation("");
									setConfirming(true);
								}}
							>
								Delete repository…
							</button>
						</div>
					) : (
						<p>Only the signed-in namespace owner can archive, restore or delete repositories.</p>
					)}
				</>
			)}
			{confirming && (
				<Dialog title="Delete repository permanently" close={() => setConfirming(false)}>
					<p>
						This permanently deletes <strong>{view.repository.name}</strong>, including canonical Git, workspace forks, published revisions,
						evidence and coordination history. It cannot be undone.
					</p>
					{(lifecycle.unfinished.workspaces > 0 || lifecycle.unfinished.changes > 0) && (
						<p role="alert">{unfinishedWork(lifecycle.unfinished)}</p>
					)}
					<p>Local checkouts and external upstream repositories remain. This uses installation cloud resources under namespace policy.</p>
					<Form
						label="Delete repository permanently"
						danger
						primary
						cancel={() => setConfirming(false)}
						disabled={confirmation !== view.repository.name}
						submit={async () => {
							const result = (await execute({ tool: "delete_repository", confirmation })) as { state: string };
							setConfirming(false);
							if (result.state === "deleted") leave();
						}}
					>
						<label>
							Type {view.repository.name} to confirm
							<input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
						</label>
					</Form>
				</Dialog>
			)}
		</SettingRow>
	);
}

const OPERATION_LABELS: Record<NonNullable<RepositoryLifecycleView["operations"]>[number]["action"], string> = {
	"repository.create": "Create repository",
	"repository.delete": "Delete repository",
	"workspace.fork": "Create workspace fork",
	"workspace.cleanup": "Delete workspace fork",
	"revision.publish": "Publish revision",
	"artifact.publish": "Store evidence",
	"source.read": "Read stored source",
	"observation.read": "Observe pushed refs",
};
/** What permanent deletion ends with the repository, in plain words for its confirmation. */
function unfinishedWork({ workspaces, attached, changes }: RepositoryLifecycleView["unfinished"]) {
	const parts = [
		workspaces > 0 &&
			`${plural(workspaces, "unfinished workspace")}${attached > 0 ? `, ${attached === workspaces ? (workspaces === 1 ? "attached to a checkout" : "all attached to checkouts") : `${attached} attached to ${attached === 1 ? "a checkout" : "checkouts"}`}` : ""}`,
		changes > 0 && plural(changes, "open change"),
	].filter(Boolean);
	return `This also ends ${parts.join(" and ")}. Agents and checkouts keep running; their next Cruce or Git request fails because the repository is gone. Unpushed local commits stay on their machines.`;
}

function RepositorySettings({
	leave,
	execute,
	view,
	namespace,
	mutate,
	base,
	onError,
	setup,
}: {
	view: RepositorySnapshot;
	leave: () => void;
	namespace?: NamespaceView;
	mutate: Mutate;
	base: string;
	onError: (e: Error) => void;
	setup: () => void;
	execute: Execute;
}) {
	const url = `${base}/repositories/${view.repository.id}`;
	const manage = view.permissions.maintain && namespace;
	return (
		<div className="settings">
			<SettingRow
				title="Push observation"
				detail="Observe pushed refs without publishing or approving them. Missed events are checked every 15 minutes when policy permits."
			>
				<p>
					Observation {view.reconciliation?.observation.state ?? "disabled"}. {view.reconciliation?.observation.reason}
				</p>
				<p>
					Estimated idle checks: {view.reconciliation?.observation.estimatedDailyOperations ?? 96} storage operations/day, plus push checks
					and subscription setup.
				</p>
				{view.permissions.approve && (
					<Form
						label={view.reconciliation?.observation.enabled ? "Disable observation" : "Enable observation"}
						submit={() =>
							execute({ tool: "configure_observation", enabled: !view.reconciliation?.observation.enabled }).then(() => undefined)
						}
					>
						<span>Uses installation cloud resources and the namespace observation policy.</span>
					</Form>
				)}
			</SettingRow>
			{view.capacity && (
				<SettingRow
					title="Coordination capacity"
					detail="Retained records are never deleted by expiry. Ended workspaces whose forks are cleaned up move to Earlier work in History and stop counting toward live limits. New work stops at the supported capacity; authorized recovery keeps reserved headroom."
				>
					<dl className="facts">
						<dt>Current state</dt>
						<dd>
							{Math.ceil(view.capacity.stateBytes / 1024)} / {view.capacity.limits.stateBytes / 1024} KiB
						</dd>
						<dt>Retained coordination records</dt>
						<dd>
							{view.capacity.records} / {view.capacity.limits.storeRecords}
						</dd>
						<dt>Stored coordination data</dt>
						<dd>
							{(view.capacity.bytes / 1024 / 1024).toFixed(2)} / {view.capacity.limits.storeBytes / 1024 / 1024} MiB
						</dd>
						<dt>Live workspaces</dt>
						<dd>
							{view.workspaces.length} / {view.capacity.limits.workspaces}
						</dd>
						<dt>Earlier work</dt>
						<dd>{view.archiveCount} archived; does not count toward live limits</dd>
					</dl>
				</SettingRow>
			)}
			<SettingRow
				title="Local setup"
				detail="Clone this repository or attach an existing checkout. Installing the client and connecting tools happen once per machine."
			>
				<button type="button" onClick={setup}>
					Open setup guide
				</button>
			</SettingRow>
			<SettingRow
				title="Review policy"
				detail="What a maintainer confirms before a change can be promoted, and which paths can't be published."
			>
				{manage ? (
					<Form
						label="Save review policy"
						primary
						className="setting-form"
						submit={(d) =>
							mutate(
								url,
								{
									policy: {
										...view.repository.policy,
										requiredEvidence: value(d, "evidence")
											.split(",")
											.map((s) => s.trim())
											.filter(Boolean),
										protectedPaths: value(d, "paths").split("\n").filter(Boolean),
									},
								},
								"PATCH",
							)
						}
					>
						<label>
							Checks a maintainer confirms before promotion
							<input name="evidence" defaultValue={view.repository.policy.requiredEvidence.join(", ")} placeholder="tests" />
							<small className="muted">Comma separated, for example tests. Agents can report them; a maintainer confirms each one.</small>
						</label>
						<label>
							Protected paths, one per line
							<textarea name="paths" defaultValue={view.repository.policy.protectedPaths.join("\n")} />
							<small className="muted">Revisions that change these paths can't be published.</small>
						</label>
					</Form>
				) : (
					<dl className="facts">
						<dt>Required checks</dt>
						<dd>{view.repository.policy.requiredEvidence.join(", ") || "None"}</dd>
						<dt>Protected paths</dt>
						<dd>{view.repository.policy.protectedPaths.join(", ") || "None"}</dd>
					</dl>
				)}
			</SettingRow>
			{manage && (
				<>
					<SettingRow
						title="Access"
						detail="Grant members or teams Read, Write or Maintain. A grant never exceeds the person's namespace role."
					>
						<div className="rows access-list">
							{view.repository.grants.map((g) => {
								const name = namespace.people.find((p) => p.id === g.id)?.name ?? namespace.teams.find((t) => t.id === g.id)?.name ?? g.id;
								return (
									<div className="person-row" key={`${g.subject}:${g.id}`}>
										<Initials name={name} />
										<span className="row-main">
											<strong>{name}</strong>
											<small>{g.subject === "team" ? "Team" : "Member"}</small>
										</span>
										<span className="role-tag">{g.role}</span>
										<button
											type="button"
											className="text-button"
											onClick={() => void mutate(url, { grants: view.repository.grants.filter((x) => x !== g) }, "PATCH").catch(onError)}
										>
											Remove
										</button>
									</div>
								);
							})}
							{!view.repository.grants.length && (
								<p className="panel-note">Namespace owners and maintainers can maintain this repository.</p>
							)}
						</div>
						<Form
							label="Grant access"
							primary
							className="setting-form"
							submit={(d) => {
								const [subject, id] = value(d, "subject").split(":");
								return mutate(
									url,
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
							<div className="form-fields">
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
							</div>
						</Form>
					</SettingRow>
					<SettingRow title="Repository" detail="The name shown in the console. Links and Git remotes use the stable repository ID.">
						<Form
							label="Rename repository"
							primary
							className="setting-form"
							submit={(d) => mutate(url, { name: value(d, "name") }, "PATCH")}
						>
							<label>
								Repository name
								<input name="name" defaultValue={view.repository.name} required />
							</label>
						</Form>
					</SettingRow>
				</>
			)}
			<RepositoryLifecycleSettings view={view} execute={execute} leave={leave} />
			<SettingRow title="Identifiers" detail="Stable IDs for scripts and support. Names and handles can change; these don't.">
				<dl className="facts">
					<dt>Namespace ID</dt>
					<dd>
						<code>{view.repository.namespaceId}</code>
					</dd>
					<dt>Repository ID</dt>
					<dd>
						<code>{view.repository.id}</code>
					</dd>
					<dt>Storage</dt>
					<dd>Cloudflare Artifacts managed by this installation</dd>
				</dl>
			</SettingRow>
		</div>
	);
}

export function RepositoryPage({
	leave,
	view,
	namespace,
	tab,
	id,
	filter = "",
	viewerId,
	execute,
	busy,
	open,
	mutate,
	base,
	onError,
	openSetup,
}: {
	view: RepositorySnapshot;
	leave: () => void;
	namespace?: NamespaceView;
	tab: string;
	id: string;
	filter?: string;
	viewerId?: string;
	execute: Execute;
	busy: boolean;
	open: Open;
	mutate: Mutate;
	base: string;
	onError: (e: Error) => void;
	openSetup: () => void;
}) {
	const [dialog, setDialog] = useState<SetupMethod>();
	const last = lastPromotion(view),
		a = attention(view),
		live = view.workspaces.filter((w) => !ended(w)).length;
	const who: People = { viewerId: viewerId ?? view.attention?.viewerId, people: namespace?.people };
	const counts: Record<string, number> = { changes: a.recovery + a.promote + a.review, workspaces: live };
	return (
		<>
			<header className={`page-header repo-header${id ? " compact" : ""}`}>
				<div className="page-title">
					<p className="kicker">
						<span>Repository</span>
						{namespace && <span>{namespace.namespace.name}</span>}
					</p>
					<h1>{view.repository.name}</h1>
					<p className="canonical-line">
						<span className="branch">
							<Icon name="branch" />
							{view.repository.defaultBranch}
						</span>
						{view.sourceHead ? (
							<>
								<span>at</span>
								<code title={view.sourceHead}>{short(view.sourceHead)}</code>
								{last && (
									<>
										<span className="sep">·</span>
										<span>last promoted {ago(last.at)}</span>
									</>
								)}
							</>
						) : (
							<span>Canonical revision unavailable</span>
						)}
					</p>
				</div>
				<div className="actions">
					<button type="button" className="primary" onClick={() => setDialog("clone")}>
						<Icon name="local" />
						Set up locally
					</button>
				</div>
			</header>
			{view.lifecycle && view.lifecycle.state !== "active" && (
				<p className="lifecycle-banner" role="status">
					{view.lifecycle.state === "archived"
						? "Archived · Read-only. Restore this repository in Settings."
						: "Deletion in progress · Read-only. View progress in Settings."}
				</p>
			)}
			<CanonicalSetup view={view} execute={execute} />
			<AttentionBar view={view} open={open} />
			<nav className="tabs" aria-label="Repository navigation">
				{repositoryTabs.map((t) => (
					<button
						type="button"
						key={t}
						className={tab === t ? "selected" : ""}
						aria-current={tab === t ? "page" : undefined}
						onClick={() => open(t)}
					>
						{t[0].toUpperCase() + t.slice(1)}
						{counts[t] ? <span className="tab-count">{counts[t]}</span> : null}
					</button>
				))}
			</nav>
			{tab === "changes" &&
				(id ? (
					<ChangeDetail key={id} view={view} id={id} execute={execute} busy={busy} open={open} who={who} />
				) : (
					<ChangesScreen view={view} open={open} execute={execute} who={who} filter={filter} />
				))}
			{tab === "workspaces" &&
				(id ? (
					<WorkspaceDetail key={id} view={view} id={id} execute={execute} open={open} who={who} />
				) : (
					<WorkspaceList view={view} open={open} who={who} execute={execute} filter={filter} />
				))}
			{tab === "history" && <HistoryScreen key={id} view={view} id={id} execute={execute} open={open} who={who} />}
			{tab === "settings" && (
				<RepositorySettings
					leave={leave}
					execute={execute}
					view={view}
					namespace={namespace}
					mutate={mutate}
					base={base}
					onError={onError}
					setup={() => setDialog("clone")}
				/>
			)}
			{dialog && (
				<Dialog title="Set up locally" close={() => setDialog(undefined)} className="connect-dialog">
					<ConnectGuide key={dialog} view={view} initial={dialog} openSetup={openSetup} />
				</Dialog>
			)}
		</>
	);
}
