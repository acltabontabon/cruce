import { useState } from "react";
import { gitRemotePath } from "../shared/git-access.ts";
import type { Proposal, RepositorySnapshot } from "../shared/platform.ts";
import { ChangeDetail } from "./change.tsx";
import { Form, value } from "./controls.tsx";
import { CopyCommand, Dialog, Icon, Pill } from "./design.tsx";
import { RetainedRecordDetail, RetainedRecordRow } from "./records.tsx";
import { type Execute, RevisionBrowser } from "./source.tsx";
import { activityText, actorLabel, ago, attention, changeGroups, changeStatus, ended, lastPromotion, short } from "./status.ts";
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
	if (!view.canonicalSetup.required) return null;
	return (
		<div className="alert canonical-setup" role="status">
			<p>
				<strong>Canonical storage was not created.</strong> Repository creation stopped before Cruce could set up this repository's
				canonical Git storage in the connected Cloudflare account, so cloning and workspaces are unavailable.{" "}
				{view.canonicalSetup.retry
					? "Retrying reuses the original setup operation and its budget reservation."
					: "A repository maintainer can retry setup."}
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
					{working ? "Retrying setup…" : "Retry setup"}
				</button>
			)}
			{error && <p role="alert">{error}</p>}
		</div>
	);
}

function AttentionBar({ view, open }: { view: RepositorySnapshot; open: Open }) {
	const a = attention(view);
	const items: { label: string; tab: string; tone: string }[] = [];
	if (a.review)
		items.push({ label: `${plural(a.review, "change")} ${a.review === 1 ? "needs" : "need"} your review`, tab: "changes", tone: "accent" });
	if (a.ready) items.push({ label: `${plural(a.ready, "change")} ready to promote`, tab: "changes", tone: "success" });
	if (a.stale) items.push({ label: plural(a.stale, "stale change"), tab: "changes", tone: "warning" });
	if (a.behind) items.push({ label: `${plural(a.behind, "workspace")} behind canonical`, tab: "workspaces", tone: "warning" });
	if (a.overlaps)
		items.push({ label: `${plural(a.overlaps, "file")} changed in more than one workspace`, tab: "workspaces", tone: "warning" });
	if (a.quiet) items.push({ label: `${plural(a.quiet, "workspace")} not reporting`, tab: "workspaces", tone: "neutral" });
	return (
		<section className="attention" aria-label="Needs attention">
			{items.length ? (
				items.map((item) => (
					<button type="button" key={item.label} className={`attention-item ${item.tone}`} onClick={() => open(item.tab)}>
						{item.label}
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
			<Pill tone={s.tone}>{s.label}</Pill>
			<span className="row-main">
				<strong>
					{p.title} <span className="number">#{p.number}</span>
				</strong>
				<small>
					<code>{short(p.revision)}</code> on <code>{short(p.base)}</code>
					{workspace && ` · ${workspace.title}`}
					{artifact && ` · ${actorLabel(artifact.actor)} · ${ago(p.at)}`}
				</small>
			</span>
			<Icon name="arrow" />
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

function ChangesScreen({ view, open, connect, execute }: { view: RepositorySnapshot; open: Open; connect: () => void; execute: Execute }) {
	const groups = changeGroups(view);
	return (
		<section className="changes-screen">
			{groups.attention.length ? (
				<div className="rows">
					{groups.attention.map((p) => (
						<ChangeRow key={p.id} view={view} p={p} open={open} />
					))}
				</div>
			) : view.proposals.length ? (
				<p className="empty">Nothing is waiting for review.</p>
			) : (
				<div className="empty-state">
					<h2>No changes yet</h2>
					<p>When an agent or developer publishes a revision and proposes it, it shows up here for review against canonical.</p>
					<button type="button" onClick={connect}>
						Connect an agent
					</button>
				</div>
			)}
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
		</section>
	);
}

function HistoryScreen({ view, id, execute, open }: { view: RepositorySnapshot; id: string; execute: Execute; open: Open }) {
	// "canonical" browses the current canonical revision; it is checked first so record IDs can't shadow it.
	const record = id === "canonical" ? undefined : view.artifacts.find((a) => a.id === id);
	if (record)
		return (
			<article>
				<button type="button" className="text-button back" onClick={() => open("history")}>
					← History
				</button>
				<RetainedRecordDetail id={record.id} view={view} execute={execute} open={open} />
				{record.kind === "source" && view.sourceAvailable && (
					<RevisionBrowser key={record.id} revision={record.revision} execute={execute} />
				)}
			</article>
		);
	if (id === "canonical")
		return (
			<article>
				<button type="button" className="text-button back" onClick={() => open("history")}>
					← History
				</button>
				<h1>Browse source</h1>
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
		<section className="history-screen">
			{id && <p role="status">That record is unavailable.</p>}
			<div className="section-heading">
				<h2>Canonical {view.repository.defaultBranch}</h2>
				<button type="button" className="text-button" onClick={() => open("history", "canonical")}>
					Browse files <Icon name="arrow" />
				</button>
			</div>
			<ol className="canonical-timeline">
				{promotions.map((promotion) => {
					const change = view.proposals.find((p) => p.id === promotion.proposalId);
					return (
						<li key={promotion.id}>
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
			<details className="group" open={publications.length > 0 && publications.length <= 5}>
				<summary>{plural(publications.length, "published revision")}</summary>
				<div className="rows">
					{publications.map((a) => (
						<RetainedRecordRow key={a.id} record={a} open={(id) => open("history", id)} />
					))}
				</div>
			</details>
			{evidence.length > 0 && (
				<details className="group">
					<summary>{plural(evidence.length, "stored evidence record")}</summary>
					<div className="rows">
						{evidence.map((a) => (
							<RetainedRecordRow key={a.id} record={a} open={(id) => open("history", id)} />
						))}
					</div>
				</details>
			)}
			<h2>Activity</h2>
			{view.activity.length ? (
				<ol className="activity">
					{view.activity
						.slice(-40)
						.toReversed()
						.map((e) => (
							<li key={e.id}>
								<time title={new Date(e.at).toLocaleString()}>{ago(e.at)}</time>
								<span>{activityText(e)}</span>
							</li>
						))}
				</ol>
			) : (
				<p className="empty">No activity yet.</p>
			)}
		</section>
	);
}

function ConnectGuide({ view }: { view: RepositorySnapshot }) {
	const [tool, setTool] = useState<"claude" | "codex" | "cursor">("claude");
	const origin = location.origin,
		url = `${origin}${gitRemotePath(view.repository.namespaceId, view.repository.id)}`,
		helper = `node ${CRUCE}/runner/git-credential.mjs --server ${origin} --client git`;
	const launch = tool === "claude" ? "claude" : tool === "codex" ? "codex" : "cursor-agent";
	return (
		<div className="connect-guide">
			<p className="muted">
				Cruce doesn't run agents. Each tool runs on your machine and works in its own Cruce workspace: an isolated checkout and fork based
				on canonical. Replace <code>{CRUCE}</code> with your Cruce checkout.
			</p>
			<ol className="steps">
				<li>
					<h3>Clone canonical</h3>
					<CopyCommand text={`node ${CRUCE}/runner/git-credential.mjs login --server ${origin} --client git`} />
					<CopyCommand text={`git -c credential.useHttpPath=true -c 'credential.helper=!${helper}' clone ${url} ${view.repository.name}`} />
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
						text={`cd ${view.repository.name}\nnode ${CRUCE}/runner/cruce.mjs connect --server ${origin} --namespace ${view.repository.namespaceId} --repository ${view.repository.id} --client ${tool}`}
					/>
					<p className="muted">
						Approve the consent page for this repository. This writes the tool's MCP settings in the clone and leaves your existing remotes
						alone.
					</p>
				</li>
				<li>
					<h3>Start work</h3>
					<p>
						Run <code>{launch}</code> in the clone, then ask it:
					</p>
					<CopyCommand text="Use the Cruce tools to start a workspace for this task and work only in the directory it returns. Commit and push, then publish the revision, record your test results and propose it for review." />
				</li>
			</ol>
			<details className="group">
				<summary>Working yourself, without an agent</summary>
				<CopyCommand
					text={`node ${CRUCE}/runner/cruce.mjs human --server ${origin} --namespace ${view.repository.namespaceId} --repository ${view.repository.id}\nnode ${CRUCE}/runner/cruce.mjs start --title "Describe your work"`}
				/>
			</details>
			<p className="cost">Each workspace creates a fork in your Cloudflare account and counts toward the namespace's daily operations.</p>
		</div>
	);
}

function RepositorySettings({
	view,
	namespace,
	mutate,
	base,
	onError,
}: {
	view: RepositorySnapshot;
	namespace?: NamespaceView;
	mutate: Mutate;
	base: string;
	onError: (e: Error) => void;
}) {
	const url = `${base}/repositories/${view.repository.id}`;
	return (
		<section className="settings-screen">
			<h2>Connect</h2>
			<ConnectGuide view={view} />
			<h2>Review policy</h2>
			{view.permissions.maintain && namespace ? (
				<Form
					label="Save review policy"
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
				<p>
					Required checks: {view.repository.policy.requiredEvidence.join(", ") || "none"}. Protected paths:{" "}
					{view.repository.policy.protectedPaths.join(", ") || "none"}.
				</p>
			)}
			{view.permissions.maintain && namespace && (
				<>
					<h2>Access</h2>
					<div className="rows">
						{view.repository.grants.map((g) => (
							<div className="access-row" key={`${g.subject}:${g.id}`}>
								<span>
									{g.subject === "team" ? "Team " : ""}
									{namespace.people.find((p) => p.id === g.id)?.name ?? namespace.teams.find((t) => t.id === g.id)?.name ?? g.id}
								</span>
								<span className="muted">{g.role}</span>
								<button
									type="button"
									className="text-button"
									onClick={() => void mutate(url, { grants: view.repository.grants.filter((x) => x !== g) }, "PATCH").catch(onError)}
								>
									Remove
								</button>
							</div>
						))}
						{!view.repository.grants.length && <p className="muted">Namespace owners and maintainers can maintain this repository.</p>}
					</div>
					<Form
						label="Grant access"
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
					<h2>Repository</h2>
					<Form label="Rename repository" submit={(d) => mutate(url, { name: value(d, "name") }, "PATCH")}>
						<label>
							Repository name
							<input name="name" defaultValue={view.repository.name} required />
						</label>
					</Form>
				</>
			)}
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
				<dd>Cloudflare Artifacts in the namespace's connected account</dd>
			</dl>
		</section>
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
	const [dialog, setDialog] = useState<"clone" | "connect">();
	const last = lastPromotion(view),
		a = attention(view),
		live = view.workspaces.filter((w) => !ended(w)).length;
	const counts: Record<string, number> = { changes: a.review + a.ready, workspaces: live };
	return (
		<>
			<header className="repo-head">
				<div>
					<h1>{view.repository.name}</h1>
					<p className="canonical-line">
						<Icon name="branch" />
						{view.sourceHead ? (
							<>
								<code>{view.repository.defaultBranch}</code> at <code title={view.sourceHead}>{short(view.sourceHead)}</code>
								{last ? ` · last promoted ${ago(last.at)}` : ""}
							</>
						) : (
							<>
								<code>{view.repository.defaultBranch}</code> · Canonical revision unavailable
							</>
						)}
					</p>
				</div>
				<div className="actions">
					<button type="button" onClick={() => setDialog("connect")}>
						<Icon name="local" />
						Connect an agent
					</button>
					<button type="button" onClick={() => setDialog("clone")} disabled={!view.sourceHead}>
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
					<ChangesScreen view={view} open={open} connect={() => setDialog("connect")} execute={execute} />
				))}
			{tab === "workspaces" &&
				(id ? <WorkspaceDetail key={id} view={view} id={id} execute={execute} open={open} /> : <WorkspaceList view={view} open={open} />)}
			{tab === "history" && <HistoryScreen key={id} view={view} id={id} execute={execute} open={open} />}
			{tab === "settings" && <RepositorySettings view={view} namespace={namespace} mutate={mutate} base={base} onError={onError} />}
			{dialog && (
				<Dialog
					title={dialog === "clone" ? "Clone repository" : "Connect an agent"}
					close={() => setDialog(undefined)}
					className={dialog === "connect" ? "connect-dialog" : ""}
				>
					{dialog === "clone" ? (
						<>
							<p className="muted">
								{view.repository.name} · {view.repository.defaultBranch}
							</p>
							<CopyCommand text={`git clone ${location.origin}${gitRemotePath(view.repository.namespaceId, view.repository.id)}`} />
							<p>
								Use your Cruce connection through a Git credential helper. Canonical is read-only; each workspace pushes to its own fork.
								Connect an agent shows the full setup.
							</p>
						</>
					) : (
						<ConnectGuide view={view} />
					)}
				</Dialog>
			)}
		</>
	);
}
