import { useState } from "react";
import { gitRemotePath } from "../shared/git-access.ts";
import type { RepositorySnapshot } from "../shared/platform.ts";
import { ChangeDetail } from "./change.tsx";
import { count, short } from "./controls.tsx";
import { Dialog, Icon } from "./design.tsx";
import { Topology } from "./topology.tsx";
import { Activity, ArtifactRow, type Execute, WorkspaceDetail, Workspaces } from "./work.tsx";

type Open = (tab: string, id?: string) => void;
function ChangeList({ view, open }: { view: RepositorySnapshot; open: Open }) {
	return (
		<div className="change-list">
			{view.proposals.map((p) => (
				<button type="button" key={p.id} className="review-row" onClick={() => open("work", p.id)}>
					<span className="review-number">#{p.number}</span>
					<span>
						<strong>{p.title}</strong>
						<small>
							<code>{short(p.revision)}</code> · {p.state}
						</small>
						<span className={`readiness-badge ${view.readiness[p.id]?.ready ? "ready" : ""}`}>
							{p.state === "promoted"
								? "Promoted"
								: p.state !== "open"
									? p.state
									: view.readiness[p.id]?.ready
										? "Ready for promotion"
										: (view.readiness[p.id]?.reasons[0] ?? "Readiness unavailable")}
						</span>
					</span>
					<Icon name="arrow" />
				</button>
			))}
			{!view.proposals.length && <p className="empty">No changes proposed. Publish exact committed source to request review.</p>}
		</div>
	);
}
export function RepositoryOverview({ view, open }: { view: RepositorySnapshot; open: Open }) {
	const [instructions, setInstructions] = useState<"clone" | "attach">();
	const active = view.workspaces.filter((w) => w.state === "active");
	return (
		<>
			<div className="page-title repository-title">
				<div>
					<p className="eyebrow">Repository / shared direction</p>
					<h1>{view.repository.name}</h1>
					<p className="repository-baseline">
						<span className="revision-dot" />
						{view.repository.defaultBranch} <code>{view.sourceHead ? short(view.sourceHead) : "Canonical revision unavailable"}</code>
					</p>
				</div>
				<div className="actions">
					<button type="button" onClick={() => setInstructions("clone")} disabled={!view.sourceHead}>
						<Icon name="branch" />
						Clone
					</button>
					<button type="button" onClick={() => setInstructions("attach")}>
						<Icon name="local" />
						Attach local checkout
					</button>
				</div>
			</div>
			<div className="status-strip">
				<span>{count(active.length, "active workspace")}</span>
				<span>{count(active.filter((w) => w.actor.kind === "agent").length, "agent")} working</span>
				<span>{count(view.artifacts.length, "artifact")}</span>
				<span>Reported activity</span>
			</div>
			<div className="coordination-layout">
				<Topology view={view} open={(id) => open("work", id)} all={() => open("work")} />
				<section className="review-queue">
					<div className="section-heading">
						<div>
							<p className="eyebrow">Human decisions</p>
							<h2>Review queue</h2>
						</div>
						<span className="queue-count">{view.proposals.filter((p) => p.state === "open").length}</span>
					</div>
					<ChangeList view={{ ...view, proposals: view.proposals.filter((p) => p.state === "open") }} open={open} />
					<p className="queue-note">
						Review an exact revision.
						<br />
						Decide what moves forward.
					</p>
				</section>
			</div>
			<div className="repository-secondary">
				<section>
					<div className="section-heading">
						<h2>Latest artifact</h2>
						<button type="button" className="text-button" onClick={() => open("artifacts")}>
							All artifacts <Icon name="arrow" />
						</button>
					</div>
					{view.artifacts.length ? (
						<ArtifactRow artifact={view.artifacts.at(-1)!} open={(id) => open("artifacts", id)} />
					) : (
						<p className="empty">No artifacts published yet.</p>
					)}
				</section>
				<Activity view={view} />
			</div>
			{instructions && (
				<Dialog title={instructions === "clone" ? "Clone repository" : "Attach local checkout"} close={() => setInstructions(undefined)}>
					<p className="muted">
						{view.repository.name} · {view.repository.defaultBranch}
					</p>
					{instructions === "clone" ? (
						<>
							<pre>
								<code>{`git clone ${location.origin}${gitRemotePath(view.repository.namespaceId, view.repository.id)}`}</code>
							</pre>
							<p>
								Use your Cruce OAuth connection with a Git credential helper. Canonical is read-only; each writer workspace has its own
								writable fork.
							</p>
						</>
					) : (
						<>
							<p>From a checkout containing the known canonical base, authorize local participation through the installed bridge.</p>
							<pre>
								<code>{`node /absolute/path/to/cruce/runner/cruce.mjs human --server ${location.origin} --namespace ${view.repository.namespaceId} --repository ${view.repository.id}\nnode /absolute/path/to/cruce/runner/cruce.mjs start --title "Describe your work"`}</code>
							</pre>
							<p>
								Replace the installation path. Human terminals attach the existing checkout; authorized agents use dedicated worktrees.
								Existing remotes stay unchanged and history is never uploaded implicitly.
							</p>
							<p className="cost">
								Writer attachment provisions a Cloudflare Artifacts fork under namespace policy and consumes resources. Cruce does not
								launch an agent.
							</p>
						</>
					)}
				</Dialog>
			)}
		</>
	);
}
export function WorkScreen({
	view,
	id,
	execute,
	busy,
	open,
}: {
	view: RepositorySnapshot;
	id: string;
	execute: Execute;
	busy: boolean;
	open: Open;
}) {
	if (id && view.proposals.some((p) => p.id === id))
		return <ChangeDetail key={id} view={view} id={id} execute={execute} busy={busy} open={open} />;
	if (id && view.workspaces.some((w) => w.id === id))
		return (
			<div className="workspace-detail">
				<button type="button" className="text-button" onClick={() => open("work")}>
					← All work
				</button>
				<WorkspaceDetail key={id} view={view} id={id} execute={execute} />
			</div>
		);
	return (
		<>
			<p className="eyebrow">Independent work / exact review</p>
			<h1>Work</h1>
			{id && <p role="status">This work item is unavailable.</p>}
			<section>
				<h2>Changes</h2>
				<ChangeList view={view} open={open} />
			</section>
			<section>
				<h2>Workspaces</h2>
				<Workspaces view={view} all open={(id) => open("work", id)} />
			</section>
		</>
	);
}
