import type { ChangeFile } from "../shared/api.ts";
import type { ReviewNote } from "../shared/platform.ts";

/** One displayed line: context, addition or deletion, with its line numbers on each side it exists on. */
export interface Row {
	k: "c" | "a" | "d";
	t: string;
	o?: number;
	n?: number;
	/** Character ranges that changed against the paired line on the other side. */
	words?: [number, number][];
}
export interface Hunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	rows: Row[];
}

/** Parses a unified diff into hunks; file headers and "no newline" markers carry nothing a reviewer reads. */
export function parsePatch(patch: string): Hunk[] {
	const hunks: Hunk[] = [];
	let hunk: Hunk | undefined,
		o = 0,
		n = 0;
	for (const line of patch.split("\n")) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header) {
			hunk = {
				oldStart: +header[1],
				oldCount: header[2] === undefined ? 1 : +header[2],
				newStart: +header[3],
				newCount: header[4] === undefined ? 1 : +header[4],
				rows: [],
			};
			hunks.push(hunk);
			o = hunk.oldStart;
			n = hunk.newStart;
			continue;
		}
		if (!hunk || line.startsWith("\\")) continue;
		const k = line[0];
		if (k === " ") hunk.rows.push({ k: "c", t: line.slice(1), o: o++, n: n++ });
		else if (k === "-") hunk.rows.push({ k: "d", t: line.slice(1), o: o++ });
		else if (k === "+") hunk.rows.push({ k: "a", t: line.slice(1), n: n++ });
	}
	return hunks;
}

function lcs<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): [number, number][] {
	const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--) dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const pairs: [number, number][] = [];
	for (let i = 0, j = 0; i < a.length && j < b.length; )
		if (same(a[i], b[j])) pairs.push([i++, j++]);
		else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
		else j++;
	return pairs;
}

/** Character ranges that differ between two paired lines, or none when the lines share too little to compare usefully. */
export function wordChanges(before: string, after: string): [[number, number][], [number, number][]] | undefined {
	const tokens = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
	const a = tokens(before),
		b = tokens(after);
	if (!a.length || !b.length || a.length * b.length > 40_000) return undefined;
	const pairs = lcs(a, b, (x, y) => x === y);
	const ranges = (list: string[], kept: Set<number>) => {
		const out: [number, number][] = [];
		let at = 0,
			changed = 0,
			total = 0;
		list.forEach((token, i) => {
			const visible = token.trim().length > 0;
			if (visible) total += token.length;
			if (!kept.has(i) && visible) {
				changed += token.length;
				const last = out.at(-1);
				if (last && last[1] === at) last[1] += token.length;
				else out.push([at, at + token.length]);
			}
			at += token.length;
		});
		return { out, ratio: total ? changed / total : 0 };
	};
	const x = ranges(a, new Set(pairs.map((p) => p[0]))),
		y = ranges(b, new Set(pairs.map((p) => p[1])));
	// Marking most of a line says nothing the line colour does not already say.
	if (x.ratio > 0.7 || y.ratio > 0.7) return undefined;
	return [x.out, y.out];
}

/**
 * Pairs each run of deletions with the additions that follow it and marks changed words. With `ignoreWhitespace`,
 * lines that differ only in whitespace become context, numbered on both sides.
 */
export function prepareRows(rows: readonly Row[], ignoreWhitespace: boolean): Row[] {
	const out: Row[] = [];
	const pair = (deleted: Row[], added: Row[]) => {
		for (let i = 0; i < Math.min(deleted.length, added.length); i++) {
			const words = wordChanges(deleted[i].t, added[i].t);
			if (words) {
				deleted[i] = { ...deleted[i], words: words[0] };
				added[i] = { ...added[i], words: words[1] };
			}
		}
		out.push(...deleted, ...added);
	};
	for (let i = 0; i < rows.length; ) {
		if (rows[i].k === "c") {
			out.push(rows[i++]);
			continue;
		}
		let j = i;
		while (j < rows.length && rows[j].k !== "c") j++;
		const deleted = rows.slice(i, j).filter((r) => r.k === "d"),
			added = rows.slice(i, j).filter((r) => r.k === "a");
		i = j;
		if (!ignoreWhitespace) {
			pair(deleted, added);
			continue;
		}
		let d = 0,
			a = 0;
		for (const [x, y] of lcs(deleted, added, (p, q) => p.t.trim() === q.t.trim())) {
			pair(deleted.slice(d, x), added.slice(a, y));
			out.push({ k: "c", t: added[y].t, o: deleted[x].o, n: added[y].n });
			d = x + 1;
			a = y + 1;
		}
		pair(deleted.slice(d), added.slice(a));
	}
	return out;
}

/** The nearest declaration above a hunk's first change, for a quiet "in name()" label. */
export function enclosing(rows: readonly Row[], before: number): string {
	for (let i = Math.min(before, rows.length - 1); i >= 0; i--) {
		const m =
			/(?:function\s+([\w$]+)|(?:describe|it|test)\(\s*["'`]([^"'`]+)|(?:class|interface|struct|enum|trait|impl)\s+([\w$]+)|^\s*(?:pub\s+)?(?:fn|def|func)\s+([\w$]+)|^\s*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\(|^#{1,6}\s+(.+))/.exec(
				rows[i].t,
			);
		if (m) {
			const [, fn, spec, type, def, arrow, heading] = m;
			return fn || def || arrow ? `${fn ?? def ?? arrow}()` : spec ? `“${spec}”` : (type ?? heading ?? "");
		}
	}
	return "";
}

/**
 * Why a changed file is supporting material rather than where review starts. Labels name the kind of file, never a
 * verdict about whether it is correct.
 */
export function supportingKind(file: Pick<ChangeFile, "path" | "status" | "binary" | "additions" | "deletions">, fromCanonical = false) {
	const p = file.path;
	if (fromCanonical) return "From canonical";
	if (
		/(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|poetry\.lock|composer\.lock|uv\.lock)$/.test(
			p,
		)
	)
		return "Lockfile";
	if (/(^|\/)(dist|build|vendor|generated|__generated__|node_modules)\/|\.min\.(js|css)$|\.snap$|\.(pb|g|generated)\.\w+$/.test(p))
		return "Generated";
	if (file.status === "deleted") return "Deleted";
	if (file.binary) return "Binary";
	if (/(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]+\.py$/.test(p)) return "Tests";
	if (/\.(md|mdx|rst|txt|adoc)$/i.test(p) || /(^|\/)docs?\//.test(p)) return "Docs";
	if (file.additions === 0 && file.deletions === 0) return "Mode only";
	return "";
}

export type Placement = { note: ReviewNote; key?: string; changed: boolean; carried: boolean };

/**
 * Places each anchored note of one file on a displayed row. A note on the compared revision sits on its new-side line; a
 * note on the earlier compared revision sits on its old-side line, marked changed when that line was removed. A note on
 * another revision of the thread is carried to a new-side line with identical text when one is shown. Anything else
 * stays unplaced and is listed with its exact line. Notes are never moved to a guessed line.
 */
export function placeNotes(
	notes: readonly ReviewNote[],
	hunks: readonly { rows: readonly Row[] }[],
	from: string,
	to: string,
): Placement[] {
	const rows = hunks.flatMap((h) => h.rows);
	return notes.map((note) => {
		const a = note.anchor;
		if (!a) return { note, changed: false, carried: false };
		if (a.revision === to) {
			const row = rows.find((r) => r.k !== "d" && r.n === a.line);
			return { note, key: row ? `n${a.line}` : undefined, changed: false, carried: false };
		}
		if (a.revision === from) {
			const row = rows.find((r) => r.k !== "a" && r.o === a.line);
			return { note, key: row ? `o${a.line}` : undefined, changed: row?.k === "d", carried: false };
		}
		const text = a.text.trim();
		const row = text ? rows.find((r) => r.k !== "d" && r.t.trim() === text) : undefined;
		return { note, key: row ? `n${row.n}` : undefined, changed: false, carried: !!row };
	});
}
