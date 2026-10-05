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
export interface Repository {
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
	"workspace.fork",
	"workspace.cleanup",
	"revision.publish",
	"artifact.publish",
] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];
export type ResourceRule = "allow" | "approval" | "deny";
export type CostClass = "none" | "artifacts";
export interface ResourcePolicy {
	rules: Record<ResourceAction, ResourceRule>;
	dailyLimit: number;
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
export interface ResourceAccount {
	mode: "connected";
	accountId: string;
	label: string;
	credential: "stored" | "none";
	connectedBy?: string;
	at?: number;
}
export interface NamespaceState {
	namespace: Namespace;
	members: Record<string, NamespaceRole>;
	teams: Team[];
	invitations: Invitation[];
	repositories: Repository[];
	policy: ResourcePolicy;
	reservations: ResourceReservation[];
	version: number;
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
	/** `disconnected` is derived presence for snapshots, never stored. */
	state: "preparing" | "active" | "detached" | "disconnected" | "completed" | "cancelled";
	startedAt: number;
	lastActivity: number;
	endedAt?: number;
	changes: WorkspaceChange[];
	commits: string[];
	publishedRevision?: string;
	integratedRevision?: string;
}
export interface WorkspaceUpdates {
	baselineRevision: string;
	revision?: string;
	trust?: "accepted" | "reported";
	status: "unknown" | "current" | "available";
}
export interface WorkspaceUpdateDetails extends WorkspaceUpdates {
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
	observedAt: number;
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
	storage: { repository: string; revision: string; ref?: string; path?: string };
	at: number;
}
export interface Review {
	id: string;
	actor: Actor;
	revision: string;
	outcome: "approve" | "concern" | "disagree";
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
export interface RepositoryState {
	repository: Repository;
	version: number;
	workspaces: Workspace[];
	artifacts: Artifact[];
	proposals: Proposal[];
	verifications: Verification[];
	promotions: Promotion[];
	activity: ActivityEvent[];
	receipts: Record<string, { fingerprint: string; result: unknown }>;
	sourceHead?: string;
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
		concerns: number;
		evidence: { kind: string; trusted: boolean; reported: boolean; failed: boolean }[];
		blockedByPromotion: boolean;
	};
}
export interface RepositorySnapshot extends Omit<RepositoryState, "receipts"> {
	overlaps: Overlap[];
	workspaceUpdates: Record<string, WorkspaceUpdates>;
	permissions: { write: boolean; maintain: boolean; human: boolean };
	sourceAvailable: boolean;
	readiness: Record<string, Readiness>;
	promotionRecovery: Record<string, { command: Command; ready: boolean; reasons: string[] }>;
	forkCleanup: Record<string, { ready: boolean; reasons: string[] }>;
	executionRelease: Record<string, { ready: boolean; reasons: string[] }>;
	/** Canonical storage is missing after a failed creation; `retry` says whether this viewer may replay setup. */
	canonicalSetup: { required: boolean; retry: boolean };
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
	})
	.strict();
export type Command = z.infer<typeof CommandInput>;
