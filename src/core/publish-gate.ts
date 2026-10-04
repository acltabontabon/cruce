import {
	type AirspaceIndex,
	fileId,
	isAncestorOrEqual,
	moduleId,
	moduleOfPath,
	parseResourceId,
	resourceLabel,
	symbolsAt,
} from "./airspace.ts";

/**
 * The publish gate (enforcement layer B).
 *
 * Artifacts tokens are repository-scoped; they cannot express "may edit AuthService but not
 * TokenValidator". So a Flight never holds a standing write credential. Before every push Cruce
 * maps the actual diff onto airspace and only then mints a short-lived write token.
 */

export interface ChangedFile {
	path: string;
	status: "added" | "modified" | "deleted";
	/** Changed line ranges in the BASE version of the file (1-based, inclusive). */
	ranges: { start: number; end: number }[];
}

export interface GateViolation {
	path: string;
	resource: string;
	reason: string;
}

export interface GateResult {
	approved: boolean;
	touched: string[];
	outside: GateViolation[];
	summary: string;
}

export interface GatePolicy {
	/** New test files are allowed when the Flight holds clearance somewhere (tests for its own work). */
	allowNewTests: boolean;
}

const DEFAULT_POLICY: GatePolicy = { allowNewTests: true };

const isTestPath = (p: string) => /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

export function evaluatePublish(
	cleared: string[],
	changes: ChangedFile[],
	index: AirspaceIndex,
	policy: GatePolicy = DEFAULT_POLICY,
): GateResult {
	const covered = (r: string) => cleared.some((c) => isAncestorOrEqual(c, r, index));
	const clearedFiles = new Set(cleared.map((c) => parseResourceId(c).file).filter(Boolean));
	const touched = new Set<string>();
	const outside: GateViolation[] = [];

	for (const change of changes) {
		const fid = fileId(change.path);
		if (change.status === "added") {
			touched.add(fid);
			if (covered(fid)) continue;
			if (policy.allowNewTests && isTestPath(change.path) && cleared.length) continue;
			outside.push({
				path: change.path,
				resource: fid,
				reason: `new file in ${resourceLabel(moduleId(moduleOfPath(change.path, index)), index)} is outside clearance`,
			});
			continue;
		}
		if (change.status === "deleted") {
			touched.add(fid);
			if (!covered(fid)) outside.push({ path: change.path, resource: fid, reason: "deleting a file requires file-level clearance" });
			continue;
		}
		if (
			isTestPath(change.path) &&
			policy.allowNewTests &&
			cleared.length &&
			!index.files.some((f) => f.path === change.path && f.symbols.length)
		) {
			touched.add(fid);
			continue;
		}
		for (const range of change.ranges) {
			const symbols = symbolsAt(change.path, range.start, range.end, index);
			if (!symbols.length) {
				// Lines outside any symbol (imports, file header): allowed alongside cleared work in the file.
				touched.add(fid);
				if (!covered(fid) && !clearedFiles.has(change.path)) {
					outside.push({ path: change.path, resource: fid, reason: `lines ${range.start}–${range.end} are outside cleared airspace` });
				}
				continue;
			}
			for (const s of symbols) {
				touched.add(s);
				if (!covered(s)) outside.push({ path: change.path, resource: s, reason: `${resourceLabel(s, index)} is not in the cleared route` });
			}
		}
	}

	const uniqueOutside = [...new Map(outside.map((o) => [o.resource, o])).values()];
	const touchedList = [...touched].sort();
	return {
		approved: uniqueOutside.length === 0,
		touched: touchedList,
		outside: uniqueOutside,
		summary: uniqueOutside.length
			? `Rejected: ${uniqueOutside.map((o) => resourceLabel(o.resource, index)).join(", ")} outside clearance — file a plan amendment`
			: `Approved: ${touchedList.length} resource${touchedList.length === 1 ? "" : "s"} inside clearance`,
	};
}
