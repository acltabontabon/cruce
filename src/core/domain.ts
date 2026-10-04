import { z } from "zod";

/**
 * Core domain for Cruce. Everything in src/core is pure TypeScript: no Cloudflare APIs, no I/O,
 * so the controller can be unit-tested and replayed deterministically.
 */

export const Priority = z.enum(["low", "normal", "high", "critical"]);
export type Priority = z.infer<typeof Priority>;
export const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

/** How a plan names a piece of airspace. Agents use loose names; the airspace index resolves them. */
export const ResourceType = z.enum(["module", "file", "component", "symbol"]);
export type ResourceType = z.infer<typeof ResourceType>;

export const PlanResource = z.object({
	type: ResourceType,
	resource: z.string().min(1).max(300),
	reason: z.string().max(400).optional(),
});
export type PlanResource = z.infer<typeof PlanResource>;

export const ContractChange = z.enum(["behavior", "signature", "removal"]);
export type ContractChange = z.infer<typeof ContractChange>;

export const PlanContract = z.object({
	resource: z.string().min(1).max(300),
	change: ContractChange,
	note: z.string().max(400).optional(),
});
export type PlanContract = z.infer<typeof PlanContract>;

/**
 * A Flight Plan: the territory a Flight intends to read, write, and whose contract it intends to change.
 * It is a prediction filed after discovery, and it is amended as the agent learns more.
 */
export const FlightPlanInput = z.object({
	summary: z.string().min(1).max(200),
	intent: z.string().min(1).max(1000),
	readSet: z.array(PlanResource).max(100).default([]),
	writeSet: z.array(PlanResource).max(100).default([]),
	contractSet: z.array(PlanContract).max(50).default([]),
	dependencies: z.array(z.string().max(20)).max(20).default([]),
	assumptions: z.array(z.string().max(300)).max(20).default([]),
	risk: Risk.default("medium"),
});
export type FlightPlanInput = z.input<typeof FlightPlanInput>;
export type FlightPlanFields = z.output<typeof FlightPlanInput>;

export interface FlightPlan extends FlightPlanFields {
	flightId: string;
	planVersion: number;
	filedAt: number;
	baseline: string;
	/** Present on v2+ plans: what changed relative to the previous version. */
	amendment?: PlanAmendmentSummary;
}

export interface PlanAmendmentSummary {
	reason: string;
	added: string[];
	removed: string[];
}

export type FlightPhase =
	| "queued"
	| "provisioning"
	| "discovery"
	| "planned"
	| "executing"
	| "publishing"
	| "validating"
	| "landing"
	| "landed"
	| "failed"
	| "lost"
	| "cancelled";

export const TERMINAL_PHASES: ReadonlySet<FlightPhase> = new Set(["landed", "failed", "lost", "cancelled"]);

export type ClearanceStatus = "none" | "clear" | "partial" | "hold";

export type AgentKind = "mock" | "claude-code" | "external";

export interface Mission {
	id: string;
	title: string;
	description: string;
	priority: Priority;
	createdAt: number;
	baseRevision: string;
	createdBy: string;
	constraints?: string[];
}

export interface ArtifactRef {
	namespace: string;
	repo: string;
	repoId?: string;
	remote: string;
	baseCommit: string;
	forkedFrom: string;
	createdAt: number;
	/** The latest commit Cruce has seen on the Flight repo (via push event or gated publish). */
	head?: string;
}

export interface StaleNotice {
	since: number;
	byFlight: string;
	reasons: string[];
	newBaseline: string;
}

export interface PublishRecord {
	at: number;
	commit: string;
	planVersion?: number;
	approved: boolean;
	touched: string[];
	outside: string[];
	message: string;
	tests?: { passed: boolean; summary: string };
	verified?: boolean;
}

export interface Flight {
	id: string;
	missionId: string;
	title: string;
	agent: AgentKind;
	agentRuntime: string;
	priority: Priority;
	phase: FlightPhase;
	createdAt: number;
	startedAt?: number;
	landedAt?: number;
	baseline: string;
	plan?: FlightPlan;
	planHistory: FlightPlan[];
	artifact?: ArtifactRef;
	sandboxId?: string;
	activity?: { text: string; at: number };
	lastHeartbeat?: number;
	stale?: StaleNotice;
	publishes: PublishRecord[];
	failureReason?: string;
	landedCommit?: string;
	/** Count of rejected publishes since the last accepted plan; repeated violations escalate. */
	violations: number;
}

export interface Lease {
	resource: string;
	flightId: string;
	grantedAt: number;
	expiresAt: number;
	heartbeatAt: number;
}

export type OverrideKind = "accept" | "allow-both" | "first" | "hold-both";

/** A human decision applied to one congestion (pair of flights). */
export interface Override {
	congestionKey: string;
	kind: OverrideKind;
	/** For `first`: the flight that receives right-of-way. */
	flightId?: string;
	at: number;
	by: string;
}

export interface ProjectInfo {
	id: string;
	name: string;
	repo: string;
	namespace: string;
	remote?: string;
	defaultBranch: string;
	mode: "demo" | "live";
	gitBackend: "artifacts" | "simulated";
}

export interface CanonicalState {
	head: string;
	history: { commit: string; flightId?: string; message: string; at: number }[];
}
