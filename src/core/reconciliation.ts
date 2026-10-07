import type { GitRelation, ObservationStatus, ReconciliationView, ReportFreshness } from "../shared/platform.ts";
import type { RepositoryController } from "./platform.ts";

export const REPORT_FRESH_MS = 90_000;
export function reportFreshness(reportedAt: number | undefined, now: number): ReportFreshness {
	if (reportedAt === undefined) return { state: "unknown" };
	const ageMs = Math.max(0, now - reportedAt);
	return { state: ageMs < REPORT_FRESH_MS ? "fresh" : "stale", reportedAt, ageMs };
}

/** Pure projection; ancestry facts are supplied by the cache-only runtime. */
export function reconciliation(
	c: RepositoryController,
	observation: ObservationStatus,
	relations: ReadonlyMap<string, GitRelation> = new Map(),
	ancestry: ReadonlyMap<string, boolean> = new Map(),
): ReconciliationView {
	const canonicalRevision = observation.canonical?.deleted ? undefined : (observation.canonical?.revision ?? c.state.sourceHead);
	return {
		asOf: c.now,
		acceptedRevision: c.state.sourceHead,
		canonicalRevision,
		observation,
		workspaces: c.state.workspaces
			.filter((w) => !["completed", "cancelled"].includes(w.state))
			.map((w) => {
				const incorporation: ReconciliationView["workspaces"][number]["incorporation"] = c.state.promotions
					.filter((p) => p.state === "complete")
					.map((p) => {
						const present = w.publishedRevision ? ancestry.get(`${p.to}:${w.publishedRevision}`) : undefined;
						return { revision: p.to, promotionId: p.id, state: present === undefined ? "unknown" : present ? "present" : "missing" };
					});
				const counts = { present: 0, missing: 0, unknown: 0 };
				for (const row of incorporation) counts[row.state]++;
				return {
					workspaceId: w.id,
					revision: w.publishedRevision ?? w.baseRevision,
					basis: w.publishedRevision ? "published" : "baseline",
					canonicalRevision,
					relation: relations.get(w.id) ?? "unknown",
					report: reportFreshness(w.lastReportAt, c.now),
					incorporation: incorporation
						.sort((a, b) => ({ missing: 0, unknown: 1, present: 2 })[a.state] - { missing: 0, unknown: 1, present: 2 }[b.state])
						.slice(0, 16),
					incorporationCounts: counts,
					incorporationTruncated: incorporation.length > 16,
				};
			}),
		proposals: c.state.proposals
			.filter((p) => p.state === "open" || p.state === "promoting")
			.map((p) => ({
				proposalId: p.id,
				stale: !!canonicalRevision && p.base !== canonicalRevision,
				readiness: c.readiness(p),
			})),
	};
}
