import type { AirspaceIndex } from "../core/airspace.ts";
import { parseResourceId } from "../core/airspace.ts";
import type { Flight, FlightPlan } from "../core/domain.ts";
import { planAccesses, type SemanticFinding } from "../core/traffic.ts";

/**
 * Bounded judgment for level-4 (semantic) congestion: two Flights on different symbols whose *objectives*
 * may contradict ("move validation into middleware" vs "centralize validation in AuthService").
 *
 * A judge answers narrow questions about a pair — overlap? severity? recommended control? — and returns
 * typed findings. It never decides clearance: findings only add explanation or escalate to a human.
 * Decision models such as TypeSafe's Jev (typed answers with probabilities) fit this interface directly.
 */
export interface DecisionJudge {
	readonly name: string;
	judge(pairs: JudgePair[]): Promise<SemanticFinding[]>;
}

export interface JudgePair {
	a: { id: string; objective: string; summary: string; modules: string[]; assumptions: string[] };
	b: { id: string; objective: string; summary: string; modules: string[]; assumptions: string[] };
	sharedModules: string[];
}

/** Pairs worth judging: active Flights that write in a shared module but have no structural overlap there. */
export function candidatePairs(flights: Flight[], index: AirspaceIndex): JudgePair[] {
	const active = flights.filter(
		(f): f is Flight & { plan: FlightPlan } => !!f.plan && !["landed", "failed", "lost", "cancelled"].includes(f.phase),
	);
	const modulesOf = (f: Flight & { plan: FlightPlan }) => {
		const out = new Set<string>();
		for (const a of planAccesses(f.plan, index)) {
			if (a.mode === "read") continue;
			const p = parseResourceId(a.resource);
			const mod = p.module ?? index.files.find((x) => x.path === p.file)?.module;
			if (mod) out.add(mod);
		}
		return [...out];
	};
	const pairs: JudgePair[] = [];
	for (let i = 0; i < active.length; i++) {
		for (let j = i + 1; j < active.length; j++) {
			const [x, y] = [active[i], active[j]];
			const mx = modulesOf(x);
			const my = modulesOf(y);
			const shared = mx.filter((m) => my.includes(m));
			if (!shared.length) continue;
			const view = (f: Flight & { plan: FlightPlan }, modules: string[]) => ({
				id: f.id,
				objective: f.plan.objective,
				summary: f.plan.summary,
				modules,
				assumptions: f.plan.assumptions,
			});
			pairs.push({ a: view(x, mx), b: view(y, my), sharedModules: shared });
		}
	}
	return pairs;
}

const REMOVE = /\b(remove|delete|drop|deprecate|eliminate|strip|get rid of)\b/i;
const ADD = /\b(add|introduce|keep|rely on|use|extend|expand)\b/i;
const MOVE = /\b(move|centrali[sz]e|consolidate|relocate|push)\b\s+([\w-]+(?:\s[\w-]+)?)\s+(?:into|to|in)\s+([\w.-]+)/i;

/**
 * Deterministic judge: catches the obvious contradictions (one Flight removes what the other extends;
 * both move the same concept to different places). Low confidence → advisory; clear opposite moves →
 * escalate to a controller.
 */
export class RuleBasedDecisionJudge implements DecisionJudge {
	readonly name = "rule-based judge";

	async judge(pairs: JudgePair[]): Promise<SemanticFinding[]> {
		const findings: SemanticFinding[] = [];
		for (const p of pairs) {
			const ma = MOVE.exec(p.a.objective);
			const mb = MOVE.exec(p.b.objective);
			if (ma && mb && sameConcept(ma[2], mb[2]) && ma[3].toLowerCase() !== mb[3].toLowerCase()) {
				findings.push({
					flights: [p.a.id, p.b.id],
					summary: `${p.a.id} moves ${ma[2]} into ${ma[3]} while ${p.b.id} moves it into ${mb[3]}`,
					confidence: 0.7,
					recommendation: "escalate",
					source: this.name,
				});
				continue;
			}
			const concept = contradictory(p.a.objective, p.b.objective) ?? contradictory(p.b.objective, p.a.objective);
			if (concept) {
				findings.push({
					flights: [p.a.id, p.b.id],
					summary: `one Flight removes "${concept}" that the other builds on (${p.sharedModules.join(", ")})`,
					confidence: 0.45,
					recommendation: "caution",
					source: this.name,
				});
			}
		}
		return findings;
	}
}

function words(s: string) {
	return new Set(s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []);
}

function sameConcept(x: string, y: string) {
	const a = words(x);
	return [...words(y)].some((w) => a.has(w));
}

function contradictory(remover: string, other: string): string | undefined {
	const m = REMOVE.exec(remover);
	if (!m || !ADD.test(other)) return undefined;
	const after = remover.slice(m.index + m[0].length, m.index + m[0].length + 60);
	const target = [...words(after)].find((w) => words(other).has(w) && !["the", "that", "with", "from", "into"].includes(w));
	return target;
}

/**
 * Optional narrow model judge (deep semantics only where needed). Asks a small model a typed question per
 * pair and accepts only a strict JSON answer. Disabled unless a key is configured.
 */
export class ModelDecisionJudge implements DecisionJudge {
	readonly name: string;

	constructor(
		private readonly apiKey: string,
		private readonly model = "claude-haiku-4-5-20251001",
	) {
		this.name = `model judge (${model})`;
	}

	async judge(pairs: JudgePair[]): Promise<SemanticFinding[]> {
		const out: SemanticFinding[] = [];
		for (const p of pairs.slice(0, 6)) {
			const res = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					max_tokens: 200,
					system:
						"You compare two planned code changes in the same repository and answer one narrow question. Reply with JSON only: " +
						'{"overlap": true|false, "severity": "low"|"medium"|"high", "recommendation": "caution"|"escalate", "summary": "<one sentence>"}. ' +
						"overlap means the two objectives contradict or would undo each other, not merely that they touch the same area.",
					messages: [
						{
							role: "user",
							content: `Shared modules: ${p.sharedModules.join(", ")}\n\nFlight ${p.a.id}: ${p.a.summary}\nObjective: ${p.a.objective}\nAssumes: ${p.a.assumptions.join("; ") || "—"}\n\nFlight ${p.b.id}: ${p.b.summary}\nObjective: ${p.b.objective}\nAssumes: ${p.b.assumptions.join("; ") || "—"}`,
						},
					],
				}),
			});
			if (!res.ok) continue;
			const body = (await res.json()) as { content?: { type: string; text?: string }[] };
			const text = body.content?.find((c) => c.type === "text")?.text ?? "";
			try {
				const answer = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
					overlap: boolean;
					severity: string;
					recommendation: "caution" | "escalate";
					summary: string;
				};
				if (!answer.overlap) continue;
				out.push({
					flights: [p.a.id, p.b.id],
					summary: String(answer.summary).slice(0, 240),
					confidence: answer.severity === "high" ? 0.8 : answer.severity === "medium" ? 0.6 : 0.4,
					recommendation: answer.recommendation === "escalate" && answer.severity === "high" ? "escalate" : "caution",
					source: this.name,
				});
			} catch {
				// not a typed answer: ignored, never trusted
			}
		}
		return out;
	}
}
