import { PRIORITY_RANK, type Priority } from "./domain.ts";

/**
 * Right-of-way between two Flights contending for the same airspace.
 *
 * Rules are evaluated in a fixed order; the first rule that distinguishes the two Flights decides.
 * Every rule produces a sentence for the explanation, so a decision is never "the model said so".
 */

export interface Contender {
	id: string;
	priority: Priority;
	filedAt: number;
	/** Resources in the contested set whose contract this Flight changes. */
	changesContract: boolean;
	/** Declared plan dependencies (flight ids). */
	dependsOn: string[];
	/** Accepted publishes that already touched the contested airspace. */
	hasPublishedWork: boolean;
	/** Write resources this Flight could still work on if it lost the contested ones. */
	independentWork: number;
}

export type RuleName =
	| "human-override"
	| "priority"
	| "published-work"
	| "contract-owner"
	| "declared-dependency"
	| "partial-capacity"
	| "filed-first"
	| "flight-id";

export interface RightOfWay {
	winner: string;
	loser: string;
	rule: RuleName;
	because: string[];
}

export function decideRightOfWay(a: Contender, b: Contender, pinnedWinner?: string): RightOfWay {
	const decide = (winner: Contender, loser: Contender, rule: RuleName, because: string[]): RightOfWay => ({
		winner: winner.id,
		loser: loser.id,
		rule,
		because,
	});

	if (pinnedWinner === a.id || pinnedWinner === b.id) {
		const [w, l] = pinnedWinner === a.id ? [a, b] : [b, a];
		return decide(w, l, "human-override", [`a controller gave ${w.id} right-of-way`]);
	}

	if (a.priority !== b.priority) {
		const [w, l] = PRIORITY_RANK[a.priority] > PRIORITY_RANK[b.priority] ? [a, b] : [b, a];
		return decide(w, l, "priority", [`${w.id} is ${w.priority} priority; ${l.id} is ${l.priority}`]);
	}

	if (a.hasPublishedWork !== b.hasPublishedWork) {
		const [w, l] = a.hasPublishedWork ? [a, b] : [b, a];
		return decide(w, l, "published-work", [
			`${w.id} has already published work in this airspace`,
			`reassigning it would discard completed work`,
		]);
	}

	if (a.changesContract !== b.changesContract) {
		const [w, l] = a.changesContract ? [a, b] : [b, a];
		return decide(w, l, "contract-owner", [
			`${w.id} changes the contract here`,
			`${l.id} builds on that contract, so going first would mean rework`,
		]);
	}

	const aOnB = a.dependsOn.includes(b.id);
	const bOnA = b.dependsOn.includes(a.id);
	if (aOnB !== bOnA) {
		const [w, l] = aOnB ? [b, a] : [a, b];
		return decide(w, l, "declared-dependency", [`${l.id} declared a dependency on ${w.id}`]);
	}

	if (a.independentWork > 0 !== b.independentWork > 0) {
		const [w, l] = a.independentWork === 0 ? [a, b] : [b, a];
		return decide(w, l, "partial-capacity", [
			`${w.id} has no other work it could do while waiting`,
			`${l.id} can keep working on ${l.independentWork} uncontested resource${l.independentWork === 1 ? "" : "s"}`,
		]);
	}

	if (a.filedAt !== b.filedAt) {
		const [w, l] = a.filedAt < b.filedAt ? [a, b] : [b, a];
		return decide(w, l, "filed-first", [`${w.id} filed its plan first`]);
	}

	const [w, l] = a.id < b.id ? [a, b] : [b, a];
	return decide(w, l, "flight-id", [`tie broken by flight id`]);
}
