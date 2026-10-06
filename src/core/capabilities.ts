import type { Authority, CostClass, ResourcePolicy } from "../shared/platform.ts";
import { DomainError } from "./errors.ts";

export type { CostClass, ResourceAction, ResourcePolicy, ResourceRule } from "../shared/platform.ts";
export const SCOPES = [
	"cruce:read",
	"workspace:write",
	"revision:publish",
	"artifact:publish",
	"change:write",
	"promotion:request",
] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_LABELS: Record<Scope, string> = {
	"cruce:read": "Read authorized repositories and lineage",
	"workspace:write": "Start workspaces and report work",
	"revision:publish": "Publish exact Git revisions",
	"artifact:publish": "Store revision evidence",
	"change:write": "Propose and review changes",
	"promotion:request": "Request human source promotion",
};
export const DEFAULT_AGENT_SCOPES: Scope[] = [...SCOPES];
export const COST_LABELS: Record<CostClass, string> = {
	none: "No cloud resources",
	artifacts: "Cloudflare Artifacts operations",
};
export const DEFAULT_RESOURCE_POLICY: ResourcePolicy = {
	rules: {
		"repository.create": "allow",
		"workspace.fork": "allow",
		"workspace.cleanup": "allow",
		"revision.publish": "allow",
		"artifact.publish": "allow",
		"source.read": "allow",
	},
	dailyLimit: 100,
};
export function writeAccess(a: Authority) {
	if (a.repositoryRole !== "write" && a.repositoryRole !== "maintain") throw new DomainError(403, "Repository write permission required");
}
export function humanMaintain(a: Authority) {
	if (a.actor.kind !== "human" || a.repositoryRole !== "maintain") throw new DomainError(403, "Human repository maintainer required");
}
export function namespaceMaintain(a: Authority) {
	if (a.actor.kind !== "human" || !["owner", "maintainer"].includes(a.role))
		throw new DomainError(403, "Human namespace maintainer required");
}
