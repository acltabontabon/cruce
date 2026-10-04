/**
 * Compatibility for persisted plans and coordination records. This does not rewrite Git objects,
 * evidence contents, revisions or local working changes. New commands use only the current schema.
 */
export function migratePlanRecords<T>(stored: T): T {
	const names: Record<string, string> = {
		intent_mcp: "coordination_mcp",
		register_intent: "register_workstream",
		update_intent: "update_plan",
	};
	function visit(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(visit);
		if (!value || typeof value !== "object") return value;
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(record)) {
			if (key === "intentId" || key === "intents") continue;
			const name = key === "intent" ? "objective" : key;
			if (key === "intent" && "objective" in record) continue;
			result[name] =
				(key === "tool" || key === "command" || key === "capability") && typeof entry === "string"
					? (names[entry] ?? (entry === "intent" ? "objective" : entry))
					: key === "capabilities" && Array.isArray(entry)
						? entry.map((c) => (typeof c === "string" ? (names[c] ?? c) : c))
						: visit(entry);
		}
		return result;
	}
	return visit(stored) as T;
}
