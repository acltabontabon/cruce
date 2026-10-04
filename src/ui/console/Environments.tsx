import { useState } from "react";
import { COST_LABELS, RESOURCE_ACTIONS, RESOURCE_COST, RESOURCE_LABELS, type ResourceRule } from "../../core/capabilities.ts";
import { VerificationKinds } from "../../shared/platform.ts";
import { type Execute, label, liveIn, request, short, type View } from "./model.ts";

/**
 * The resource boundary, made explicit: which Cloudflare account owns and pays for infrastructure,
 * which environments exist, and which resource actions agents may take on their own.
 */
export function Environments({ view, execute, reload }: { view: View; execute: Execute; reload: () => Promise<void> }) {
	return (
		<section aria-labelledby="environments-title">
			<div className="overview-heading">
				<div>
					<p className="eyebrow">{view.project.name}</p>
					<h1 id="environments-title">Environments and resources</h1>
					<p className="muted">
						Source, execution and deployment are separate. Cruce coordinates; your Cloudflare account owns the resources.
					</p>
				</div>
			</div>
			<Account view={view} reload={reload} />
			<EnvironmentConfig view={view} execute={execute} />
			<Production view={view} execute={execute} />
			<Policy view={view} execute={execute} />
		</section>
	);
}

function Account({ view, reload }: { view: View; reload: () => Promise<void> }) {
	const [accountId, setAccountId] = useState(view.account?.accountId ?? ""),
		[token, setToken] = useState(""),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const post = (body: unknown) => {
		setBusy(true);
		setError("");
		return request(`/api/projects/account?projectId=${encodeURIComponent(view.project.id)}`, body)
			.then(() => setToken(""))
			.then(reload)
			.catch((e) => setError(e.message))
			.finally(() => setBusy(false));
	};
	return (
		<section className="activity-section" aria-labelledby="account">
			<h2 id="account">Cloudflare account</h2>
			{view.account ? (
				<p>
					{view.account.label} <code>{view.account.accountId}</code>{" "}
					<span className="muted">
						· {view.account.mode === "operator" ? "same account as this Cruce deployment" : "connected account"} · Workers Builds credential{" "}
						{view.account.credential === "stored" ? "stored (sealed, never shown)" : "not connected"}
					</span>
				</p>
			) : (
				<p className="muted">No account connected. Local development and source collaboration do not need one.</p>
			)}
			{view.permissions.govern && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void post({ accountId, token });
					}}
				>
					<label>
						Account ID
						<input value={accountId} onChange={(e) => setAccountId(e.target.value.trim())} pattern="[0-9a-f]{32}" required />
					</label>
					<label>
						API token <span className="muted">(Workers Builds read, Workers Scripts read, Artifacts edit)</span>
						<input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required minLength={20} />
					</label>
					<div className="review-actions">
						<button type="submit" className="btn" disabled={busy}>
							{view.account?.credential === "stored" ? "Replace credential" : "Connect account"}
						</button>
						{view.account?.credential === "stored" && (
							<button type="button" className="btn quiet" disabled={busy} onClick={() => void post({ disconnect: true })}>
								Disconnect
							</button>
						)}
					</div>
					<p className="muted">Infrastructure Cruce triggers is billed to this account. Cruce itself never pays for or exposes it.</p>
				</form>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

function EnvironmentConfig({ view, execute }: { view: View; execute: Execute }) {
	const profile = view.deploymentProfile;
	const existing = view.environments.find((e) => e.target.type === "cloudflare_worker");
	const [kind, setKind] = useState<"cloudflare_worker" | "external">(
		profile?.kind === "cloudflare_worker" || existing ? "cloudflare_worker" : "external",
	);
	const [workerName, setWorkerName] = useState(
		existing?.target.type === "cloudflare_worker"
			? existing.target.workerName
			: profile?.kind === "cloudflare_worker"
				? (profile.workerName ?? "")
				: "",
	);
	const [description, setDescription] = useState(""),
		[paths, setPaths] = useState((existing?.smokeChecks ?? [{ path: "/" }]).map((c) => c.path).join(" ")),
		[result, setResult] = useState(""),
		[error, setError] = useState("");
	return (
		<section className="activity-section" aria-labelledby="envs">
			<h2 id="envs">Environments</h2>
			{view.environments.length === 0 && (
				<p className="muted">No environments. Cruce still tracks missions, revisions, evidence and promotion.</p>
			)}
			<ul className="plain-list">
				{view.environments.map((e) => (
					<li key={e.id}>
						{e.name}{" "}
						<span className="muted">
							·{" "}
							{e.target.type === "cloudflare_worker"
								? `Worker ${e.target.workerName} from ${e.target.deployRepository}`
								: e.target.description}
							{e.live ? ` · running ${short(e.live.revision)}` : ""} · smoke {e.smokeChecks.map((c) => c.path).join(", ")}
						</span>
					</li>
				))}
			</ul>
			{view.permissions.govern && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						setError("");
						void execute({
							tool: "configure_environment",
							environment:
								kind === "cloudflare_worker"
									? { kind, workerName: workerName || undefined, smokePaths: paths.split(/\s+/).filter(Boolean) }
									: { kind, description, smokePaths: paths.split(/\s+/).filter(Boolean) },
						})
							.then((r) => setResult(((r as { nextAction?: string }[])[0]?.nextAction as string) ?? "Saved"))
							.catch((err) => setError(err.message));
					}}
				>
					<label>
						Deployment target
						<select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
							<option value="cloudflare_worker">Cloudflare Worker (preview and production)</option>
							<option value="external">Outside Cloudflare (record only)</option>
						</select>
					</label>
					{kind === "cloudflare_worker" ? (
						<label>
							Worker name
							<input
								value={workerName}
								onChange={(e) => setWorkerName(e.target.value)}
								placeholder={profile?.kind === "cloudflare_worker" ? profile.workerName : "customer-api"}
							/>
						</label>
					) : (
						<label>
							Where it runs
							<input
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Kubernetes, payments cluster"
								required
							/>
						</label>
					)}
					<label>
						Smoke check paths
						<input value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="/ /health" />
					</label>
					<button type="submit" className="btn">
						{existing ? "Update environments" : "Enable deployment"}
					</button>
					{result && <p className="coverage-note">{result}</p>}
				</form>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

function Production({ view, execute }: { view: View; execute: Execute }) {
	const production = view.environments.find((e) => e.kind === "production");
	const live = liveIn(view, "production");
	const [plan, setPlan] = useState<{
			target: string;
			removes: { number: number; summary: string; mission: string }[];
			targetVerified: boolean;
		} | null>(null),
		[error, setError] = useState("");
	if (production?.target.type !== "cloudflare_worker") return null;
	const history = view.deployments.filter((d) => d.environmentId === production.id).sort((a, b) => b.updatedAt - a.updatedAt);
	const earlier = [...new Set(history.filter((d) => d.state === "superseded").map((d) => d.revision))].filter((r) => r !== live?.revision);
	return (
		<section className="activity-section" aria-labelledby="production">
			<h2 id="production">Production</h2>
			<p>
				{live ? (
					<>
						Running <code className="rev">{short(live.revision)}</code>
						{live.proposalId && <span className="muted"> · proposal {view.proposals.find((p) => p.id === live.proposalId)?.number}</span>}
					</>
				) : (
					<span className="muted">Nothing deployed yet</span>
				)}
			</p>
			{view.permissions.govern && earlier.length > 0 && (
				<ul className="plain-list">
					{earlier.map((revision) => (
						<li key={revision}>
							<code className="rev">{short(revision)}</code>{" "}
							<button
								type="button"
								className="link-button"
								onClick={() => {
									setError("");
									void execute({ tool: "plan_rollback", revision })
										.then((r) => setPlan(r as typeof plan))
										.catch((e) => setError(e.message));
								}}
							>
								Explain rollback
							</button>
						</li>
					))}
				</ul>
			)}
			{plan && (
				<div className="coverage-note">
					<p>
						Rollback to <code>{short(plan.target)}</code> removes:
					</p>
					<ul className="plain-list">
						{plan.removes.map((r) => (
							<li key={r.number}>
								#{r.number} {r.summary} <span className="muted">· {r.mission}</span>
							</li>
						))}
					</ul>
					<p className="muted">
						{plan.targetVerified
							? "The earlier revision has trusted verification."
							: "The earlier revision has no trusted verification on record."}
					</p>
					<button
						type="button"
						className="btn"
						onClick={() =>
							void execute({ tool: "deploy_revision", revision: plan.target })
								.then(() => setPlan(null))
								.catch((e) => setError(e.message))
						}
					>
						Deploy {short(plan.target)} to production
					</button>
				</div>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

function Policy({ view, execute }: { view: View; execute: Execute }) {
	const [rules, setRules] = useState(view.policy.resources.rules),
		[budgets, setBudgets] = useState(view.policy.resources.budgets),
		[approvals, setApprovals] = useState(view.policy.approvals),
		[required, setRequired] = useState(view.policy.requiredEvidence),
		[reason, setReason] = useState(""),
		[error, setError] = useState("");
	const editable = view.permissions.govern;
	return (
		<section className="activity-section" aria-labelledby="policy">
			<h2 id="policy">Policy</h2>
			<table className="policy-table">
				<thead>
					<tr>
						<th>Resource action</th>
						<th>Cost</th>
						<th>Agents</th>
					</tr>
				</thead>
				<tbody>
					{RESOURCE_ACTIONS.map((action) => (
						<tr key={action}>
							<td>{RESOURCE_LABELS[action]}</td>
							<td className="muted">{COST_LABELS[RESOURCE_COST[action]]}</td>
							<td>
								<select
									aria-label={`${RESOURCE_LABELS[action]} rule`}
									disabled={!editable}
									value={rules[action]}
									onChange={(e) => setRules({ ...rules, [action]: e.target.value as ResourceRule })}
								>
									{(action === "production.deploy" ? (["approval", "deny"] as const) : (["allow", "approval", "deny"] as const)).map(
										(r) => (
											<option key={r} value={r}>
												{r === "allow" ? "Allowed" : r === "approval" ? "Human approval" : "Denied"}
											</option>
										),
									)}
								</select>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="budget-row">
				{(Object.keys(budgets) as (keyof typeof budgets)[]).map((key) => (
					<label key={key}>
						{label(key.replace(/([A-Z])/g, "_$1").toLowerCase())}
						<input
							type="number"
							min={0}
							max={1000}
							disabled={!editable}
							value={budgets[key]}
							onChange={(e) => setBudgets({ ...budgets, [key]: Number(e.target.value) })}
						/>
					</label>
				))}
			</div>
			<fieldset disabled={!editable}>
				<legend>Promotion requires trusted evidence on the exact proposed revision</legend>
				{VerificationKinds.map((kind) => (
					<label key={kind} className="inline-check">
						<input
							type="checkbox"
							checked={required.includes(kind)}
							onChange={(e) => setRequired(e.target.checked ? [...required, kind] : required.filter((k) => k !== kind))}
						/>{" "}
						{label(kind)}
					</label>
				))}
				<label>
					Human approvals
					<input type="number" min={1} max={10} value={approvals} onChange={(e) => setApprovals(Number(e.target.value))} />
				</label>
			</fieldset>
			{editable && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						setError("");
						void execute({
							tool: "set_policy",
							expectedVersion: view.policy.version,
							reason,
							policy: { approvals, requiredEvidence: required, resources: { rules, budgets } },
						})
							.then(() => setReason(""))
							.catch((err) => setError(err.message));
					}}
				>
					<label>
						Reason for this policy change
						<input value={reason} onChange={(e) => setReason(e.target.value)} required />
					</label>
					<button type="submit" className="btn" disabled={!required.length}>
						Save policy v{view.policy.version + 1}
					</button>
				</form>
			)}
			{error && <p role="alert">{error}</p>}
			<details>
				<summary>Resource decisions</summary>
				{view.resourceRequests.length === 0 && <p className="muted">None yet.</p>}
				{view.resourceRequests.map((r) => (
					<p key={r.id} className="timeline-row">
						{RESOURCE_LABELS[r.action]}{" "}
						<span className="muted">
							· {r.state} · {r.requestedBy}
							{r.decision ? ` · ${r.decision}` : ""}
						</span>
					</p>
				))}
			</details>
		</section>
	);
}
