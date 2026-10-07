import { STATE_LIMITS } from "../shared/limits.ts";
import type {
	Actor,
	Artifact,
	Authority,
	Command,
	Overlap,
	Promotion,
	Proposal,
	Repository,
	RepositorySnapshot,
	RepositoryState,
	Workspace,
	WorkspaceUpdates,
} from "../shared/platform.ts";
import { humanMaintain, writeAccess } from "./capabilities.ts";
import { DomainError, requireValue, stable } from "./errors.ts";
export const WORKSPACE_TTL = 90_000;
export const initialRepository = (repository: Repository): RepositoryState => ({
	repository,
	version: 0,
	workspaces: [],
	artifacts: [],
	proposals: [],
	verifications: [],
	promotions: [],
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
	workspace(id?: string) {
		const s = this.state.workspaces.find((s) => s.id === id);
		if (!s) throw new DomainError(404, "Workspace unavailable");
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
	/** Workspace authority belongs to its owning user through any authorized connection, never to one session. */
	owned(a: Authority, id?: string) {
		writeAccess(a);
		const s = this.workspace(id);
		if (s.ownerId !== a.actor.userId) throw new DomainError(403, "Workspace belongs to another user");
		if (["completed", "cancelled"].includes(s.state)) throw new DomainError(409, "Workspace has ended");
		return s;
	}
	/** Reports describe one checkout; only the attached execution may supply them. */
	attached(a: Authority, cmd: Command) {
		const s = this.owned(a, cmd.workspaceId),
			execution = requireValue(cmd.execution, "Attached execution context required");
		if (!s.execution) throw new DomainError(409, "Attach an execution context first");
		if (s.execution.id !== execution.id || s.execution.checkoutId !== execution.checkoutId || s.execution.machineId !== execution.machineId)
			throw new DomainError(409, "Workspace is attached to a different execution context");
		return s;
	}
	live(s: Workspace) {
		return s.state === "active" && s.lastActivity + WORKSPACE_TTL > this.now;
	}
	executionRelease(s: Workspace, a: Authority) {
		const reasons: string[] = [];
		if (!s.execution) reasons.push("No execution is attached");
		if (["completed", "cancelled"].includes(s.state)) reasons.push("Workspace has ended");
		if (s.ownerId !== a.actor.userId || a.repositoryRole === "read") reasons.push("Only the workspace owner can release its execution");
		return { ready: reasons.length === 0, reasons };
	}
	upstream() {
		return this.state.sourceHead;
	}
	workspaceUpdates(s: Workspace): WorkspaceUpdates {
		const revision = this.upstream(),
			baselineRevision = revision && s.publishedRevision === revision ? revision : (s.integratedRevision ?? s.baseRevision);
		return {
			baselineRevision,
			revision,
			trust: revision ? (this.state.sourceHead ? "accepted" : "reported") : undefined,
			status: !revision ? "unknown" : revision === baselineRevision ? "current" : "available",
		};
	}
	overlaps(): Overlap[] {
		const byPath = new Map<string, Workspace[]>();
		for (const s of this.state.workspaces.filter((s) => this.live(s))) {
			for (const p of new Set(s.changes.flatMap((c) => [c.path, ...(c.previousPath ? [c.previousPath] : [])])))
				byPath.set(p, [...(byPath.get(p) ?? []), s]);
		}
		return [...byPath]
			.filter(([, s]) => s.length > 1)
			.map(([surface, s]) => ({
				id: `file:${surface}`,
				kind: "file",
				workspaces: s.map((s) => s.id).sort(),
				surface,
				evidence: "reported",
				observedAt: s.every((s) => s.lastReportAt !== undefined) ? Math.min(...s.map((s) => s.lastReportAt!)) : undefined,
			}));
	}
	forkCleanup(s: Workspace) {
		const reasons: string[] = [];
		if (!s.fork || s.fork.state === "deleted") reasons.push("No retained fork");
		if (!["completed", "cancelled"].includes(s.state)) reasons.push("End the workspace before cleaning up its fork");
		return { ready: reasons.length === 0, reasons };
	}
	private recoveryReadiness(promotion: Promotion) {
		const { ready, reasons } = this.readiness(this.proposal(promotion.proposalId), promotion);
		return { ready, reasons };
	}
	/** Promotion readiness for an exact revision, with the structured checks the console renders as a review checklist. */
	readiness(p: Proposal, promotion?: Promotion) {
		const reasons: string[] = [];
		const resuming =
			p.state === "promoting" &&
			promotion &&
			this.state.promotions.includes(promotion) &&
			promotion.proposalId === p.id &&
			promotion.from === p.base &&
			promotion.to === p.revision &&
			["prepared", "uncertain"].includes(promotion.state);
		if (p.state !== "open" && !resuming) reasons.push("Change is closed or promotion is in progress");
		if (this.state.promotions.some((other) => other !== promotion && ["prepared", "uncertain"].includes(other.state)))
			reasons.push("Reconcile the pending promotion before another canonical update");
		const head = this.upstream();
		if (head && p.base !== head) reasons.push("Base revision changed; refresh and propose the reconciled revision");
		const latest = new Map<string, (typeof p.reviews)[number]>();
		for (const r of p.reviews.filter((r) => r.revision === p.revision)) latest.set(r.actor.id, r);
		const approved = [...latest.values()].some(
			(r) => r.actor.kind === "human" && !r.actor.connectionId && r.outcome === "approve" && r.approvalAuthority === "human-maintainer",
		);
		if (!approved) reasons.push("Human approval required for this revision");
		if ([...latest.values()].some((r) => r.outcome !== "approve" && !r.resolution))
			reasons.push("Review concern requires a reasoned human resolution");
		const evidenceChecks = this.state.repository.policy.requiredEvidence.map((kind) => {
			const evidence = new Map<string, (typeof this.state.verifications)[number]>();
			for (const v of this.state.verifications.filter((v) => v.proposalId === p.id && v.revision === p.revision && v.kind === kind))
				evidence.set(v.actor.id, v);
			const current = [...evidence.values()];
			const check = {
				kind,
				trusted: current.some((v) => v.outcome === "pass" && v.trust !== "reported"),
				reported: current.some((v) => v.outcome === "pass" && v.trust === "reported"),
				failed: current.some((v) => v.outcome === "fail"),
				verificationIds: current.map((v) => v.id),
			};
			if (!check.trusted || check.failed) reasons.push(`Trusted passing ${kind} evidence required`);
			return check;
		});
		const reviews = [...latest.values()];
		return {
			ready: !reasons.length,
			reasons,
			checks: {
				open: p.state === "open" || !!resuming,
				current: !head || p.base === head,
				canonical: head,
				approved,
				reviewIds: reviews.map((r) => r.id),
				concerns: reviews.filter((r) => r.outcome !== "approve" && !r.resolution).length,
				evidence: evidenceChecks,
				blockedByPromotion: this.state.promotions.some((other) => other !== promotion && ["prepared", "uncertain"].includes(other.state)),
			},
		};
	}
	snapshot(a: Authority): RepositorySnapshot {
		const { receipts: _, ...state } = structuredClone(this.state);
		state.activity = state.activity.slice(-STATE_LIMITS.recentActivity);
		state.workspaces = state.workspaces.map((s) => ({
			...s,
			cleanup: s.cleanup ? { ...s.cleanup, command: s.cleanup.actorId === a.actor.id ? s.cleanup.command : undefined } : undefined,
			state: s.state === "active" && !this.live(s) ? "disconnected" : s.state,
		}));
		return {
			...state,
			overlaps: this.overlaps(),
			workspaceUpdates: Object.fromEntries(this.state.workspaces.map((s) => [s.id, this.workspaceUpdates(s)])),
			permissions: {
				write: a.repositoryRole !== "read",
				maintain: a.repositoryRole === "maintain",
				human: a.actor.kind === "human",
				approve: a.actor.kind === "human" && !a.actor.connectionId && a.repositoryRole === "maintain",
			},
			sourceAvailable: !!this.state.sourceHead || !!this.state.artifacts.find((a) => a.kind === "source"),
			forkCleanup: Object.fromEntries(this.state.workspaces.map((s) => [s.id, this.forkCleanup(s)])),
			executionRelease: Object.fromEntries(this.state.workspaces.map((s) => [s.id, this.executionRelease(s, a)])),
			canonicalSetup: {
				required: !this.state.canonical,
				retry: !this.state.canonical && a.actor.kind === "human" && !a.actor.connectionId && a.repositoryRole === "maintain",
			},
			readiness: Object.fromEntries(this.state.proposals.map((p) => [p.id, this.readiness(p)])),
			promotionRecovery: Object.fromEntries(
				this.state.promotions
					.filter(
						(p) =>
							p.operation &&
							p.actor.id === a.actor.id &&
							a.actor.kind === "human" &&
							!a.actor.connectionId &&
							a.repositoryRole === "maintain" &&
							p.state !== "failed" &&
							!p.operation.settled,
					)
					.map((p) => [
						p.proposalId,
						{
							command: p.operation!.command,
							...(p.state === "complete" ? { ready: true, reasons: [] } : this.recoveryReadiness(p)),
						},
					]),
			),
		};
	}
	trace(subject: string) {
		const ids = new Set([subject]);
		let changed = true;
		const records = [
			...this.state.workspaces.map((s) => ({
				type: "workspace",
				record: s,
				ids: [s.id, s.baseRevision, s.headRevision, s.createdBy.id, s.ownerId],
			})),
			...this.state.artifacts.map((a) => ({ type: "artifact", record: a, ids: [a.id, a.workspaceId, a.revision, a.actor.id] })),
			...this.state.proposals.map((p) => ({ type: "change", record: p, ids: [p.id, p.workspaceId, p.artifactId, p.revision] })),
			...this.state.verifications.map((v) => ({ type: "verification", record: v, ids: [v.id, v.proposalId, v.revision] })),
			...this.state.promotions.map((p) => ({ type: "promotion", record: p, ids: [p.id, p.proposalId, p.to] })),
		];
		// Actor identities are leaves, never edges that join every unrelated action by the same person.
		const actors = new Set(this.state.workspaces.flatMap((s) => [s.createdBy.id, s.ownerId]));
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
		if (a.repositoryId !== this.state.repository.id || a.namespaceId !== this.state.repository.namespaceId)
			throw new DomainError(403, "Repository identity mismatch");
		switch (cmd.tool) {
			case "get_repository":
				return this.snapshot(a);
			case "get_workspace":
				return this.snapshot(a).workspaces.find((s) => s.id === cmd.workspaceId) ?? this.workspace(cmd.workspaceId);
			case "get_workspace_updates":
				return this.workspaceUpdates(this.workspace(cmd.workspaceId));
			case "list_active_workspaces":
				return this.snapshot(a).workspaces.filter((s) => !["completed", "cancelled"].includes(s.state));
			case "inspect_overlap":
				return this.overlaps();
			case "get_lineage":
				return this.trace(requireValue(cmd.subjectId, "Subject required"));
			case "start_workspace": {
				writeAccess(a);
				const base = requireValue(cmd.baseRevision, "Exact base revision required");
				const s: Workspace = {
					id: this.nextId(),
					repositoryId: this.state.repository.id,
					ownerId: a.actor.userId,
					createdBy: a.actor,
					title: requireValue(cmd.title, "Workspace title required"),
					description: cmd.description,
					baseRevision: base,
					headRevision: base,
					branch: cmd.branch,
					state: "preparing",
					startedAt: this.now,
					lastActivity: this.now,
					changes: [],
					commits: [],
				};
				this.state.workspaces.push(s);
				this.event(a.actor, "workspace_started", `${a.actor.name} started ${s.title}`, [s.id, base]);
				return s;
			}
			case "attach_workspace": {
				const s = this.owned(a, cmd.workspaceId),
					execution = requireValue(cmd.execution, "Execution context required");
				if (a.actor.kind === "agent" && (!["worktree", "clone"].includes(execution.kind) || !execution.owned))
					throw new DomainError(403, "Agent writers require a dedicated Cruce worktree or clone");
				if (
					this.state.workspaces.some(
						(other) =>
							other.id !== s.id &&
							!["completed", "cancelled"].includes(other.state) &&
							other.execution?.checkoutId === execution.checkoutId &&
							other.execution.machineId === execution.machineId,
					)
				)
					throw new DomainError(409, "Checkout already reserved by another workspace; end or detach that workspace first");
				if (s.execution) {
					const { attachedBy: _, attachedAt: __, ...current } = s.execution;
					if (stable(current) !== stable(execution))
						throw new DomainError(409, "Workspace is attached to another execution context; detach it first");
				} else {
					s.execution = { ...execution, attachedBy: a.actor, attachedAt: this.now };
					this.event(a.actor, "execution_attached", `${a.actor.name} attached ${s.title}`, [s.id]);
				}
				s.branch = execution.branch ?? s.branch;
				s.state = "active";
				s.lastActivity = this.now;
				return s;
			}
			case "detach_workspace": {
				const s = this.owned(a, cmd.workspaceId);
				if (!s.execution) throw new DomainError(409, "No execution is attached");
				s.execution = undefined;
				s.state = "detached";
				s.changes = [];
				this.event(a.actor, "execution_detached", `${a.actor.name} detached ${s.title}`, [s.id, s.headRevision]);
				return s;
			}
			case "heartbeat": {
				const s = this.attached(a, cmd);
				s.state = "active";
				s.lastActivity = this.now;
				return s;
			}
			case "report_change": {
				const s = this.attached(a, cmd);
				const changes = requireValue(cmd.changes, "Changes required");
				const before = stable(s.changes);
				s.changes = changes;
				s.headRevision = requireValue(cmd.revision, "Head revision required");
				s.commits = cmd.commits ?? [];
				s.branch = cmd.branch ?? s.branch;
				s.lastActivity = this.now;
				s.state = "active";
				s.lastReportAt = this.now;
				if (before !== stable(changes))
					this.event(a.actor, "changes_reported", `${a.actor.name} changed ${changes.length} ${changes.length === 1 ? "file" : "files"}`, [
						s.id,
						s.headRevision,
					]);
				return s;
			}
			case "end_workspace": {
				const s = this.owned(a, cmd.workspaceId);
				s.state = cmd.cancelled ? "cancelled" : "completed";
				s.endedAt = this.now;
				this.event(a.actor, "workspace_ended", `${a.actor.name} ${s.state} ${s.title}`, [s.id]);
				return s;
			}
			case "create_proposal": {
				writeAccess(a);
				const artifact = this.artifact(cmd.artifactId),
					s = this.workspace(artifact.workspaceId);
				if (artifact.kind !== "source" || s.ownerId !== a.actor.userId)
					throw new DomainError(403, "Propose a published revision from your own workspace");
				const p: Proposal = {
					id: this.nextId(),
					number: this.state.proposals.length + 1,
					workspaceId: s.id,
					artifactId: artifact.id,
					base: artifact.baseRevision ?? s.baseRevision,
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
				if (cmd.outcome === "approve" && a.actor.kind === "human") humanMaintain(a);
				const p = this.proposal(cmd.proposalId);
				if (p.state !== "open" || cmd.revision !== p.revision || !["approve", "concern", "disagree"].includes(cmd.outcome ?? ""))
					throw new DomainError(409, "Review must name the open change's exact revision");
				p.reviews.push({
					id: this.nextId(),
					actor: a.actor,
					revision: p.revision,
					outcome: cmd.outcome as "approve" | "concern" | "disagree",
					approvalAuthority: cmd.outcome === "approve" && a.actor.kind === "human" ? "human-maintainer" : undefined,
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
			default:
				throw new DomainError(400, "Unsupported repository command");
		}
	}
	addArtifact(artifact: Artifact) {
		this.state.artifacts.push(artifact);
		this.event(artifact.actor, "artifact_published", artifact.title, [artifact.id, artifact.workspaceId, artifact.revision]);
		return artifact;
	}
}
