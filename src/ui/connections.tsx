import { useEffect, useState } from "react";
import { SCOPE_LABELS, type Scope } from "../core/capabilities.ts";
import type { AgentConnection } from "../shared/platform.ts";
import { AgentMark } from "./agent-marks.tsx";
import { Form } from "./controls.tsx";
import { Dialog, Icon } from "./design.tsx";
import { SkeletonRows, track, usePending } from "./loading.tsx";
import { request } from "./request.ts";

/** Short names for what a connection may do beyond reading; the full scope label is in each item's tooltip. */
const ABILITIES: [Scope, string][] = [
	["workspace:write", "Workspaces"],
	["revision:publish", "Publish revisions"],
	["artifact:publish", "Evidence"],
	["change:write", "Changes"],
	["promotion:request", "Promotion requests"],
];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function when(at: number) {
	const hours = Math.round((at - Date.now()) / 3_600_000);
	return Math.abs(hours) < 24 ? relative.format(hours, "hour") : relative.format(Math.round(hours / 24), "day");
}
const fullDate = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function ConnectionRow({ connection, revoke }: { connection: AgentConnection; revoke: () => void }) {
	const abilities = ABILITIES.filter(([scope]) => connection.scopes.includes(scope));
	return (
		<li className="connection-row">
			<AgentMark client={connection.client} />
			<div className="connection-main">
				<strong>{connection.client}</strong>
				<p className="connection-repositories">
					<Icon name="repositories" />
					{connection.repositories === "all" ? (
						<span>All repositories you can access</span>
					) : connection.repositories ? (
						connection.repositories.length ? (
							connection.repositories.map((repository) => <code key={repository.id}>{repository.label}</code>)
						) : (
							<span>No repositories</span>
						)
					) : (
						<span>Repositories not recorded</span>
					)}
				</p>
				<ul className="connection-abilities" aria-label="Allowed">
					{abilities.length ? (
						abilities.map(([scope, label]) => (
							<li key={scope} title={SCOPE_LABELS[scope]}>
								{label}
							</li>
						))
					) : (
						<li title={SCOPE_LABELS["cruce:read"]}>Read only</li>
					)}
				</ul>
			</div>
			<dl className="connection-dates">
				<div>
					<dt>Approved</dt>
					<dd title={fullDate(connection.createdAt)}>{when(connection.createdAt)}</dd>
				</div>
				{connection.expiresAt && (
					<div>
						<dt>Expires</dt>
						<dd title={fullDate(connection.expiresAt)}>{when(connection.expiresAt)}</dd>
					</div>
				)}
			</dl>
			<button type="button" className="connection-revoke" onClick={revoke} aria-label={`Revoke ${connection.client}`}>
				Revoke
			</button>
		</li>
	);
}

/** Tools the signed-in person approved. Revoking ends one connection; work it already pushed or published stays. */
export function AgentConnections() {
	const [connections, setConnections] = useState<AgentConnection[]>(),
		[error, setError] = useState(""),
		[attempt, setAttempt] = useState(0),
		[revoking, setRevoking] = useState<AgentConnection>(),
		[notice, setNotice] = useState("");
	usePending(!connections && !error);
	useEffect(() => {
		void attempt;
		const controller = new AbortController();
		request<AgentConnection[]>("/api/connections", undefined, "GET", controller.signal).then(
			(list) => {
				setConnections(list);
				setError("");
			},
			(failure: Error) => {
				if (!controller.signal.aborted) setError(failure.message);
			},
		);
		return () => controller.abort();
	}, [attempt]);
	return (
		<section className="connections" aria-labelledby="connections-heading">
			<h2 id="connections-heading">Agent connections{connections && <span className="panel-count">{connections.length}</span>}</h2>
			<p className="page-lead">
				Tools you approved to work as you. Each reaches all repositories you can access, or the ones you chose, with the permissions you
				approved, always within your current namespace roles. Names and icons are what each tool reports about itself.
			</p>
			{notice && <p role="status">{notice}</p>}
			{error && (
				<div role="alert" className="alert">
					{error}
					<button type="button" onClick={() => setAttempt((n) => n + 1)}>
						Retry
					</button>
				</div>
			)}
			{!connections ? (
				!error && <SkeletonRows label="Loading agent connections" />
			) : connections.length ? (
				<ul className="connection-list">
					{connections.map((connection) => (
						<ConnectionRow key={connection.id} connection={connection} revoke={() => setRevoking(connection)} />
					))}
				</ul>
			) : (
				<div className="connection-empty">
					<Icon name="plug" />
					<strong>No agents connected</strong>
					<p>Connect a tool above. You approve it in your browser once and it appears here.</p>
				</div>
			)}
			{revoking && (
				<Dialog title={`Revoke ${revoking.client}?`} close={() => setRevoking(undefined)}>
					<p className="dialog-lead">
						It loses access at its next request and needs your approval again to reconnect. Workspaces, pushed revisions and changes it made
						stay as they are.
					</p>
					<Form
						label="Revoke connection"
						primary
						cancel={() => setRevoking(undefined)}
						submit={async () => {
							await track(request(`/api/connections/${encodeURIComponent(revoking.id)}`, undefined, "DELETE"));
							setConnections((list) => list?.filter((item) => item.id !== revoking.id));
							setNotice(`${revoking.client} was revoked.`);
							setRevoking(undefined);
						}}
					>
						{null}
					</Form>
				</Dialog>
			)}
		</section>
	);
}
