import { z } from "zod";

export type NamespaceRole = "owner" | "maintainer" | "developer" | "viewer";
export type RepositoryRole = "read" | "write" | "maintain";
export type ActorKind = "human" | "agent" | "system";
export interface User {
	id: string;
	issuer: string;
	subject: string;
	email: string;
	name: string;
	personalNamespaceId: string;
}
/** One agent OAuth connection as the console lists it. The client name is the label the agent supplied, never proof of the tool. */
/** An agent connection's repository approval: every repository its user can access, or the chosen ones. */
export type RepositoryApproval = "all" | string[];
export interface AgentConnection {
	id: string;
	client: string;
	connectionId?: string;
	/**
	 * Every repository its user can access ("all", following current access including later repositories), or the chosen
	 * repositories labelled as they were named at approval; absent for older grants.
	 */
	repositories?: "all" | { id: string; label: string }[];
	scopes: string[];
	createdAt: number;
	expiresAt?: number;
}
export interface Actor {
	id: string;
	kind: ActorKind;
	userId: string;
	name: string;
	connectionId?: string;
}
export interface Authority {
	actor: Actor;
	namespaceId: string;
	repositoryId?: string;
	role: NamespaceRole;
	repositoryRole?: RepositoryRole;
	scopes?: string[];
	/** The namespace owner authorized its permanent deletion; only that deletion may change anything. */
	namespaceDeleting?: true;
}
export interface Namespace {
	id: string;
	handle: string;
	name: string;
	kind: "personal" | "shared";
	ownerId: string;
	createdAt: number;
}
export interface Team {
	id: string;
	name: string;
	members: string[];
}
export interface Invitation {
	id: string;
	email: string;
	role: Exclude<NamespaceRole, "owner">;
	tokenHash: string;
	expiresAt: number;
	acceptedBy?: string;
}
export interface RepositoryLifecycle {
	state: "active" | "archived" | "deleting" | "deleted";
	at: number;
	actorId: string;
	operationId: string;
}
export interface RepositoryLifecycleView {
	state: RepositoryLifecycle["state"];
	owner: boolean;
	/** What stops archive: unfinished work and anything deletion also waits for. */
	blockers: string[];
	/** What stops permanent deletion: in-flight promotions, provider operations and observation cleanup. */
	deletionBlockers: string[];
	/** Work that permanent deletion ends with the repository. */
	unfinished: { workspaces: number; attached: number; changes: number };
	/** Its storage is legacy and unreachable: deletion can only forget it, removing Cruce's records but not that storage. */
	forgetStorage?: true;
	/** Cloud operations that never settled; the owner can release each after deciding nothing more will come of it. */
	operations?: { id: string; action: ResourceAction; state: "reserved" | "uncertain"; at: number; workspaceId?: string }[];
	deletion?: { idempotencyKey: string; reason?: string; forgetStorage?: true };
	transition?: { tool: "archive_repository" | "restore_repository"; idempotencyKey: string };
}
export interface NamespaceLifecycle {
	state: "deleting" | "deleted";
	at: number;
	actorId: string;
	operationId: string;
}
/** What the namespace owner sees before and during permanent namespace deletion. */
export interface NamespaceDeletionView {
	state: "active" | NamespaceLifecycle["state"];
	/** Only shared namespaces can be deleted; a personal namespace belongs to its account. */
	deletable: boolean;
	owner: boolean;
	repositories: number;
	archived: number;
	/** Work that deletion ends with the repositories, summed across them. */
	unfinished: { workspaces: number; attached: number; changes: number };
	/** What stops deletion, each naming its repository. */
	blockers: string[];
	/** Its storage is legacy and unreachable: deletion can only forget its repositories' storage, never remove it. */
	forgetStorage: boolean;
	deletion?: { idempotencyKey: string; reason?: string; remaining: number; forgetStorage?: true };
}
export interface Repository {
	lifecycle?: RepositoryLifecycle;
	id: string;
	namespaceId: string;
	name: string;
	defaultBranch: string;
	createdAt: number;
	storageName: string;
	grants: { subject: "user" | "team"; id: string; role: RepositoryRole }[];
	policy: { protectedPaths: string[]; requiredEvidence: string[]; resourceRules: Partial<Record<ResourceAction, ResourceRule>> };
}
export const RESOURCE_ACTIONS = [
	"repository.create",
	"repository.delete",
	"workspace.fork",
	"workspace.cleanup",
	"revision.publish",
	"artifact.publish",
	"source.read",
	"observation.read",
] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];
export type ResourceRule = "allow" | "approval" | "deny";
export type CostClass = "none" | "artifacts";
export interface ResourcePolicy {
	rules: Record<ResourceAction, ResourceRule>;
}
export interface ResourceReservation {
	id: string;
	fingerprint: string;
	repositoryId: string;
	workspaceId?: string;
	action: ResourceAction;
	actorId: string;
	at: number;
	state: "reserved" | "complete" | "uncertain" | "released";
}
export type ResourceStorage =
	| { mode: "deployment"; ready: true }
	/** `legacy`: connected-account storage from before deployment-managed storage, which Cruce can no longer reach. */
	| { mode: "deployment"; ready: false; reason: string; legacy?: true };
export interface NamespaceState {
	namespace: Namespace;
	members: Record<string, NamespaceRole>;
	teams: Team[];
	invitations: Invitation[];
	repositories: Repository[];
	policy: ResourcePolicy;
	reservations: ResourceReservation[];
	version: number;
	lifecycle?: NamespaceLifecycle;
}
/** Local materialization and ownership metadata; the Workspace remains the durable work identity. */
export interface ExecutionContext {
	id: string;
	checkoutId: string;
	machineId: string;
	kind: "worktree" | "clone" | "checkout";
	owned: boolean;
	branch?: string;
}
/** The single current execution of a workspace; replaceable only through an explicit detach. */
export interface ExecutionAttachment extends ExecutionContext {
	attachedBy: Actor;
	attachedAt: number;
}
export interface WorkspaceChange {
	path: string;
	previousPath?: string;
	status: "added" | "modified" | "deleted" | "renamed";
	binary?: boolean;
}
/**
 * Durable unit of concurrent Git work: owner + immutable baseline + fork + revisions.
 * Independent of agent sessions, processes, checkouts and machines; the execution is replaceable.
 */
export interface Workspace {
	id: string;
	repositoryId: string;
	/** User who owns the workspace; any of their authorized connections may act on it. */
	ownerId: string;
	/** Provenance only: the actor that started the workspace. */
	createdBy: Actor;
	title: string;
	description?: string;
	baseRevision: string;
	headRevision: string;
	branch?: string;
	execution?: ExecutionAttachment;
	fork?: { name: string; id: string; remote: string; state: "ready" | "deleting" | "deleted" };
	retention?: RetentionInspection;
	cleanup?: {
		operationId: string;
		actorId: string;
		command?: Command;
		state: "pending" | "blocked" | "complete";
		phase: "authorized" | "deleting" | "confirmed";
		attempts: number;
		nextAttempt?: number;
		reason?: string;
	};
	/** `disconnected` is derived presence for snapshots, never stored. */
	state: "preparing" | "active" | "detached" | "disconnected" | "completed" | "cancelled";
	startedAt: number;
	lastActivity: number;
	/** Change-report time, independent of presence. Missing historical values are unknown. */
	lastReportAt?: number;
	endedAt?: number;
	changes: WorkspaceChange[];
	commits: string[];
	publishedRevision?: string;
	integratedRevision?: string;
	/** Time of the last `changes_reported` event; reports in between are coalesced. */
	changeEventAt?: number;
	/** A reported change is waiting for the coalescing window to close. */
	changeEventPending?: boolean;
}
export interface RetentionInspection {
	checkedAt: number;
	forkId: string;
	complete: boolean;
	refs: { ref: string; revision: string; retained: boolean; reason?: "unretained" | "unavailable" }[];
	blockers: string[];
}
/** Provider observations are never publication or acceptance. */
export interface RefObservation {
	providerId: string;
	ref: string;
	revision?: string;
	deleted: boolean;
	checkedAt: number;
	generation: number;
}
export interface ObservationStatus {
	enabled: boolean;
	state: "disabled" | "pending" | "healthy" | "degraded";
	generation: number;
	lastCheckedAt?: number;
	pending: number;
	reason?: string;
	canonical?: RefObservation;
	workspaces: Record<string, RefObservation>;
	estimatedDailyOperations: number;
}
export type GitRelation = "unknown" | "current" | "ahead" | "behind" | "diverged" | "unrelated";
export interface ReportFreshness {
	state: "fresh" | "stale" | "unknown";
	reportedAt?: number;
	ageMs?: number;
}
export interface ReconciliationView {
	asOf: number;
	acceptedRevision?: string;
	canonicalRevision?: string;
	observation: ObservationStatus;
	workspaces: {
		workspaceId: string;
		revision: string;
		basis: "published" | "baseline";
		canonicalRevision?: string;
		relation: GitRelation;
		report: ReportFreshness;
		incorporationCounts: { present: number; missing: number; unknown: number };
		incorporationTruncated: boolean;
		incorporation: { revision: string; promotionId: string; state: "present" | "missing" | "unknown" }[];
	}[];
	proposals: { proposalId: string; stale: boolean; readiness: Readiness }[];
}
export interface WorkspaceUpdates {
	baselineRevision: string;
	revision?: string;
	trust?: "accepted" | "reported" | "observed";
	status: "unknown" | "current" | "available";
}
export interface WorkspaceUpdateDetails extends WorkspaceUpdates {
	basis?: "published" | "baseline";
	comparedRevision?: string;
	available: boolean;
	comparison: "unavailable" | "current" | "ahead" | "behind" | "diverged" | "unrelated";
	changes: WorkspaceChange[];
	overlappingPaths: string[];
	overlapTrust: "reported";
}
export interface Overlap {
	id: string;
	kind: "file" | "symbol";
	workspaces: string[];
	surface: string;
	evidence: "reported";
	observedAt?: number;
}
/** Cruce retained source/evidence record, not the Cloudflare Artifacts provider; retention does not imply correctness. */
export interface Artifact {
	id: string;
	namespaceId: string;
	repositoryId: string;
	workspaceId: string;
	actor: Actor;
	revision: string;
	baseRevision?: string;
	kind: "source" | "evidence";
	title: string;
	contentHash: string;
	trust: "reported" | "human_attested";
	storage: { repository: string; providerId: string; revision: string; ref?: string; path?: string };
	at: number;
}
export interface Review {
	id: string;
	actor: Actor;
	revision: string;
	outcome: "approve" | "concern" | "disagree";
	/** Server-recorded authority at approval time; never accepted as a command input. */
	approvalAuthority?: "human-maintainer";
	reason: string;
	at: number;
	resolution?: { actor: Actor; reason: string; at: number };
}
export interface Verification {
	id: string;
	proposalId: string;
	revision: string;
	kind: string;
	outcome: "pass" | "fail";
	trust: "reported" | "human_attested";
	actor: Actor;
	summary: string;
	artifactId?: string;
	at: number;
}
/** Product-facing change: an exact source artifact proposed for review, not acceptance into canonical Git. */
export interface Proposal {
	id: string;
	number: number;
	workspaceId: string;
	artifactId: string;
	base: string;
	revision: string;
	title: string;
	state: "open" | "rejected" | "promoting" | "promoted";
	reviews: Review[];
	at: number;
}
export interface Promotion {
	id: string;
	proposalId: string;
	from: string;
	to: string;
	actor: Actor;
	at: number;
	state: "prepared" | "uncertain" | "failed" | "complete";
	operation?: {
		id: string;
		fingerprint: string;
		reservationId: string;
		phase: "prepared" | "attempted" | "confirmed";
		command: Command;
		settled?: boolean;
	};
}
export interface ActivityEvent {
	id: string;
	actor: Actor;
	kind: string;
	summary: string;
	ids: string[];
	at: number;
}
/**
 * Finished work moved out of hot repository state: one ended workspace whose fork is gone, with its
 * closed changes, publications, evidence and settled promotions. Immutable once written; never deleted.
 */
export interface ArchiveBundle {
	sequence: number;
	archivedAt: number;
	workspace: Workspace;
	artifacts: Artifact[];
	proposals: Proposal[];
	verifications: Verification[];
	promotions: Promotion[];
}
export interface RepositoryState {
	repository: Repository;
	version: number;
	/** Lifetime change count; change numbers never repeat after finished work is archived. */
	proposalCount: number;
	/** Finished-work bundles moved to archive records. */
	archiveCount: number;
	workspaces: Workspace[];
	artifacts: Artifact[];
	proposals: Proposal[];
	verifications: Verification[];
	promotions: Promotion[];
	activity: ActivityEvent[];
	receipts: Record<string, { fingerprint: string; result: unknown }>;
	sourceHead?: string;
	/** Latest confirmed provider ref; never accepted provenance. */
	observedCanonical?: RefObservation;
	canonical?: { id: string; name: string; remote: string };
}
/** Controller-derived promotion readiness for one exact revision. */
export interface Readiness {
	ready: boolean;
	reasons: string[];
	checks: {
		open: boolean;
		/** The proposal's base is the current canonical revision. */
		current: boolean;
		canonical?: string;
		approved: boolean;
		reviewIds: string[];
		concerns: number;
		evidence: { kind: string; trusted: boolean; reported: boolean; failed: boolean; verificationIds: string[] }[];
		blockedByPromotion: boolean;
	};
}
/** Presentation groups for what a change or workspace needs next; they guide attention and never sequence or gate work. */
export type AttentionGroup = "recovery" | "promote" | "review" | "preparation" | "reconciliation";
/** One structured reason a change or workspace cannot simply be promoted; the console words it, never parses it. */
export type AttentionBlocker =
	| { kind: "promotion_unsettled" }
	| { kind: "promotion_unrecorded" }
	| { kind: "base_stale"; base: string; canonical?: string }
	| { kind: "canonical_relation"; relation: "behind" | "diverged" | "unrelated"; canonical?: string }
	| { kind: "ancestry_missing"; count: number }
	| { kind: "evidence_failed"; check: string }
	| { kind: "evidence_missing"; check: string }
	| { kind: "evidence_reported"; check: string }
	| { kind: "concern"; count: number }
	| { kind: "approval_required" }
	| { kind: "canonical_discrepancy" }
	| { kind: "promotion_pending" };
/**
 * What this viewer may do about an item under current authority. Console decisions (attest, resolve, approve, promote,
 * reconcile_promotion) need a human maintainer; owner work (prepare, reconcile with Git) happens in the owner's own tools.
 */
export type AttentionAction =
	| "reconcile_promotion"
	| "promote"
	| "attest_evidence"
	| "resolve_concern"
	| "approve"
	| "prepare_revision"
	| "reconcile_with_git"
	| "inspect";
export interface AttentionItem {
	subject: "change" | "workspace";
	/** The change or workspace ID. */
	id: string;
	number?: number;
	title: string;
	workspaceId: string;
	/** Accountable user; resolve the display name through authorized identity data. */
	ownerId: string;
	/** The exact revision this item is about: a change's proposed revision, or a workspace's published revision or baseline. */
	revision: string;
	/** Comparison basis: the change's pinned review base, or the canonical revision a workspace was compared with. */
	base?: string;
	basis?: "published" | "baseline";
	group: AttentionGroup;
	/** Every blocker, primary first. Empty only when the change is ready to promote. */
	blockers: AttentionBlocker[];
	/** Eligible next actions for this viewer, most useful first; `inspect` alone when the decision belongs to someone else. */
	actions: AttentionAction[];
	/** True when the viewer has an eligible action beyond inspection. */
	mine: boolean;
	at: number;
}
/** Read-only projection of current state and viewer authority; never persisted, never a task or workflow state. */
export interface AttentionView {
	asOf: number;
	viewerId: string;
	items: AttentionItem[];
	/** Live workspaces whose canonical relation is unknown: missing knowledge, not confirmed current work. */
	ancestryUnavailable: number;
}
export interface RepositorySnapshot extends Omit<RepositoryState, "receipts"> {
	lifecycle?: RepositoryLifecycleView;
	reconciliation?: ReconciliationView;
	attention?: AttentionView;
	asOf?: number;
	overlaps: Overlap[];
	workspaceUpdates: Record<string, WorkspaceUpdates>;
	permissions: { write: boolean; maintain: boolean; human: boolean; approve: boolean };
	sourceAvailable: boolean;
	readiness: Record<string, Readiness>;
	promotionRecovery: Record<string, { command: Command; ready: boolean; reasons: string[] }>;
	executionRelease: Record<string, { ready: boolean; reasons: string[] }>;
	/** Whether this viewer can delete each workspace: end it, withdraw its open changes and delete its fork. */
	workspaceDeletion: Record<string, { ready: boolean; reasons: string[] }>;
	/** Canonical storage is missing after a failed creation; `retry` says whether this viewer may replay setup. */
	canonicalSetup: { required: boolean; retry: boolean; settlementPending?: boolean };
	capacity?: { bytes: number; records: number; stateBytes: number; limits: typeof import("./limits.ts").STATE_LIMITS };
}

export const id = z.string().min(1).max(160);
export const revision = z.string().regex(/^[0-9a-f]{40}$/);
export const name = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const path = z
	.string()
	.min(1)
	.max(400)
	.refine(
		(p) => !p.startsWith("/") && !/[\\\0]/.test(p) && p.split("/").every((s) => s && s !== "." && s !== ".."),
		"Relative repository path required",
	);
export const branch = z
	.string()
	.min(1)
	.max(200)
	.refine(
		(s) =>
			!/[\s~^:?*[\\]/.test(s) &&
			!s.includes("..") &&
			!s.includes("@{") &&
			!s.startsWith("-") &&
			!s.startsWith("/") &&
			!s.endsWith("/") &&
			!s.endsWith(".") &&
			s.split("/").every((p) => p && !p.startsWith(".") && !p.endsWith(".lock")),
		"Valid Git branch required",
	);
export const ExecutionInput = z
	.object({
		id,
		checkoutId: id,
		machineId: id,
		kind: z.enum(["worktree", "clone", "checkout"]),
		owned: z.boolean(),
		branch: branch.optional(),
	})
	.strict();
export const ChangeInput = z
	.object({
		path,
		previousPath: path.optional(),
		status: z.enum(["added", "modified", "deleted", "renamed"]),
		binary: z.boolean().optional(),
	})
	.strict();
export const CommandInput = z
	.object({
		tool: z.string(),
		confirmation: z.string().max(120).optional(),
		forgetStorage: z.literal(true).optional(),
		reservationId: z.string().min(1).max(400).optional(),
		enabled: z.boolean().optional(),
		namespaceId: id.optional(),
		repositoryId: id.optional(),
		workspaceId: id.optional(),
		idempotencyKey: id.optional(),
		title: z.string().min(1).max(200).optional(),
		description: z.string().max(10000).optional(),
		baseRevision: revision.optional(),
		revision: revision.optional(),
		branch: branch.optional(),
		execution: ExecutionInput.optional(),
		changes: z.array(ChangeInput).max(5000).optional(),
		commits: z.array(revision).max(1000).optional(),
		cancelled: z.boolean().optional(),
		artifactId: id.optional(),
		proposalId: id.optional(),
		subjectId: id.optional(),
		content: z.string().max(1000000).optional(),
		kind: z.string().max(100).optional(),
		outcome: z.enum(["approve", "concern", "disagree", "pass", "fail", "reject"]).optional(),
		reason: z.string().min(1).max(2000).optional(),
		reviewIndex: z.number().int().nonnegative().optional(),
		humanAttested: z.boolean().optional(),
		ref: branch.optional(),
		path: path.optional(),
		cursor: z.string().max(1000).optional(),
		sourceView: z.enum(["files", "history", "diff", "artifact"]).optional(),
	})
	.strict();
export type Command = z.infer<typeof CommandInput>;
