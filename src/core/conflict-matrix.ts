import { type AirspaceIndex, type Overlap, overlap } from "./airspace.ts";

/**
 * The conflict matrix: a deterministic classification of two accesses to overlapping airspace.
 * This is the first and cheapest layer of the controller's decision order; no model is consulted
 * for anything this table can answer.
 */

export type AccessMode = "read" | "write" | "contract";

export interface Access {
	resource: string;
	mode: AccessMode;
	/** `declared` came from the Flight Plan; `derived` was inferred from the import graph. */
	origin: "declared" | "derived";
	/** The plan entry that produced this access (for explanations). */
	requested: string;
}

/**
 * Congestion levels (see docs/controller-model.md):
 * 1 direct structural · 2 dependency · 3 contract · 4 semantic · 5 actual Git conflict
 */
export type CongestionLevel = 1 | 2 | 3 | 4 | 5;
export type Severity = "low" | "medium" | "high" | "critical";
export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * What the controller must do about an interaction.
 * - `none`: safe, independent
 * - `caution`: proceed; noted on the radar
 * - `land-after`: both may work now, but one side must land after (and re-validate against) the other
 * - `exclusive`: only one Flight may hold write clearance on the contested airspace at a time
 */
export type Control = "none" | "caution" | "land-after" | "exclusive";

export interface MatrixCell {
	level: CongestionLevel | 0;
	severity: Severity;
	control: Control;
	rule: string;
}

const NONE: MatrixCell = { level: 0, severity: "low", control: "none", rule: "independent" };

export function classify(a: AccessMode, b: AccessMode, ov: Overlap, derived = false): MatrixCell {
	if (ov === "none") return NONE;

	const pair = [a, b].sort().join("×") as
		| "contract×contract"
		| "contract×read"
		| "contract×write"
		| "read×read"
		| "read×write"
		| "write×write";

	if (ov === "same-file") {
		// Distinct symbols in one file: separate airspace. Two writers share textual proximity only.
		if (pair === "write×write" || pair === "contract×write" || pair === "contract×contract") {
			return { level: 1, severity: "low", control: "caution", rule: "distinct symbols in the same file" };
		}
		return NONE;
	}

	switch (pair) {
		case "read×read":
			return { level: 0, severity: "low", control: "none", rule: "read × read is always safe" };
		case "read×write":
			return derived ? NONE : { level: 2, severity: "low", control: "caution", rule: "implementation under a declared read may change" };
		case "contract×read":
			return derived
				? { level: 2, severity: "medium", control: "land-after", rule: "contract change reaches an importing module" }
				: { level: 3, severity: "high", control: "land-after", rule: "contract change under a declared dependency" };
		case "write×write":
			return { level: 1, severity: "high", control: "exclusive", rule: "two writers on the same airspace" };
		case "contract×write":
			return { level: 1, severity: "critical", control: "exclusive", rule: "write against airspace whose contract is changing" };
		case "contract×contract":
			return { level: 1, severity: "critical", control: "exclusive", rule: "two contract changes on the same airspace" };
	}
}

export interface Interaction {
	a: Access;
	b: Access;
	overlap: Overlap;
	cell: MatrixCell;
}

/** Every non-trivial interaction between two access sets. */
export function interactions(aSet: Access[], bSet: Access[], index: AirspaceIndex): Interaction[] {
	const out: Interaction[] = [];
	for (const a of aSet) {
		for (const b of bSet) {
			if (a.origin === "derived" && b.origin === "derived") continue;
			const ov = overlap(a.resource, b.resource, index);
			if (ov === "none") continue;
			const cell = classify(a.mode, b.mode, ov, a.origin === "derived" || b.origin === "derived");
			if (cell.control === "none") continue;
			out.push({ a, b, overlap: ov, cell });
		}
	}
	return out;
}
