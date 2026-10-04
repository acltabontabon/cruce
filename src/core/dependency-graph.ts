/**
 * Directed "waits-for" graph between Flights. An edge `from → to` means `from` waits on `to`
 * (to must land, or release airspace, before from can complete the dependent work).
 *
 * Cycles are traffic deadlocks. They are found with Tarjan's strongly-connected-components
 * algorithm — never by asking a model.
 */

export interface Edge {
	from: string;
	to: string;
	reason: string;
}

export class DependencyGraph {
	private readonly adj = new Map<string, Map<string, Edge>>();

	constructor(nodes: Iterable<string> = [], edges: Iterable<Edge> = []) {
		for (const n of nodes) this.addNode(n);
		for (const e of edges) this.addEdge(e);
	}

	addNode(id: string) {
		if (!this.adj.has(id)) this.adj.set(id, new Map());
	}

	addEdge(edge: Edge) {
		if (edge.from === edge.to) return;
		this.addNode(edge.from);
		this.addNode(edge.to);
		const existing = this.adj.get(edge.from)?.get(edge.to);
		if (!existing) this.adj.get(edge.from)?.set(edge.to, edge);
	}

	removeEdge(from: string, to: string) {
		this.adj.get(from)?.delete(to);
	}

	nodes(): string[] {
		return [...this.adj.keys()].sort();
	}

	edges(): Edge[] {
		return [...this.adj.values()].flatMap((m) => [...m.values()]);
	}

	waitsOn(id: string): string[] {
		return [...(this.adj.get(id)?.keys() ?? [])].sort();
	}

	/** Strongly connected components with more than one node (or a self-loop) — i.e. deadlocks. */
	cycles(): string[][] {
		let index = 0;
		const indices = new Map<string, number>();
		const low = new Map<string, number>();
		const onStack = new Set<string>();
		const stack: string[] = [];
		const result: string[][] = [];

		const strongConnect = (v: string) => {
			indices.set(v, index);
			low.set(v, index);
			index++;
			stack.push(v);
			onStack.add(v);
			for (const w of [...(this.adj.get(v)?.keys() ?? [])].sort()) {
				if (!indices.has(w)) {
					strongConnect(w);
					low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
				} else if (onStack.has(w)) {
					low.set(v, Math.min(low.get(v) ?? 0, indices.get(w) ?? 0));
				}
			}
			if (low.get(v) === indices.get(v)) {
				const component: string[] = [];
				let w: string | undefined;
				do {
					w = stack.pop();
					if (w === undefined) break;
					onStack.delete(w);
					component.push(w);
				} while (w !== v);
				if (component.length > 1) result.push(component.sort());
			}
		};

		for (const v of this.nodes()) if (!indices.has(v)) strongConnect(v);
		return result;
	}

	/**
	 * Landing order: Kahn's algorithm over the reversed edges (a Flight lands after what it waits on).
	 * Ties break alphabetically for determinism. Returns null when the graph has a cycle.
	 */
	topologicalOrder(): string[] | null {
		const indegree = new Map<string, number>();
		for (const n of this.nodes()) indegree.set(n, this.waitsOn(n).length);
		const ready = this.nodes().filter((n) => indegree.get(n) === 0);
		const order: string[] = [];
		const dependents = new Map<string, string[]>();
		for (const e of this.edges()) dependents.set(e.to, [...(dependents.get(e.to) ?? []), e.from]);

		while (ready.length) {
			ready.sort();
			const n = ready.shift() as string;
			order.push(n);
			for (const d of dependents.get(n) ?? []) {
				const deg = (indegree.get(d) ?? 0) - 1;
				indegree.set(d, deg);
				if (deg === 0) ready.push(d);
			}
		}
		return order.length === this.nodes().length ? order : null;
	}
}
