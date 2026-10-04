import { describe, expect, it } from "vitest";
import { type Contender, decideRightOfWay } from "../../src/core/right-of-way.ts";

const base = (id: string, patch: Partial<Contender> = {}): Contender => ({
	id,
	priority: "normal",
	filedAt: 0,
	changesContract: false,
	dependsOn: [],
	hasPublishedWork: false,
	independentWork: 1,
	...patch,
});

describe("right-of-way", () => {
	it("a human override wins outright", () => {
		const r = decideRightOfWay(base("A", { priority: "critical" }), base("B"), "B");
		expect(r).toMatchObject({ winner: "B", rule: "human-override" });
	});

	it("security patch (critical) beats a refactor (normal)", () => {
		const r = decideRightOfWay(base("REFACTOR"), base("SECURITY", { priority: "critical" }));
		expect(r).toMatchObject({ winner: "SECURITY", loser: "REFACTOR", rule: "priority" });
	});

	it("published work is not discarded", () => {
		const r = decideRightOfWay(base("A", { changesContract: true }), base("B", { hasPublishedWork: true }));
		expect(r).toMatchObject({ winner: "B", rule: "published-work" });
	});

	it("the contract owner goes first", () => {
		const r = decideRightOfWay(base("F-021", { filedAt: 1 }), base("F-022", { changesContract: true, filedAt: 2 }));
		expect(r).toMatchObject({ winner: "F-022", loser: "F-021", rule: "contract-owner" });
		expect(r.because.join(" ")).toContain("rework");
	});

	it("declared dependencies order the pair", () => {
		const r = decideRightOfWay(base("A", { dependsOn: ["B"] }), base("B"));
		expect(r).toMatchObject({ winner: "B", rule: "declared-dependency" });
	});

	it("the Flight that can keep busy yields", () => {
		const r = decideRightOfWay(base("A", { independentWork: 3 }), base("B", { independentWork: 0 }));
		expect(r).toMatchObject({ winner: "B", loser: "A", rule: "partial-capacity" });
	});

	it("falls back to filing order, then id", () => {
		expect(decideRightOfWay(base("A", { filedAt: 5 }), base("B", { filedAt: 3 })).winner).toBe("B");
		expect(decideRightOfWay(base("B"), base("A")).rule).toBe("flight-id");
	});
});
