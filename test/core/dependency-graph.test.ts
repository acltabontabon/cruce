import { describe, expect, it } from "vitest";
import { DependencyGraph } from "../../src/core/dependency-graph.ts";

describe("dependency graph", () => {
	it("orders landings topologically (dependencies first)", () => {
		const g = new DependencyGraph(
			["A", "B", "C"],
			[
				{ from: "A", to: "B", reason: "" },
				{ from: "B", to: "C", reason: "" },
			],
		);
		expect(g.topologicalOrder()).toEqual(["C", "B", "A"]);
		expect(g.cycles()).toEqual([]);
	});

	it("breaks ties deterministically", () => {
		const g = new DependencyGraph(["Z", "Y", "X"]);
		expect(g.topologicalOrder()).toEqual(["X", "Y", "Z"]);
	});

	it("detects a three-way traffic deadlock", () => {
		const g = new DependencyGraph(
			["A", "B", "C", "D"],
			[
				{ from: "A", to: "B", reason: "" },
				{ from: "B", to: "C", reason: "" },
				{ from: "C", to: "A", reason: "" },
				{ from: "D", to: "A", reason: "" },
			],
		);
		expect(g.cycles()).toEqual([["A", "B", "C"]]);
		expect(g.topologicalOrder()).toBeNull();
	});

	it("updates when edges are removed", () => {
		const g = new DependencyGraph(
			["A", "B"],
			[
				{ from: "A", to: "B", reason: "" },
				{ from: "B", to: "A", reason: "" },
			],
		);
		expect(g.cycles()).toHaveLength(1);
		g.removeEdge("B", "A");
		expect(g.cycles()).toEqual([]);
		expect(g.waitsOn("A")).toEqual(["B"]);
	});

	it("ignores self-loops", () => {
		const g = new DependencyGraph(["A"], [{ from: "A", to: "A", reason: "" }]);
		expect(g.cycles()).toEqual([]);
	});
});
