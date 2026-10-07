import { useState } from "react";
import { gitRemotePath } from "../shared/git-access.ts";
import type { Proposal, RepositorySnapshot } from "../shared/platform.ts";
import { ChangeDetail } from "./change.tsx";
import { Form, value } from "./controls.tsx";
import { BackLink, CopyCommand, Dialog, Icon, Initials, PageHeader, Pill, Section, SettingRow } from "./design.tsx";
import { laneIndex } from "./lanes.ts";
import { LaneBullet, LaneTrack } from "./lanes.tsx";
import { RetainedActivity, RetainedRecordDetail, RetainedRecordRow } from "./records.tsx";
import { type Execute, RevisionBrowser } from "./source.tsx";
import {
	activityText,
	actorLabel,
	ago,
	attention,
	canonicalRelation,
	changeGroups,
	changeStatus,
	ended,
	lastPromotion,
	short,
	workedBy,
} from "./status.ts";
import type { NamespaceView } from "./types.ts";
import { WorkspaceDetail, WorkspaceList } from "./work.tsx";

type Open = (tab: string, id?: string) => void;
export type Mutate = <T>(url: string, body: Record<string, unknown>, method?: string) => Promise<T>;
export const repositoryTabs = ["changes", "workspaces", "history", "settings"] as const;
const CRUCE = "/path/to/cruce";

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
							? "Retrying reuses the original setup operation and its budget reservation."
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

/** One item per thing that needs a person; the count leads so the strip reads at a glance, the words say what it is. */
function AttentionBar({ view, open }: { view: RepositorySnapshot; open: Open }) {
	const a = attention(view);
	const items: { count?: number; label: string; tab: string; tone: string }[] = [];
	const counted = (count: number, one: string, many: string, tab: string, tone: string) => {
		if (count) items.push({ count, label: count === 1 ? one : many, tab, tone });
	};
	counted(a.review, "change needs your review", "changes need your review", "changes", "accent");
	counted(a.ready, "change ready to promote", "changes ready to promote", "changes", "success");
	counted(a.stale, "stale change", "stale changes", "changes", "warning");
	counted(a.behind, "workspace behind canonical", "workspaces behind canonical", "workspaces", "warning");
	counted(a.overlaps, "file changed in more than one workspace", "files changed in more than one workspace", "workspaces", "warning");
	if (view.reconciliation?.observation.state === "degraded")
		items.push({ label: "Observation degraded", tab: "workspaces", tone: "warning" });
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
					<button type="button" key={item.label} className={`attention-item ${item.tone}`} onClick={() => open(item.tab)}>
						{item.count !== undefined && <b>{item.count}</b>} {item.label}
					</button>
				))
			) : (
				<p className="attention-clear">Nothing needs you right now.</p>
			)}
		</section>
	);
}

function ChangeRow({ view, p, open }: { view: RepositorySnapshot; p: Proposal; open: Open }) {
	const s = changeStatus(view, p),
		workspace = view.workspaces.find((w) => w.id === p.workspaceId),
		artifact = view.artifacts.find((a) => a.id === p.artifactId);
	return (
		<button type="button" className="change-row" onClick={() => open("changes", p.id)}>
			<LaneTrack lane={laneIndex(view).get(p.workspaceId)} done={s.key === "promoted"} />
			<span className="row-number">#{p.number}</span>
			<span className="row-main">
				<strong>{p.title}</strong>
				<small className="row-meta">
					<span>
						<code>{short(p.revision)}</code> on <code>{short(p.base)}</code>
					</span>
					{workspace && <span>{workspace.title}</span>}
					{artifact && <span>{`${actorLabel(artifact.actor)} · ${ago(p.at)}`}</span>}
				</small>
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

function LiveWorkspaces({ view, open }: { view: RepositorySnapshot; open: Open }) {
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
									<small>{workedBy(w)}</small>
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

function ChangesScreen({ view, open, execute }: { view: RepositorySnapshot; open: Open; execute: Execute }) {
	const groups = changeGroups(view);
	return (
		<div className="overview changes-screen">
			<div className="overview-main">
				<Section title="Waiting for review" count={groups.attention.length}>
					{groups.attention.length ? (
						<div className="rows">
							{groups.attention.map((p) => (
								<ChangeRow key={p.id} view={view} p={p} open={open} />
							))}
						</div>
					) : view.proposals.length ? (
						<p className="panel-note">Nothing is waiting for review.</p>
					) : (
						<div className="empty-state">
							<h3>No changes yet</h3>
							<p>
								When an agent or developer publishes a revision and proposes it, it shows up here for review against canonical. Use Connect
								an agent above to start.
							</p>
						</div>
					)}
				</Section>
				{groups.inactive.length > 0 && (
					<details className="group">
						<summary>{plural(groups.inactive.length, "stale or superseded change")}</summary>
						<CloseSuperseded view={view} execute={execute} />
						<div className="rows">
							{groups.inactive.map((p) => (
								<ChangeRow key={p.id} view={view} p={p} open={open} />
							))}
						</div>
					</details>
				)}
				{groups.done.length > 0 && (
					<details className="group">
						<summary>{plural(groups.done.length, "promoted or closed change")}</summary>
						<div className="rows">
							{groups.done.map((p) => (
								<ChangeRow key={p.id} view={view} p={p} open={open} />
							))}
						</div>
					</details>
				)}
			</div>
			<aside className="overview-side" aria-label="Repository state">
				<CanonicalPanel view={view} open={open} />
				<LiveWorkspaces view={view} open={open} />
			</aside>
		</div>
	);
}

function HistoryScreen({ view, id, execute, open }: { view: RepositorySnapshot; id: string; execute: Execute; open: Open }) {
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
	const promotions = view.promotions.filter((p) => p.state === "complete").sort((a, b) => b.at - a.at);
	const created = view.activity.find((e) => e.kind === "repository_created");
	const publications = view.artifacts.filter((a) => a.kind === "source").toReversed(),
		evidence = view.artifacts.filter((a) => a.kind === "evidence").toReversed();
	return (
		<div className="overview history-screen">
			<div className="overview-main">
				{id && <p role="status">That record is unavailable.</p>}
				<Section
					title={`Canonical ${view.repository.defaultBranch}`}
					action={
						<button type="button" className="ghost" onClick={() => open("history", "canonical")}>
							Browse files
						</button>
					}
				>
					<ol className="canonical-timeline">
						{promotions.map((promotion) => {
							const change = view.proposals.find((p) => p.id === promotion.proposalId);
							const lane = change && laneIndex(view).get(change.workspaceId);
							return (
								<li key={promotion.id} className={lane ? `lane-${lane}` : undefined}>
									<code>{short(promotion.to)}</code>
									<span>
										{change ? (
											<button type="button" className="text-button" onClick={() => open("changes", change.id)}>
												{change.title} #{change.number}
											</button>
										) : (
											"Promotion"
										)}{" "}
										· promoted by {actorLabel(promotion.actor)} · {ago(promotion.at)}
									</span>
								</li>
							);
						})}
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

type SetupMethod = "clone" | "attach" | "connect";
const setupTitles: Record<SetupMethod, string> = {
	clone: "Clone repository",
	attach: "Attach local checkout",
	connect: "Connect an agent",
};
function ConnectGuide({ view, initial = "connect" }: { view: RepositorySnapshot; initial?: SetupMethod }) {
	const [method, setMethod] = useState<SetupMethod>(initial);
	const [tool, setTool] = useState<"claude" | "codex" | "cursor">("claude");
	const origin = location.origin,
		url = `${origin}${gitRemotePath(view.repository.namespaceId, view.repository.id)}`,
		helper = `node ${CRUCE}/runner/git-credential.mjs --server ${origin} --client git`;
	const launch = tool === "claude" ? "claude" : tool === "codex" ? "codex" : "cursor-agent";
	return (
		<div className="connect-guide">
			<nav className="segmented" aria-label="Setup method">
				{(["clone", "attach", "connect"] as const).map((mode) => (
					<button type="button" key={mode} aria-pressed={method === mode} onClick={() => setMethod(mode)}>
						{mode === "clone" ? "Clone" : mode === "attach" ? "Attach local checkout" : "Connect an agent"}
					</button>
				))}
			</nav>
			<p className="muted">
				Run these commands on your machine. Replace <code>{CRUCE}</code> with your Cruce checkout.
			</p>
			{method === "clone" ? (
				<ol className="steps">
					<li>
						<h3>Authorize Git</h3>
						<CopyCommand text={`node ${CRUCE}/runner/git-credential.mjs login --server ${origin} --client git`} />
						<p>Select this repository on the consent page.</p>
					</li>
					<li>
						<h3>Clone canonical</h3>
						<CopyCommand
							text={`git -c credential.useHttpPath=true -c 'credential.helper=!${helper}' clone ${url} ${view.repository.name}`}
						/>
						<p>Canonical is read-only. A workspace pushes to its own fork.</p>
					</li>
					<li>
						<button type="button" onClick={() => setMethod("connect")}>
							Connect a tool in the clone
						</button>
						<button type="button" onClick={() => setMethod("attach")}>
							Work in the checkout yourself
						</button>
					</li>
				</ol>
			) : method === "attach" ? (
				<>
					<p>
						From your existing checkout, authorize this terminal and start a workspace. Your files, branch and existing remotes are
						preserved. Cruce adds a separate workspace remote and a local writer lock; it does not upload history.
					</p>
					<CopyCommand
						text={`node ${CRUCE}/runner/cruce.mjs human --server ${origin} --namespace ${view.repository.namespaceId} --repository ${view.repository.id}\nnode ${CRUCE}/runner/cruce.mjs start --title "Describe your work"`}
					/>
					<p>
						Use a branch that can be reviewed from canonical. Commit with Git, then push to the added{" "}
						<code>cruce-&lt;workspace-id&gt;</code> remote with an explicit branch ref. Run <code>cruce publish</code> after pushing. The
						paired terminal cannot approve or promote.
					</p>
				</>
			) : (
				<ol className="steps">
					<li>
						<h3>Use a local checkout</h3>
						<p>
							Open your checkout, or{" "}
							<button type="button" className="text-button" onClick={() => setMethod("clone")}>
								clone canonical first
							</button>
							.
						</p>
					</li>
					<li>
						<h3>Connect your tool</h3>
						<fieldset className="segmented">
							<legend className="sr-only">Agent tool</legend>
							{(["claude", "codex", "cursor"] as const).map((t) => (
								<button key={t} type="button" aria-pressed={tool === t} onClick={() => setTool(t)}>
									{t === "claude" ? "Claude Code" : t === "codex" ? "Codex" : "Cursor"}
								</button>
							))}
						</fieldset>
						<CopyCommand
							text={`node ${CRUCE}/runner/cruce.mjs connect --server ${origin} --namespace ${view.repository.namespaceId} --repository ${view.repository.id} --client ${tool}`}
						/>
						<p className="muted">
							Approve this repository on the consent page. This writes the tool's MCP settings and preserves existing remotes.
						</p>
					</li>
					<li>
						<h3>Start work</h3>
						<p>
							Run <code>{launch}</code> in the checkout, then ask it:
						</p>
						<CopyCommand text="Use the Cruce tools to start a workspace for this task and work only in the directory it returns. Commit and push, then publish the revision, record your test results and propose it for review." />
					</li>
				</ol>
			)}
			{method === "clone" && (
				<p className="cost">
					Cloning reads cloud Git storage. Creating a workspace uses a separate fork and namespace resource operations.
				</p>
			)}
			{method !== "clone" && (
				<p className="cost">
					Starting a workspace creates an isolated fork and uses namespace resource operations. Cruce coordinates the Git work; your tools
					run it.
				</p>
			)}
		</div>
	);
}

function RepositorySettings({
	execute,
	view,
	namespace,
	mutate,
	base,
	onError,
	setup,
}: {
	view: RepositorySnapshot;
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
				detail="Observe pushed refs without publishing or approving them. Missed events are checked every 15 minutes when policy and budget permit."
			>
				<p>
					Observation {view.reconciliation?.observation.state ?? "disabled"}. {view.reconciliation?.observation.reason}
				</p>
				<p>
					Estimated idle checks: {view.reconciliation?.observation.estimatedDailyOperations ?? 96} namespace operations/day, plus push
					checks and subscription setup. Enabling does not raise the namespace budget. Adjust its limit explicitly in namespace settings.
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
					detail="Retained records are never deleted by expiry. New work stops at the supported capacity; authorized recovery keeps reserved headroom."
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
						<dt>Workspaces</dt>
						<dd>
							{view.workspaces.length} / {view.capacity.limits.workspaces}
						</dd>
					</dl>
				</SettingRow>
			)}
			<SettingRow
				title="Connect"
				detail="Clone canonical, connect a coding tool and start a workspace. Cruce coordinates the work; your tools run it."
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
	view,
	namespace,
	tab,
	id,
	execute,
	busy,
	open,
	mutate,
	base,
	onError,
}: {
	view: RepositorySnapshot;
	namespace?: NamespaceView;
	tab: string;
	id: string;
	execute: Execute;
	busy: boolean;
	open: Open;
	mutate: Mutate;
	base: string;
	onError: (e: Error) => void;
}) {
	const [dialog, setDialog] = useState<SetupMethod>();
	const last = lastPromotion(view),
		a = attention(view),
		live = view.workspaces.filter((w) => !ended(w)).length;
	const counts: Record<string, number> = { changes: a.review + a.ready, workspaces: live };
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
					<button type="button" className="ghost" onClick={() => setDialog("connect")}>
						<Icon name="local" />
						Connect an agent
					</button>
					<button type="button" className="ghost" onClick={() => setDialog("attach")} disabled={!view.sourceHead}>
						Attach local checkout
					</button>
					<button type="button" className="primary" onClick={() => setDialog("clone")} disabled={!view.sourceHead}>
						<Icon name="branch" />
						Clone
					</button>
				</div>
			</header>
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
					<ChangeDetail key={id} view={view} id={id} execute={execute} busy={busy} open={open} />
				) : (
					<ChangesScreen view={view} open={open} execute={execute} />
				))}
			{tab === "workspaces" &&
				(id ? <WorkspaceDetail key={id} view={view} id={id} execute={execute} open={open} /> : <WorkspaceList view={view} open={open} />)}
			{tab === "history" && <HistoryScreen key={id} view={view} id={id} execute={execute} open={open} />}
			{tab === "settings" && (
				<RepositorySettings
					execute={execute}
					view={view}
					namespace={namespace}
					mutate={mutate}
					base={base}
					onError={onError}
					setup={() => setDialog("connect")}
				/>
			)}
			{dialog && (
				<Dialog title={setupTitles[dialog]} close={() => setDialog(undefined)} className={dialog === "connect" ? "connect-dialog" : ""}>
					<ConnectGuide key={dialog} view={view} initial={dialog} />
				</Dialog>
			)}
		</>
	);
}
