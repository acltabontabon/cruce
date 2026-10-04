/**
 * Agent authority and resource consumption. Pure and deterministic: no I/O, time is injected.
 *
 * Cruce separates two kinds of machine actions:
 * - control actions read or record Cruce domain state (intent, mission, policy, lineage). They are cheap.
 * - resource actions consume infrastructure in the project's Cloudflare account (Artifacts writes,
 *   Workers Builds, previews, cloud AI, production deployment). They are governed by explicit scopes,
 *   per-project resource policy and bounded budgets, so agents cannot become a denial-of-wallet machine.
 *
 * Cost is a classification, never a price estimate.
 */

/** Scopes an agent connection may hold. Humans act through membership roles, not scopes. */
export const SCOPES = ["cruce:read", "workspace:write", "proposal:write", "preview:request", "promotion:request"] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_LABELS: Record<Scope, string> = {
	"cruce:read": "Read intent, missions, policy, source and lineage",
	"workspace:write": "Start missions in isolated workspaces and publish revisions and artifacts",
	"proposal:write": "Create proposals, attach evidence and request verification",
	"preview:request": "Request Worker previews (metered Cloudflare operations, subject to policy)",
	"promotion:request": "Ask humans to promote a proposal (never promotes by itself)",
};
/** Default grant for a local coding agent; humans can narrow it at consent. */
export const DEFAULT_AGENT_SCOPES: Scope[] = ["cruce:read", "workspace:write", "proposal:write", "preview:request", "promotion:request"];

export type CostClass = "none" | "local" | "artifacts" | "metered" | "metered_production";
export const COST_LABELS: Record<CostClass, string> = {
	none: "No cloud resources",
	local: "Local execution; no cloud compute",
	artifacts: "Cloudflare Artifacts storage and operations",
	metered: "Metered Cloudflare operation",
	metered_production: "Metered Cloudflare operation with production impact",
};

/** Resource-consuming operations Cruce performs in the connected Cloudflare account. */
export const RESOURCE_ACTIONS = [
	"workspace.create",
	"revision.publish",
	"artifact.publish",
	"preview.deploy",
	"production.deploy",
	"ai.inference",
] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];
export const RESOURCE_COST: Record<ResourceAction, CostClass> = {
	"workspace.create": "artifacts",
	"revision.publish": "artifacts",
	"artifact.publish": "artifacts",
	"preview.deploy": "metered",
	"production.deploy": "metered_production",
	"ai.inference": "metered",
};
export const RESOURCE_LABELS: Record<ResourceAction, string> = {
	"workspace.create": "Create an isolated workspace repository",
	"revision.publish": "Publish a revision to a workspace repository",
	"artifact.publish": "Store an evidence artifact",
	"preview.deploy": "Build and deploy a Worker preview",
	"production.deploy": "Deploy to production",
	"ai.inference": "Cloud AI analysis",
};

export type ResourceRule = "allow" | "approval" | "deny";
export interface ResourcePolicy {
	rules: Record<ResourceAction, ResourceRule>;
	/** Count budgets. Exceeding one turns an allowed action into a human approval, never a silent spend. */
	budgets: { previewsPerMission: number; previewsPerDay: number; workspacesPerDay: number };
}
export const DEFAULT_RESOURCE_POLICY: ResourcePolicy = {
	rules: {
		"workspace.create": "allow",
		"revision.publish": "allow",
		"artifact.publish": "allow",
		"preview.deploy": "allow",
		"production.deploy": "approval",
		"ai.inference": "approval",
	},
	budgets: { previewsPerMission: 5, previewsPerDay: 20, workspacesPerDay: 25 },
};

export interface ResourceSubject {
	action: ResourceAction;
	missionId?: string;
	actorKind: "human" | "agent" | "runtime";
}
export interface ResourceEvaluation {
	outcome: "allow" | "approval" | "deny";
	cost: CostClass;
	reason: string;
}
export type Usage = Record<string, number>;

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
/** Usage counter keys charged when an action actually executes. */
export function usageKeys(subject: ResourceSubject, now: number): string[] {
	const keys = [`${subject.action}:day:${day(now)}`];
	if (subject.missionId) keys.push(`${subject.action}:mission:${subject.missionId}`);
	return keys;
}
export function recordUsage(usage: Usage, subject: ResourceSubject, now: number): Usage {
	const next = { ...usage };
	for (const key of usageKeys(subject, now)) next[key] = (next[key] ?? 0) + 1;
	return next;
}

/**
 * Decide whether an action may consume resources now. Production deployment always needs a human:
 * a human action is the approval; an agent can only request it. Human-initiated actions are not
 * blocked by budgets because the human is the approver.
 */
export function evaluateResource(policy: ResourcePolicy, usage: Usage, subject: ResourceSubject, now: number): ResourceEvaluation {
	const cost = RESOURCE_COST[subject.action];
	const rule = policy.rules[subject.action];
	if (rule === "deny") return { outcome: "deny", cost, reason: `Project policy denies: ${RESOURCE_LABELS[subject.action]}` };
	if (subject.action === "production.deploy" && subject.actorKind !== "human")
		return { outcome: "approval", cost, reason: "Production deployment requires human approval" };
	if (subject.actorKind === "human") return { outcome: "allow", cost, reason: "Human decision" };
	if (rule === "approval")
		return { outcome: "approval", cost, reason: `Project policy requires human approval: ${RESOURCE_LABELS[subject.action]}` };
	const count = (key: string) => usage[key] ?? 0;
	const { budgets } = policy;
	if (subject.action === "preview.deploy") {
		if (subject.missionId && count(`preview.deploy:mission:${subject.missionId}`) >= budgets.previewsPerMission)
			return {
				outcome: "approval",
				cost,
				reason: `Mission preview budget (${budgets.previewsPerMission}) reached; human approval required`,
			};
		if (count(`preview.deploy:day:${day(now)}`) >= budgets.previewsPerDay)
			return { outcome: "approval", cost, reason: `Daily preview budget (${budgets.previewsPerDay}) reached; human approval required` };
	}
	if (subject.action === "workspace.create" && count(`workspace.create:day:${day(now)}`) >= budgets.workspacesPerDay)
		return { outcome: "approval", cost, reason: `Daily workspace budget (${budgets.workspacesPerDay}) reached; human approval required` };
	return { outcome: "allow", cost, reason: "Allowed by project resource policy" };
}

/** Validate a maintainer's policy change: production can never be delegated to agents. */
export function normalizeResourcePolicy(input: ResourcePolicy): ResourcePolicy {
	const rules = { ...DEFAULT_RESOURCE_POLICY.rules, ...input.rules };
	if (rules["production.deploy"] === "allow") rules["production.deploy"] = "approval";
	const budgets = { ...DEFAULT_RESOURCE_POLICY.budgets, ...input.budgets };
	for (const [key, value] of Object.entries(budgets))
		if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error(`Budget ${key} must be an integer from 0 to 1000`);
	return { rules, budgets };
}

export function missingScope(granted: readonly Scope[] | undefined, required: Scope): string | undefined {
	if (!granted) return undefined;
	return granted.includes(required) ? undefined : `Connection lacks the ${required} scope: ${SCOPE_LABELS[required]}`;
}
