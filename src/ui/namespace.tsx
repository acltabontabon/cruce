import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Namespace, NamespaceDeletionView, NamespaceRole, Team } from "../shared/platform.ts";
import { Form, value } from "./controls.tsx";
import { BackLink, CopyCommand, Dialog, Icon, Initials, PageHeader, Section, SettingRow, Stats } from "./design.tsx";
import { plural, RepositoryRow, totals } from "./home.tsx";
import type { Mutate } from "./repository.tsx";
import { activityText, ago } from "./status.ts";
import type { NamespaceView } from "./types.ts";

const actionLabels: Record<string, { label: string; detail: string }> = {
	"repository.delete": {
		label: "Delete repositories",
		detail: "Permanently removes canonical Git, forks and retained source after owner confirmation.",
	},
	"repository.create": { label: "Create repositories", detail: "Creates canonical Git storage." },
	"workspace.fork": { label: "Create workspace forks", detail: "One fork per writer workspace." },
	"revision.publish": { label: "Push and publish revisions", detail: "Pushes to forks and retained source." },
	"artifact.publish": { label: "Store evidence", detail: "Test reports and other evidence files." },
	"workspace.cleanup": { label: "Delete workspace forks", detail: "Only after every ref is retained." },
	"source.read": { label: "Inspect and recover stored source", detail: "Explicit cloud reads and local Git cache recovery." },
	"observation.read": { label: "Observe pushed refs", detail: "Push subscriptions and missed-event checks." },
};
const ruleLabels: Record<string, string> = { allow: "Allowed", approval: "Maintainers only", deny: "Not allowed" };
const roleLabels: Record<NamespaceRole, string> = { owner: "Owner", maintainer: "Maintainer", developer: "Developer", viewer: "Viewer" };

/** Namespace routes: one overview and its settings. Retired Members and Teams links open the overview's People section. */
export const namespaceViews = ["repositories", "members", "teams", "settings"];

/** Opening an inline form moves focus to its first field, as opening a dialog does. */
function InlinePanel({ children }: { children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => ref.current?.querySelector<HTMLElement>("input, select")?.focus(), []);
	return (
		<div className="inline-panel" ref={ref}>
			{children}
		</div>
	);
}

function MemberRow({
	person,
	namespace,
	base,
	mutate,
}: {
	person: NamespaceView["people"][number];
	namespace: NamespaceView;
	base: string;
	mutate: Mutate;
}) {
	const role = namespace.members[person.id],
		[busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const editable = namespace.permissions.maintain && role !== "owner";
	const save = async (next: string) => {
		if (next === "remove" && !window.confirm(`Remove ${person.name} from ${namespace.namespace.name}?`)) return;
		setBusy(true);
		setError("");
		try {
			await mutate(`${base}/members`, { userId: person.id, ...(next === "remove" ? {} : { role: next }) });
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="person-row">
			<Initials name={person.name} />
			<span className="row-main">
				<strong>{person.name}</strong>
				<small>{person.email}</small>
			</span>
			{editable ? (
				<select
					className="role-select"
					aria-label={`Namespace role for ${person.name}`}
					value={role}
					disabled={busy}
					onChange={(e) => void save(e.target.value)}
				>
					<option value="viewer">Viewer</option>
					<option value="developer">Developer</option>
					{namespace.permissions.owner && <option value="maintainer">Maintainer</option>}
					<option value="remove">Remove…</option>
				</select>
			) : (
				<span className="role-tag">{roleLabels[role] ?? role}</span>
			)}
			{error && <p role="alert">{error}</p>}
		</div>
	);
}

function InviteForm({ namespace, base, mutate, close }: { namespace: NamespaceView; base: string; mutate: Mutate; close: () => void }) {
	const [link, setLink] = useState<{ url: string; email: string }>();
	return (
		<InlinePanel>
			<Form
				label="Create invitation link"
				primary
				cancel={close}
				submit={async (d) => {
					const result = await mutate<{ url: string }>(`${base}/invitations`, { email: value(d, "email"), role: value(d, "role") });
					setLink({ url: result.url, email: value(d, "email") });
				}}
			>
				<label>
					Email
					<input name="email" type="email" required placeholder="name@company.com" />
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
			{link && (
				<div role="status" className="invite-link">
					<span>Send this link to {link.email}. It works only for that verified email.</span>
					<CopyCommand text={link.url} />
				</div>
			)}
		</InlinePanel>
	);
}

function TeamForm({
	team,
	namespace,
	save,
	done,
}: {
	team: Team;
	namespace: NamespaceView;
	save: (body: Record<string, unknown>) => Promise<unknown>;
	done?: () => void;
}) {
	const stableId = useRef(team.id || crypto.randomUUID());
	return (
		<Form
			label={team.id ? "Save team" : "Create team"}
			primary
			cancel={done}
			submit={async (d) => {
				await save({ id: stableId.current, name: value(d, "name"), members: d.getAll("members").map(String) });
				done?.();
			}}
		>
			<label>
				Team name
				<input name="name" defaultValue={team.name} required placeholder="e.g. Platform" />
			</label>
			<fieldset className="checks">
				<legend>Members</legend>
				{namespace.people.map((p) => (
					<label className="checkbox" key={p.id}>
						<input type="checkbox" name="members" value={p.id} defaultChecked={team.members.includes(p.id)} />
						{p.name}
					</label>
				))}
			</fieldset>
		</Form>
	);
}

function TeamRow({
	team,
	namespace,
	save,
}: {
	team: Team;
	namespace: NamespaceView;
	save: (body: Record<string, unknown>) => Promise<unknown>;
}) {
	const people = team.members.map((id) => ({ id, name: namespace.people.find((p) => p.id === id)?.name ?? "Former member" }));
	const summary = (
		<>
			<span className="row-main">
				<strong>{team.name}</strong>
				<small>{plural(team.members.length, "member")}</small>
			</span>
			<span className="stack" aria-hidden="true">
				{people.slice(0, 4).map((person) => (
					<Initials key={person.id} name={person.name} />
				))}
			</span>
		</>
	);
	if (!namespace.permissions.maintain) return <div className="team-row">{summary}</div>;
	return (
		<details className="team-row">
			<summary>{summary}</summary>
			<TeamForm team={team} namespace={namespace} save={save} />
		</details>
	);
}

function People({ namespace, base, mutate }: { namespace: NamespaceView; base: string; mutate: Mutate }) {
	const [inviting, setInviting] = useState(false);
	return (
		<Section
			id="people"
			title="People"
			count={namespace.people.length}
			action={
				namespace.permissions.maintain &&
				!inviting && (
					<button type="button" className="ghost" onClick={() => setInviting(true)}>
						<Icon name="invite" />
						Invite
					</button>
				)
			}
		>
			{inviting && <InviteForm namespace={namespace} base={base} mutate={mutate} close={() => setInviting(false)} />}
			<div className="rows">
				{namespace.people.map((p) => (
					<MemberRow key={p.id} person={p} namespace={namespace} base={base} mutate={mutate} />
				))}
			</div>
		</Section>
	);
}

function Teams({ namespace, base, mutate }: { namespace: NamespaceView; base: string; mutate: Mutate }) {
	const [creating, setCreating] = useState(false);
	const save = (body: Record<string, unknown>) => mutate(`${base}/teams`, body);
	return (
		<Section
			id="teams"
			title="Teams"
			count={namespace.teams.length}
			action={
				namespace.permissions.maintain &&
				!creating && (
					<button type="button" className="ghost" onClick={() => setCreating(true)}>
						<Icon name="plus" />
						New team
					</button>
				)
			}
		>
			{creating && (
				<InlinePanel>
					<TeamForm team={{ id: "", name: "", members: [] }} namespace={namespace} save={save} done={() => setCreating(false)} />
				</InlinePanel>
			)}
			{namespace.teams.length ? (
				<div className="rows">
					{namespace.teams.map((t) => (
						<TeamRow key={t.id} team={t} namespace={namespace} save={save} />
					))}
				</div>
			) : (
				!creating && <p className="panel-note">Teams group members so repository access can be granted once.</p>
			)}
		</Section>
	);
}

function Overview({
	namespace,
	base,
	mutate,
	open,
}: {
	namespace: NamespaceView;
	base: string;
	mutate: Mutate;
	open: (repositoryId: string, tab?: string) => void;
}) {
	const summaries = namespace.repositories.map((r) => namespace.repositorySummaries?.find((s) => s.id === r.id));
	const sum = totals(summaries);
	const incomplete = summaries.some((summary) => !summary);
	const shared = namespace.namespace.kind === "shared";
	return (
		<>
			{namespace.repositories.length > 0 && (
				<Stats
					label={`${namespace.namespace.name} at a glance`}
					items={[
						{ label: "Repositories", value: namespace.repositories.length },
						{ label: "Needs you", value: incomplete && !summaries.some(Boolean) ? "—" : sum.mine, tone: sum.mine ? "accent" : "" },
						{
							label: "Ready to promote",
							value: incomplete && !summaries.some(Boolean) ? "—" : sum.ready,
							tone: sum.ready ? "success" : "",
						},
						{ label: "Active workspaces", value: incomplete && !summaries.some(Boolean) ? "—" : sum.active },
					]}
				/>
			)}
			<div className={shared ? "overview" : "overview single"}>
				{incomplete && <p role="status">Some repository status is unavailable. Counts cover available repositories.</p>}
				<div className="overview-main">
					<Section title="Repositories" count={namespace.repositories.length}>
						{namespace.repositories.length ? (
							<div className="rows">
								{namespace.repositories.map((r, i) => (
									<RepositoryRow key={r.id} repository={r} summary={summaries[i]} open={() => open(r.id)} />
								))}
							</div>
						) : (
							<div className="empty-state">
								<svg className="empty-art" viewBox="0 0 240 72" aria-hidden="true">
									<path d="M12 20h216" />
									<path className="fork" d="M44 20c0 26 18 36 40 36h60" />
									<path className="fork faint" d="M44 20c0 14 26 18 56 18h34" />
									<circle cx="44" cy="20" r="5" />
									<circle className="open" cx="144" cy="56" r="4" />
									<circle className="open" cx="134" cy="38" r="4" />
								</svg>
								<h3>No repositories yet</h3>
								<p>
									A repository gives concurrent work a canonical Git history in this Cruce installation. Agents and developers then work in
									their own workspaces and propose exact revisions for review.
									{namespace.storage.ready && namespace.permissions.maintain && " Use New repository above to create the first one."}
								</p>
								{!namespace.storage.ready && (
									<button type="button" onClick={() => open("", "settings")}>
										View storage setup
									</button>
								)}
							</div>
						)}
					</Section>
					{namespace.activity?.length ? (
						<Section title="Recent activity">
							<ol className="feed">
								{namespace.activity.slice(0, 8).map((e) => (
									<li key={`${e.repositoryId}:${e.id}`}>
										<time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
											{ago(e.at)}
										</time>
										<span>
											<button type="button" className="text-button" onClick={() => open(e.repositoryId)}>
												{e.repositoryName}
											</button>{" "}
											{activityText(e)}
										</span>
									</li>
								))}
							</ol>
						</Section>
					) : null}
				</div>
				{shared && (
					<aside className="overview-side" aria-label={`About ${namespace.namespace.name}`}>
						<People namespace={namespace} base={base} mutate={mutate} />
						<Teams namespace={namespace} base={base} mutate={mutate} />
					</aside>
				)}
			</div>
		</>
	);
}

/** What deleting the namespace ends with its repositories, in plain words for its confirmation. */
function deletedWork({ repositories, archived, unfinished }: NamespaceDeletionView) {
	const work = [
		unfinished.workspaces > 0 &&
			`${plural(unfinished.workspaces, "unfinished workspace")}${unfinished.attached > 0 ? ` (${unfinished.attached} attached to ${unfinished.attached === 1 ? "a checkout" : "checkouts"})` : ""}`,
		unfinished.changes > 0 && plural(unfinished.changes, "open change"),
	].filter(Boolean);
	return [
		`${repositories === 0 ? "no repositories" : plural(repositories, "repository", "repositories")}${archived > 0 ? ` (${archived} archived)` : ""}.`,
		work.length
			? ` This also ends ${work.join(" and ")}. Agents and checkouts keep running; their next Cruce or Git request fails because the namespace is gone. Unpushed local commits stay on their machines.`
			: "",
	].join("");
}

function NamespaceDeletion({
	namespace,
	base,
	mutate,
	deleted,
}: {
	namespace: NamespaceView;
	base: string;
	mutate: Mutate;
	deleted: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	// One operation identity per confirmation, so a lost response is retried rather than refused.
	const [key, setKey] = useState("");
	const view = namespace.deletion,
		ns = namespace.namespace;
	if (ns.kind !== "shared") return null;
	const submit = async (input: { confirmation: string; idempotencyKey: string }) => {
		const result = await mutate<{ state: string }>(`${base}/deletion`, input);
		setConfirming(false);
		if (result.state === "deleted") deleted();
	};
	return (
		<SettingRow
			title="Delete namespace"
			detail="Permanently deletes every repository in this namespace, including canonical Git, forks, published revisions, evidence and history, then the namespace itself."
		>
			{!view ? (
				<p>Only the signed-in namespace owner can delete this namespace.</p>
			) : view.state === "deleting" ? (
				<>
					<p role="status">
						Deletion is in progress.{" "}
						{view.deletion && view.deletion.remaining > 0
							? `${plural(view.deletion.remaining, "repository", "repositories")} still being deleted.`
							: "Removing the namespace."}{" "}
						Members and agents can no longer use it.
					</p>
					{view.deletion?.reason && <p role="alert">{view.deletion.reason}</p>}
					{view.owner && view.deletion && (
						<Form label="Retry deletion" submit={() => submit({ confirmation: ns.handle, idempotencyKey: view.deletion!.idempotencyKey })}>
							<span>Resumes the same authorized deletion.</span>
						</Form>
					)}
				</>
			) : (
				<>
					<p>{view.blockers.length ? "Deletion waits for the items below." : `Deletes the namespace with ${deletedWork(view)}`}</p>
					{view.blockers.length > 0 && (
						<ul>
							{view.blockers.map((blocker) => (
								<li key={blocker}>{blocker}</li>
							))}
						</ul>
					)}
					{view.owner ? (
						<div className="lifecycle-actions">
							<button
								type="button"
								className="danger-button"
								disabled={view.blockers.length > 0}
								onClick={() => {
									setConfirmation("");
									setKey(crypto.randomUUID());
									setConfirming(true);
								}}
							>
								Delete namespace…
							</button>
						</div>
					) : (
						<p>Only the signed-in namespace owner can delete this namespace.</p>
					)}
				</>
			)}
			{confirming && view && (
				<Dialog title="Delete namespace permanently" close={() => setConfirming(false)}>
					<p>
						This permanently deletes <strong>{ns.name}</strong> with {deletedWork(view)} It cannot be undone.
					</p>
					<p>
						Local checkouts and external upstream repositories remain. Members lose access and the handle can be used again. This uses
						installation cloud resources under namespace policy.
					</p>
					<Form
						label="Delete namespace permanently"
						danger
						primary
						cancel={() => setConfirming(false)}
						disabled={confirmation !== ns.handle}
						submit={() => submit({ confirmation, idempotencyKey: key })}
					>
						<label>
							Type {ns.handle} to confirm
							<input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
						</label>
					</Form>
				</Dialog>
			)}
		</SettingRow>
	);
}

function Settings({
	namespace,
	base,
	mutate,
	renamed,
	deleted,
}: {
	namespace: NamespaceView;
	base: string;
	mutate: Mutate;
	renamed: (namespace: Namespace) => void;
	deleted: () => void;
}) {
	const ns = namespace.namespace,
		maintain = namespace.permissions.maintain && !namespace.lifecycle;
	return (
		<div className="settings">
			<SettingRow title="Namespace" detail="The name people see and the handle used in links and Git remotes.">
				{maintain ? (
					<Form
						label="Save namespace"
						primary
						className="setting-form"
						submit={async (d) => renamed(await mutate<Namespace>(base, { name: value(d, "name"), handle: value(d, "handle") }, "PATCH"))}
					>
						<div className="form-fields">
							<label>
								Name
								<input name="name" defaultValue={ns.name} required />
							</label>
							<label>
								Handle
								<input name="handle" defaultValue={ns.handle} required pattern="[a-z0-9-]+" />
							</label>
						</div>
					</Form>
				) : (
					<dl className="facts">
						<dt>Name</dt>
						<dd>{ns.name}</dd>
						<dt>Handle</dt>
						<dd>
							<code>{ns.handle}</code>
						</dd>
					</dl>
				)}
			</SettingRow>
			<SettingRow
				title="Storage operations"
				detail="Who may run each operation that uses Cloudflare Artifacts storage. Retries of the same operation reuse it instead of repeating it."
			>
				{maintain ? (
					<Form
						label="Save operations"
						primary
						className="setting-form"
						submit={(d) =>
							mutate(`${base}/policy`, {
								rules: Object.fromEntries(Object.keys(namespace.policy.rules).map((key) => [key, value(d, key)])),
							})
						}
					>
						<div className="rules">
							{Object.entries(namespace.policy.rules).map(([key, rule]) => (
								<div key={key} className="rule" role="radiogroup" aria-labelledby={`rule-${key}`}>
									<span className="rule-label" id={`rule-${key}`}>
										{actionLabels[key]?.label ?? key}
										<small>{actionLabels[key]?.detail}</small>
									</span>
									<div className="segmented">
										{Object.entries(ruleLabels).map(([option, label]) => (
											<label key={option}>
												<input type="radio" name={key} value={option} defaultChecked={rule === option} />
												<span>{label}</span>
											</label>
										))}
									</div>
								</div>
							))}
						</div>
					</Form>
				) : (
					<dl className="rule-list">
						{Object.entries(namespace.policy.rules).map(([key, rule]) => (
							<div key={key}>
								<dt>
									{actionLabels[key]?.label ?? key}
									<small>{actionLabels[key]?.detail}</small>
								</dt>
								<dd>{ruleLabels[rule] ?? rule}</dd>
							</div>
						))}
					</dl>
				)}
			</SettingRow>
			<SettingRow title="Git storage" detail="Cloudflare Artifacts usage is billed to the installation's account.">
				<p className={`storage-state ${namespace.storage.ready ? "ready" : "unavailable"}`}>
					<span className="dot" aria-hidden="true" />
					{namespace.storage.ready
						? "Managed by this Cruce installation. All repositories and workspaces inherit its storage."
						: namespace.storage.reason}
				</p>
			</SettingRow>
			<NamespaceDeletion namespace={namespace} base={base} mutate={mutate} deleted={deleted} />
		</div>
	);
}

export function NamespacePage({
	namespace,
	tab,
	base,
	mutate,
	open,
	newRepository,
	renamed,
	deleted,
}: {
	namespace: NamespaceView;
	tab: string;
	base: string;
	mutate: Mutate;
	open: (repositoryId: string, tab?: string) => void;
	newRepository: () => void;
	renamed: (namespace: Namespace) => void;
	deleted: () => void;
}) {
	const ns = namespace.namespace,
		settings = tab === "settings";
	useEffect(() => {
		if (tab === "members" || tab === "teams") document.getElementById("people")?.scrollIntoView({ block: "start" });
	}, [tab]);
	const kicker = (
		<>
			<span>{ns.kind === "personal" ? "Personal namespace" : "Shared namespace"}</span>
			<code>@{ns.handle}</code>
			<span>you're {namespace.role}</span>
			{!namespace.storage.ready && <span className="kicker-warning">Installation storage unavailable</span>}
		</>
	);
	return (
		<>
			{settings && <BackLink label={ns.name} onClick={() => open("")} />}
			<PageHeader kicker={settings ? undefined : kicker} title={settings ? "Settings" : ns.name}>
				{!settings && (
					<>
						<button type="button" className="ghost" onClick={() => open("", "settings")}>
							<Icon name="settings" />
							Settings
						</button>
						{namespace.permissions.maintain && !namespace.lifecycle && (
							<button className="primary" type="button" onClick={newRepository}>
								<Icon name="plus" />
								New repository
							</button>
						)}
					</>
				)}
			</PageHeader>
			{namespace.lifecycle?.state === "deleting" && (
				<p className="lifecycle-banner" role="status">
					Deletion in progress · Read-only. {settings ? "Progress is shown below." : "View progress in Settings."}
				</p>
			)}
			{settings ? (
				<Settings namespace={namespace} base={base} mutate={mutate} renamed={renamed} deleted={deleted} />
			) : (
				<Overview namespace={namespace} base={base} mutate={mutate} open={open} />
			)}
		</>
	);
}
