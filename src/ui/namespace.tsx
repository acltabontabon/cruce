import { useRef } from "react";
import type { Namespace, Team } from "../shared/platform.ts";
import { Empty, Form, value } from "./controls.tsx";
import { Icon } from "./design.tsx";
import { AttentionPills } from "./home.tsx";
import type { Mutate } from "./repository.tsx";
import { activityText, ago } from "./status.ts";
import type { NamespaceView } from "./types.ts";

const actionLabels: Record<string, { label: string; detail: string }> = {
	"repository.create": { label: "Create repositories", detail: "Creates canonical Git storage." },
	"workspace.fork": { label: "Create workspace forks", detail: "One fork per writer workspace." },
	"revision.publish": { label: "Push and publish revisions", detail: "Pushes to forks and retained source." },
	"artifact.publish": { label: "Store evidence", detail: "Test reports and other evidence files." },
	"workspace.cleanup": { label: "Delete workspace forks", detail: "Only after every ref is retained." },
};

function StorageCard({ namespace }: { namespace: NamespaceView }) {
	return (
		<section className="settings-card">
			<h2>Git storage</h2>
			<p>
				{namespace.storage.ready
					? "Managed by this Cruce installation. All repositories and workspaces inherit its storage."
					: namespace.storage.reason}
			</p>
			<p className="muted">
				Cloudflare Artifacts usage is billed to the installation's account. Namespace budgets apply across its repositories.
			</p>
		</section>
	);
}

function BudgetCard({ namespace, base, mutate }: { namespace: NamespaceView; base: string; mutate: Mutate }) {
	const budget = namespace.budget;
	return (
		<section className="settings-card">
			<h2>Daily operations</h2>
			{budget && (
				<>
					<p>
						<strong>
							{budget.used} of {budget.limit}
						</strong>{" "}
						used today · resets{" "}
						{budget.resetsAt > Date.now() ? `in ${Math.max(1, Math.round((budget.resetsAt - Date.now()) / 3_600_000))} h` : "now"} (midnight
						UTC)
					</p>
					<progress value={Math.min(budget.used, budget.limit)} max={Math.max(1, budget.limit)} aria-label="Operations used today" />
				</>
			)}
			<p className="muted">
				Each repository, workspace fork, push, publication and fork deletion uses one operation in this Cruce installation. Retries of the
				same operation don't count twice.
			</p>
			{namespace.permissions.maintain && (
				<Form
					label="Save limits"
					submit={(d) =>
						mutate(`${base}/policy`, {
							dailyLimit: Number(value(d, "dailyLimit")),
							rules: Object.fromEntries(Object.keys(namespace.policy.rules).map((key) => [key, value(d, key)])),
						})
					}
				>
					<label>
						Operations per day
						<input name="dailyLimit" type="number" min="0" max="10000" defaultValue={namespace.policy.dailyLimit} />
					</label>
					<div className="rules">
						{Object.entries(namespace.policy.rules).map(([key, rule]) => (
							<label key={key}>
								<span>
									{actionLabels[key]?.label ?? key}
									<small className="muted">{actionLabels[key]?.detail}</small>
								</span>
								<select name={key} defaultValue={rule}>
									<option value="allow">Allowed</option>
									<option value="approval">Maintainers only</option>
									<option value="deny">Not allowed</option>
								</select>
							</label>
						))}
					</div>
				</Form>
			)}
		</section>
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
		<details className="group">
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

export const namespaceTabsFor = (namespace?: NamespaceView) => [
	"repositories",
	...(namespace?.namespace.kind === "shared" ? ["members", "teams"] : []),
	"settings",
];

export function NamespacePage({
	namespace,
	tab,
	base,
	mutate,
	open,
	newRepository,
	notify,
	renamed,
}: {
	namespace: NamespaceView;
	tab: string;
	base: string;
	mutate: Mutate;
	open: (repositoryId: string, tab?: string) => void;
	newRepository: () => void;
	notify: (text: string) => void;
	renamed: (namespace: Namespace) => void;
}) {
	const ns = namespace.namespace;
	return (
		<>
			<header className="repo-head">
				<div>
					<h1>{ns.name}</h1>
					<p className="canonical-line">
						{ns.kind === "personal" ? "Personal namespace" : "Shared namespace"} · you're {namespace.role}
						{!namespace.storage.ready && " · Installation storage unavailable"}
					</p>
				</div>
				{tab === "repositories" && namespace.permissions.maintain && (
					<div className="actions">
						<button className="primary" type="button" onClick={newRepository}>
							<Icon name="plus" />
							New repository
						</button>
					</div>
				)}
			</header>
			<nav className="tabs" aria-label="Namespace navigation">
				{namespaceTabsFor(namespace).map((t) => (
					<button
						type="button"
						key={t}
						className={tab === t ? "selected" : ""}
						aria-current={tab === t ? "page" : undefined}
						onClick={() => open("", t)}
					>
						{t[0].toUpperCase() + t.slice(1)}
					</button>
				))}
			</nav>
			{tab === "repositories" && (
				<>
					{namespace.repositories.length ? (
						<div className="rows">
							{namespace.repositories.map((r) => (
								<button type="button" className="repo-row" key={r.id} onClick={() => open(r.id)}>
									<span className="row-main">
										<strong>{r.name}</strong>
										<small>
											<code>{r.defaultBranch}</code>
										</small>
									</span>
									<AttentionPills summary={namespace.repositorySummaries?.find((s) => s.id === r.id)} />
									<Icon name="arrow" />
								</button>
							))}
						</div>
					) : (
						<div className="empty-state">
							<h2>No repositories yet</h2>
							<p>
								A repository gives concurrent work a canonical Git history in this Cruce installation. Agents and developers then work in
								their own workspaces and propose exact revisions for review.
							</p>
							{!namespace.storage.ready ? (
								<button type="button" onClick={() => open("", "settings")}>
									View storage setup
								</button>
							) : (
								namespace.permissions.maintain && (
									<button type="button" className="primary" onClick={newRepository}>
										<Icon name="plus" />
										New repository
									</button>
								)
							)}
						</div>
					)}
					{namespace.activity?.length ? (
						<section>
							<h2>Recent activity</h2>
							<ol className="activity">
								{namespace.activity.map((e) => (
									<li key={`${e.repositoryId}:${e.id}`}>
										<time title={new Date(e.at).toLocaleString()}>{ago(e.at)}</time>
										<span>
											<button type="button" className="text-button" onClick={() => open(e.repositoryId)}>
												{e.repositoryName}
											</button>{" "}
											{activityText(e)}
										</span>
									</li>
								))}
							</ol>
						</section>
					) : null}
				</>
			)}
			{tab === "members" && (
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
								const result = await mutate<{ url: string }>(`${base}/invitations`, { email: value(d, "email"), role: value(d, "role") });
								notify(result.url);
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
			{tab === "teams" && (
				<>
					{!namespace.teams.length && <Empty>No teams yet. Teams group namespace members for repository access.</Empty>}
					{[...namespace.teams, { id: "", name: "", members: [] }].map((t) => (
						<TeamForm key={t.id || "new"} team={t} namespace={namespace} save={(body) => mutate(`${base}/teams`, body)} />
					))}
				</>
			)}
			{tab === "settings" && (
				<div className="settings-screen">
					<StorageCard namespace={namespace} />
					<BudgetCard namespace={namespace} base={base} mutate={mutate} />
					{namespace.permissions.maintain && (
						<section className="settings-card">
							<h2>Namespace</h2>
							<Form
								label="Save namespace"
								submit={async (d) =>
									renamed(await mutate<Namespace>(base, { name: value(d, "name"), handle: value(d, "handle") }, "PATCH"))
								}
							>
								<label>
									Name
									<input name="name" defaultValue={ns.name} required />
								</label>
								<label>
									Handle
									<input name="handle" defaultValue={ns.handle} required />
								</label>
							</Form>
						</section>
					)}
				</div>
			)}
		</>
	);
}
