import type { Deployment, DeploymentProfile, Environment, PlatformState, Proposal } from "../shared/platform.ts";

/**
 * Deployment knowledge that does not need I/O: what kind of application a revision is, which
 * revision runs where, and what a rollback would remove. Pure and deterministic.
 */

const WORKER_CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml", "cloudflare.config.ts"] as const;

/** Cloudflare Workers get the golden path; anything else keeps every lifecycle feature except Worker deployment. */
export function detectDeploymentProfile(files: Record<string, string>, revision: string): DeploymentProfile {
	const configPath = WORKER_CONFIGS.find((name) => name in files);
	if (!configPath) return { kind: "unknown", revision };
	return { kind: "cloudflare_worker", configPath, workerName: workerName(configPath, files[configPath]), revision };
}

function workerName(path: string, text: string): string | undefined {
	const match = path.endsWith(".toml")
		? /^\s*name\s*=\s*"([^"]+)"/m.exec(text)
		: path.endsWith(".ts")
			? /\bname\s*:\s*["']([^"']+)["']/.exec(text)
			: /"name"\s*:\s*"([^"]+)"/.exec(text);
	return match?.[1];
}

/** Preview branches are per proposal so Workers Builds keeps one preview URL per proposal. */
export const previewBranch = (proposal: Pick<Proposal, "number">) => `cruce/proposal-${proposal.number}`;

export function liveDeployment(state: Pick<PlatformState, "deployments">, environmentId: string): Deployment | undefined {
	return state.deployments
		.filter((d) => d.environmentId === environmentId && d.state === "deployed")
		.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0];
}

export function environmentOf(state: Pick<PlatformState, "environments">, kind: Environment["kind"]): Environment | undefined {
	return state.environments.find((e) => e.kind === kind);
}

/**
 * Explain a rollback in product terms: which promoted proposals (and their missions/intents) the
 * target revision does not contain. `ancestry` lists accepted revisions newest first.
 */
export function explainRollback(
	state: Pick<PlatformState, "proposals" | "promotions" | "missions" | "intents" | "verifications">,
	current: string,
	target: string,
	ancestry: string[],
): { removes: { proposalId: string; number: number; summary: string; mission: string; intent: string }[]; targetVerified: boolean } {
	const currentAt = ancestry.indexOf(current),
		targetAt = ancestry.indexOf(target);
	if (targetAt < 0 || currentAt < 0 || targetAt < currentAt) throw new Error("Rollback target must be an earlier accepted revision");
	const between = new Set(ancestry.slice(currentAt, targetAt));
	const removes = state.promotions
		.filter((t) => t.state === "complete" && between.has(t.to))
		.map((t) => {
			const p = state.proposals.find((p) => p.id === t.proposalId)!,
				m = state.missions.find((m) => m.id === p.missionId),
				i = state.intents.find((i) => i.id === m?.intentId);
			return { proposalId: p.id, number: p.number, summary: p.summary, mission: m?.title ?? "", intent: i?.title ?? "" };
		});
	const targetVerified = state.verifications.some((v) => v.revision === target && v.outcome === "pass" && v.trust !== "reported");
	return { removes, targetVerified };
}
