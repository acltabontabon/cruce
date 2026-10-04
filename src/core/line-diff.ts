import { diffLines } from "diff";

/**
 * Changed line ranges of `next` relative to `base`, in BASE coordinates (1-based, inclusive).
 * Removed or replaced lines map to themselves; a pure insertion maps to the base line it is inserted
 * before, so inserting between two members lands on the enclosing type, and inserting directly above
 * a member (e.g. its doc comment) lands on that member.
 */
export function changedRanges(base: string, next: string): { start: number; end: number; insert?: boolean }[] {
	const total = Math.max(1, base.split("\n").length);
	const ranges: { start: number; end: number; insert?: boolean }[] = [];
	let line = 1;
	let previousRemoved = false;
	for (const part of diffLines(base, next)) {
		const count = part.count ?? part.value.split("\n").length - (part.value.endsWith("\n") ? 1 : 0);
		if (part.removed) {
			ranges.push({ start: line, end: line + count - 1 });
			line += count;
		} else if (part.added) {
			// A replacement (removed then added) is already covered by the removed range.
			if (!previousRemoved) {
				const at = Math.min(line, total);
				ranges.push({ start: at, end: at, insert: true });
			}
		} else {
			line += count;
		}
		previousRemoved = !!part.removed;
	}
	ranges.sort((a, b) => a.start - b.start);
	const merged: { start: number; end: number; insert?: boolean }[] = [];
	for (const r of ranges) {
		const last = merged.at(-1);
		if (last && r.start <= last.end + 1 && !last.insert && !r.insert) last.end = Math.max(last.end, r.end);
		else merged.push({ ...r });
	}
	return merged;
}
