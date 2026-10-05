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
	"preview.deploy",
	"production.deploy",
] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];
export type ResourceRule = "allow" | "approval" | "deny";
export type CostClass = "none" | "local" | "artifacts" | "metered" | "metered_production";
export interface ResourcePolicy {
	rules: Record<ResourceAction, ResourceRule>;
	dailyLimit: number;
	previewsPerWorkspace: number;
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
	capabilities: ("artifacts" | "builds")[];
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
export interface ExecutionContext {
	id: string;
	checkoutId: string;
	machineId: string;
	kind: "worktree" | "clone" | "checkout";
	owned: boolean;
	branch?: string;
}
export interface WorkspaceChange {
	path: string;
	previousPath?: string;
	status: "added" | "modified" | "deleted" | "renamed";
	binary?: boolean;
}
/** Durable repository work: actor + task + immutable base + fork, independent of client presence. */
export interface Workspace {
	id: string;
	repositoryId: string;
	actor: Actor;
	title: string;
	baseRevision: string;
	headRevision: string;
	branch?: string;
	mode: "read" | "write";
	context?: string;
	execution?: ExecutionContext;
	fork?: { name: string; id: string; remote: string; state: "ready" | "deleting" | "deleted" };
	state: "preparing" | "active" | "disconnected" | "completed" | "cancelled";
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
export interface RefObservation {
	ref: string;
	revision: string;
	workspaceId: string;
	actorId: string;
	at: number;
	trust: "reported" | "verified";
}
export interface Artifact {
	id: string;
	namespaceId: string;
	repositoryId: string;
	workspaceId: string;
	actor: Actor;
	revision: string;
	baseRevision?: string;
	kind: "source" | "evidence" | "build";
	title: string;
	contentHash: string;
	trust: "reported" | "human_attested" | "runtime_verified";
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
	trust: "reported" | "human_attested" | "runtime_verified";
	actor: Actor;
	summary: string;
	artifactId?: string;
	at: number;
}
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
	state: "prepared" | "complete";
}
export interface SmokeCheck {
	path: string;
	expectStatus: number;
}
export interface Environment {
	id: string;
	name: string;
	kind: "preview" | "production";
	workerName: string;
	deployRepository: string;
	scriptTag?: string;
	smokeChecks: SmokeCheck[];
}
export interface Deployment {
	id: string;
	environmentId: string;
	artifactId: string;
	revision: string;
	workspaceId: string;
	actor: Actor;
	state: "queued" | "building" | "deployed" | "failed" | "superseded";
	branch: string;
	buildId?: string;
	runtimeVersion?: string;
	url?: string;
	previous?: string;
	rollbackOf?: string;
	error?: string;
	smoke?: { ok: boolean; at: number };
	at: number;
	updatedAt: number;
}
export type DeploymentProfile =
	| { kind: "unknown"; revision: string }
	| { kind: "cloudflare_worker"; revision: string; configPath: string; workerName?: string };
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
	environments: Environment[];
	deployments: Deployment[];
	refs: RefObservation[];
	activity: ActivityEvent[];
	receipts: Record<string, { fingerprint: string; result: unknown }>;
	sourceHead?: string;
	canonical?: { id: string; name: string; remote: string };
}
export interface RepositorySnapshot extends Omit<RepositoryState, "receipts"> {
	overlaps: Overlap[];
	workspaceUpdates: Record<string, WorkspaceUpdates>;
	permissions: { write: boolean; maintain: boolean; human: boolean };
	sourceAvailable: boolean;
	readiness: Record<string, { ready: boolean; reasons: string[] }>;
	forkCleanup: Record<string, { ready: boolean; reasons: string[] }>;
	context?: { available: boolean; files: Record<string, string> };
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
		context: z.string().max(10000).optional(),
		baseRevision: revision.optional(),
		revision: revision.optional(),
		branch: branch.optional(),
		mode: z.enum(["read", "write"]).optional(),
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
		environmentId: id.optional(),
		environment: z
			.object({
				name: z.string().min(1).max(80),
				kind: z.enum(["preview", "production"]),
				workerName: name,
				smokeChecks: z
					.array(z.object({ path: z.string().regex(/^\/(?!\/)[^\r\n]*$/), expectStatus: z.number().int().min(100).max(599) }))
					.max(10),
			})
			.optional(),
		deploymentId: id.optional(),
		ref: branch.optional(),
		path: path.optional(),
	})
	.strict();
export type Command = z.infer<typeof CommandInput>;
