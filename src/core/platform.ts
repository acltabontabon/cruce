import type {
	Actor,
	Artifact,
	Authority,
	Command,
	Deployment,
	Overlap,
	Proposal,
	Repository,
	RepositorySnapshot,
	RepositoryState,
	Session,
} from "../shared/platform.ts";
import { humanMaintain, writeAccess } from "./capabilities.ts";
import { DomainError, requireValue, stable } from "./errors.ts";
export const SESSION_TTL = 90_000;
export const initialRepository = (repository: Repository): RepositoryState => ({
	repository,
	version: 0,
	sessions: [],
	artifacts: [],
	proposals: [],
	verifications: [],
	promotions: [],
	environments: [],
	deployments: [],
	refs: [],
	activity: [],
	receipts: {},
});
export class RepositoryController {
	constructor(
		readonly state: RepositoryState,
		readonly now: number,
		readonly nextId: () => string,
	) {}
	event(actor: Actor, kind: string, summary: string, ids: string[]) {
		this.state.version++;
		this.state.activity.push({ id: `event-${this.state.version}`, actor, kind, summary, ids, at: this.now });
	}
	session(id?: string) {
		const s = this.state.sessions.find((s) => s.id === id);
		if (!s) throw new DomainError(404, "Session unavailable");
		return s;
	}
	proposal(id?: string) {
		const p = this.state.proposals.find((p) => p.id === id);
		if (!p) throw new DomainError(404, "Change unavailable");
		return p;
	}
	artifact(id?: string) {
		const a = this.state.artifacts.find((a) => a.id === id);
		if (!a) throw new DomainError(404, "Artifact unavailable");
		return a;
	}
	deployment(id?: string) {
		const d = this.state.deployments.find((d) => d.id === id);
		if (!d) throw new DomainError(404, "Deployment unavailable");
		return d;
	}
	owned(a: Authority, id?: string, write = true) {
		if (write) writeAccess(a);
		const s = this.session(id);
		if (s.actor.id !== a.actor.id || s.actor.connectionId !== a.actor.connectionId)
			throw new DomainError(403, "Session belongs to another actor connection");
		if (["completed", "cancelled"].includes(s.state)) throw new DomainError(409, "Session has ended");
		if (write && s.mode !== "write") throw new DomainError(403, "Read-only session");
		return s;
	}
	live(s: Session) {
		return s.state === "active" && s.lastActivity + SESSION_TTL > this.now;
	}
	overlaps(): Overlap[] {
		const byPath = new Map<string, Session[]>();
		for (const s of this.state.sessions.filter((s) => this.live(s) && s.mode === "write")) {
			for (const p of new Set(s.changes.flatMap((c) => [c.path, ...(c.previousPath ? [c.previousPath] : [])])))
				byPath.set(p, [...(byPath.get(p) ?? []), s]);
		}
		return [...byPath]
			.filter(([, s]) => s.length > 1)
			.map(([surface, s]) => ({
				id: `file:${surface}`,
				kind: "file",
				sessions: s.map((s) => s.id).sort(),
				surface,
				evidence: "reported",
				observedAt: Math.min(...s.map((s) => s.lastActivity)),
			}));
	}
	readiness(p: Proposal, accepted = false) {
		const reasons: string[] = [];
		if (p.state !== "open" && !(accepted && p.state === "promoted")) reasons.push("Change is closed or promotion is in progress");
		const head = this.state.sourceHead ?? this.state.refs.filter((r) => r.ref === this.state.repository.defaultBranch).at(-1)?.revision;
		if (head && p.base !== head && !(accepted && p.state === "promoted" && p.revision === head))
			reasons.push("Base revision changed; refresh and propose the reconciled revision");
		const latest = new Map<string, (typeof p.reviews)[number]>();
		for (const r of p.reviews.filter((r) => r.revision === p.revision)) latest.set(r.actor.id, r);
		if (![...latest.values()].some((r) => r.actor.kind === "human" && r.outcome === "approve"))
			reasons.push("Human approval required for this revision");
		if ([...latest.values()].some((r) => r.outcome !== "approve" && !r.resolution))
			reasons.push("Review concern requires a reasoned human resolution");
		for (const kind of this.state.repository.policy.requiredEvidence) {
			const evidence = new Map<string, (typeof this.state.verifications)[number]>();
			for (const v of this.state.verifications.filter((v) => v.proposalId === p.id && v.revision === p.revision && v.kind === kind))
				evidence.set(v.actor.id, v);
			if (
				![...evidence.values()].some((v) => v.outcome === "pass" && v.trust !== "reported") ||
				[...evidence.values()].some((v) => v.outcome === "fail")
			)
				reasons.push(`Trusted passing ${kind} evidence required`);
		}
		return { ready: !reasons.length, reasons };
	}
	snapshot(a: Authority): RepositorySnapshot {
		const { receipts: _, ...state } = structuredClone(this.state);
		state.sessions = state.sessions.map((s) => ({ ...s, state: s.state === "active" && !this.live(s) ? "disconnected" : s.state }));
		return {
			...state,
			overlaps: this.overlaps(),
			permissions: { write: a.repositoryRole !== "read", maintain: a.repositoryRole === "maintain", human: a.actor.kind === "human" },
			sourceAvailable: !!this.state.sourceHead || !!this.state.artifacts.find((a) => a.kind === "source"),
			readiness: Object.fromEntries(this.state.proposals.map((p) => [p.id, this.readiness(p)])),
		};
	}
	trace(subject: string) {
		const ids = new Set([subject]);
		let changed = true;
		const records = [
			...this.state.sessions.map((s) => ({ type: "session", record: s, ids: [s.id, s.baseRevision, s.headRevision, s.actor.id] })),
			...this.state.artifacts.map((a) => ({ type: "artifact", record: a, ids: [a.id, a.sessionId, a.revision, a.actor.id] })),
			...this.state.proposals.map((p) => ({ type: "change", record: p, ids: [p.id, p.sessionId, p.artifactId, p.revision] })),
			...this.state.deployments.map((d) => ({ type: "deployment", record: d, ids: [d.id, d.artifactId, d.sessionId, d.revision] })),
			...this.state.verifications.map((v) => ({ type: "verification", record: v, ids: [v.id, v.proposalId, v.revision] })),
			...this.state.promotions.map((p) => ({ type: "promotion", record: p, ids: [p.id, p.proposalId, p.to] })),
		];
		// Actor identities are leaves, never edges that join every unrelated action by the same person.
		const actors = new Set(this.state.sessions.map((s) => s.actor.id));
		while (changed) {
			changed = false;
			for (const r of records)
				if (r.ids.some((id) => ids.has(id) && (!actors.has(id) || id === subject)))
					for (const id of r.ids)
						if (!ids.has(id)) {
							ids.add(id);
							changed = true;
						}
		}
		return records.filter((r) => ids.has(r.record.id)).map(({ type, record }) => ({ type, record }));
	}
	command(cmd: Command, a: Authority): unknown {
		if (a.repositoryId !== this.state.repository.id || a.workspaceId !== this.state.repository.workspaceId)
			throw new DomainError(403, "Repository identity mismatch");
		switch (cmd.tool) {
			case "get_repository":
				return this.snapshot(a);
			case "get_session":
				return this.snapshot(a).sessions.find((s) => s.id === cmd.sessionId) ?? this.session(cmd.sessionId);
			case "list_active_sessions":
				return this.snapshot(a).sessions.filter((s) => !["completed", "cancelled"].includes(s.state));
			case "inspect_overlap":
				return this.overlaps();
			case "get_lineage":
				return this.trace(requireValue(cmd.subjectId, "Subject required"));
			case "start_session": {
				if (cmd.mode !== "read") writeAccess(a);
				const base = requireValue(cmd.baseRevision, "Exact base revision required");
				const s: Session = {
					id: this.nextId(),
					repositoryId: this.state.repository.id,
					actor: a.actor,
					title: requireValue(cmd.title, "Session title required"),
					baseRevision: base,
					headRevision: base,
					branch: cmd.branch,
					mode: cmd.mode ?? "write",
					context: cmd.context,
					state: cmd.mode === "read" ? "active" : "preparing",
					startedAt: this.now,
					lastActivity: this.now,
					changes: [],
					commits: [],
				};
				this.state.sessions.push(s);
				this.event(a.actor, "session_started", `${a.actor.name} started ${s.title}`, [s.id, base]);
				return s;
			}
			case "attach_session": {
				const s = this.owned(a, cmd.sessionId, false),
					execution = requireValue(cmd.execution, "Execution context required");
				if (s.mode === "write") {
					writeAccess(a);
					if (a.actor.kind === "agent" && (execution.kind !== "worktree" || !execution.owned))
						throw new DomainError(403, "Agent writers require a dedicated Cruce worktree");
					if (
						this.state.sessions.some(
							(other) =>
								other.id !== s.id &&
								other.mode === "write" &&
								!["completed", "cancelled"].includes(other.state) &&
								other.execution?.checkoutId === execution.checkoutId &&
								other.execution.machineId === execution.machineId,
						)
					)
						throw new DomainError(409, "Checkout already reserved by another writer; end that session first");
				}
				if (s.execution && stable({ ...s.execution, storageName: undefined }) !== stable(execution))
					throw new DomainError(409, "Session execution context is immutable");
				s.execution = { ...execution, storageName: s.execution?.storageName };
				s.branch = execution.branch ?? s.branch;
				s.state = "active";
				s.lastActivity = this.now;
				return s;
			}
			case "heartbeat": {
				const s = this.owned(a, cmd.sessionId, false);
				if (s.mode === "write" && !s.execution) throw new DomainError(409, "Attach an isolated execution context first");
				s.state = "active";
				s.lastActivity = this.now;
				return s;
			}
			case "report_change": {
				const s = this.owned(a, cmd.sessionId);
				if (!s.execution) throw new DomainError(409, "Attach an execution context first");
				const changes = requireValue(cmd.changes, "Changes required");
				const before = stable(s.changes);
				s.changes = changes;
				s.headRevision = requireValue(cmd.revision, "Head revision required");
				s.commits = cmd.commits ?? [];
				s.branch = cmd.branch ?? s.branch;
				s.lastActivity = this.now;
				s.state = "active";
				if (before !== stable(changes))
					this.event(a.actor, "changes_reported", `${a.actor.name} changed ${changes.length} files`, [s.id, s.headRevision]);
				return s;
			}
			case "end_session": {
				const s = this.owned(a, cmd.sessionId, false);
				s.state = cmd.cancelled ? "cancelled" : "completed";
				s.endedAt = this.now;
				this.event(a.actor, "session_ended", `${a.actor.name} ${s.state} ${s.title}`, [s.id]);
				return s;
			}
			case "report_ref": {
				const s = this.owned(a, cmd.sessionId);
				const ref = requireValue(cmd.ref, "Ref required"),
					revision = requireValue(cmd.revision, "Revision required");
				const observation = { ref, revision, sessionId: s.id, actorId: a.actor.id, at: this.now, trust: "reported" as const };
				this.state.refs.push(observation);
				this.event(a.actor, "ref_observed", `${a.actor.name} reported ${ref} at ${revision.slice(0, 7)}`, [s.id, revision]);
				return observation;
			}
			case "create_proposal": {
				writeAccess(a);
				const artifact = this.artifact(cmd.artifactId),
					s = this.session(artifact.sessionId);
				if (artifact.kind !== "source" || s.actor.id !== a.actor.id)
					throw new DomainError(403, "Propose a source artifact produced by your session");
				const p: Proposal = {
					id: this.nextId(),
					number: this.state.proposals.length + 1,
					sessionId: s.id,
					artifactId: artifact.id,
					base: s.baseRevision,
					revision: artifact.revision,
					title: cmd.title ?? artifact.title,
					state: "open",
					reviews: [],
					at: this.now,
				};
				this.state.proposals.push(p);
				this.event(a.actor, "change_proposed", p.title, [p.id, s.id, artifact.id, p.revision]);
				return p;
			}
			case "review_proposal": {
				writeAccess(a);
				const p = this.proposal(cmd.proposalId);
				if (p.state !== "open" || cmd.revision !== p.revision || !["approve", "concern", "disagree"].includes(cmd.outcome ?? ""))
					throw new DomainError(409, "Review must name the open change's exact revision");
				p.reviews.push({
					id: this.nextId(),
					actor: a.actor,
					revision: p.revision,
					outcome: cmd.outcome as "approve" | "concern" | "disagree",
					reason: requireValue(cmd.reason, "Review reason required"),
					at: this.now,
				});
				this.event(a.actor, "change_reviewed", `${a.actor.name} reviewed ${p.title}`, [p.id, p.revision]);
				return p;
			}
			case "resolve_review": {
				humanMaintain(a);
				const p = this.proposal(cmd.proposalId),
					r = p.reviews[requireValue(cmd.reviewIndex, "Review index required")];
				if (!r || r.outcome === "approve") throw new DomainError(400, "Concern unavailable");
				r.resolution = { actor: a.actor, reason: requireValue(cmd.reason, "Resolution reason required"), at: this.now };
				this.event(a.actor, "review_resolved", r.resolution.reason, [p.id]);
				return p;
			}
			case "record_verification": {
				writeAccess(a);
				const p = this.proposal(cmd.proposalId);
				if (cmd.revision !== p.revision || !["pass", "fail"].includes(cmd.outcome ?? ""))
					throw new DomainError(409, "Verification must name the exact revision");
				if (cmd.humanAttested) humanMaintain(a);
				if (cmd.artifactId && this.artifact(cmd.artifactId).revision !== p.revision)
					throw new DomainError(409, "Evidence revision mismatch");
				const v = {
					id: this.nextId(),
					proposalId: p.id,
					revision: p.revision,
					kind: requireValue(cmd.kind, "Verification kind required"),
					outcome: cmd.outcome as "pass" | "fail",
					trust: cmd.humanAttested ? ("human_attested" as const) : ("reported" as const),
					actor: a.actor,
					summary: requireValue(cmd.reason, "Verification summary required"),
					artifactId: cmd.artifactId,
					at: this.now,
				};
				this.state.verifications.push(v);
				this.event(a.actor, "verification_recorded", v.summary, [p.id, v.id]);
				return v;
			}
			case "request_promotion": {
				writeAccess(a);
				const p = this.proposal(cmd.proposalId);
				this.event(a.actor, "promotion_requested", `Human promotion requested for ${p.title}`, [p.id]);
				return this.readiness(p);
			}
			case "reject_proposal": {
				humanMaintain(a);
				const p = this.proposal(cmd.proposalId);
				if (p.state !== "open") throw new DomainError(409, "Change is not open");
				p.state = "rejected";
				this.event(a.actor, "change_rejected", requireValue(cmd.reason, "Reason required"), [p.id]);
				return p;
			}
			case "configure_environment": {
				humanMaintain(a);
				const input = requireValue(cmd.environment, "Environment required");
				if (cmd.environmentId && !this.state.environments.some((e) => e.id === cmd.environmentId))
					throw new DomainError(404, "Environment unavailable");
				const env = { id: cmd.environmentId ?? this.nextId(), ...input, deployRepository: `repo-${this.state.repository.id}-deploy` };
				this.state.environments = [...this.state.environments.filter((e) => e.id !== env.id), env];
				this.event(a.actor, "environment_configured", `Configured ${env.name}`, [env.id]);
				return env;
			}
			default:
				throw new DomainError(400, "Unsupported repository command");
		}
	}
	addArtifact(artifact: Artifact) {
		this.state.artifacts.push(artifact);
		this.event(artifact.actor, "artifact_published", artifact.title, [artifact.id, artifact.sessionId, artifact.revision]);
		return artifact;
	}
	prepareDeployment(cmd: Command, a: Authority): Deployment {
		const artifact = this.artifact(cmd.artifactId),
			env = this.state.environments.find((e) => e.id === cmd.environmentId);
		if (!env) throw new DomainError(404, "Environment unavailable");
		if (artifact.kind !== "source") throw new DomainError(400, "Deployment requires an immutable source artifact");
		if (env.kind === "production") {
			humanMaintain(a);
			if (!cmd.deploymentId) {
				const proposal = this.state.proposals.find((p) => p.artifactId === artifact.id);
				if (!proposal || !this.readiness(proposal, true).ready)
					throw new DomainError(409, "Production requires exact-revision review and verification");
			}
		} else writeAccess(a);
		const previous = this.state.deployments.filter((d) => d.environmentId === env.id && d.state === "deployed").at(-1);
		if (
			cmd.deploymentId &&
			!this.state.deployments.some(
				(d) => d.id === cmd.deploymentId && d.environmentId === env.id && d.artifactId === artifact.id && d.state === "deployed",
			)
		)
			throw new DomainError(409, "Rollback must name a previously deployed artifact in this environment");
		for (const pending of this.state.deployments.filter((d) => d.environmentId === env.id && ["queued", "building"].includes(d.state))) {
			pending.state = "superseded";
			pending.updatedAt = this.now;
		}
		const deployment: Deployment = {
			id: this.nextId(),
			environmentId: env.id,
			artifactId: artifact.id,
			revision: artifact.revision,
			sessionId: artifact.sessionId,
			actor: a.actor,
			state: "queued",
			branch: env.kind === "production" ? "main" : `cruce/${env.id}`,
			previous: previous?.id,
			rollbackOf: cmd.deploymentId,
			at: this.now,
			updatedAt: this.now,
		};
		this.state.deployments.push(deployment);
		this.event(a.actor, "deployment_requested", `Requested ${env.name}`, [deployment.id, artifact.id]);
		return deployment;
	}
}
