import { createTwoFilesPatch } from "diff";
import { describe, expect, it } from "vitest";
import type { ReviewNote } from "../../src/shared/platform.ts";
import { enclosing, parsePatch, placeNotes, prepareRows, supportingKind, wordChanges } from "../../src/ui/diff-model.ts";
import { grammarFor, segments } from "../../src/ui/highlight.ts";

const before = [
	"export function shouldRetry(error, attempt) {",
	"  return attempt < retries && isTransient(error);",
	"}",
	"",
	"export function policy(opts = {}) {",
	"    return {",
	"    attempts,",
	"  jitter: false,",
	"  };",
	"}",
].join("\n");
const after = [
	"export function shouldRetry(error, attempt) {",
	"  return attempt < retries && isTransient(error);",
	"}",
	"",
	"export function policy(opts = {}) {",
	"  return {",
	"    attempts,",
	"  jitter: true,",
	"  };",
	"}",
].join("\n");
const patch = createTwoFilesPatch("a/src/retry.ts", "b/src/retry.ts", `${before}\n`, `${after}\n`, undefined, undefined, { context: 1 });
const note = (fields: Partial<ReviewNote> & Pick<ReviewNote, "anchor">): ReviewNote => ({
	id: "n",
	actor: { id: "a", userId: "a", name: "A", kind: "human" },
	revision: "r2",
	kind: "concern",
	body: "x",
	replies: [],
	at: 0,
	...fields,
});

describe("review diff model", () => {
	it("parses unified hunks with numbers on each side and skips file headers", () => {
		const hunks = parsePatch(patch);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]).toMatchObject({ oldStart: 5, newStart: 5 });
		expect(hunks[0].rows.map((r) => [r.k, r.o, r.n])).toEqual([
			["c", 5, 5],
			["d", 6, undefined],
			["a", undefined, 6],
			["c", 7, 7],
			["d", 8, undefined],
			["a", undefined, 8],
			["c", 9, 9],
		]);
		expect(parsePatch("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file")[0]).toMatchObject({ oldCount: 1, newCount: 1 });
	});

	it("marks changed words, and folds whitespace-only edits into context numbered on both sides", () => {
		const rows = prepareRows(parsePatch(patch)[0].rows, false);
		expect(rows.find((r) => r.k === "a" && r.n === 8)?.words).toEqual([[10, 14]]);
		const calm = prepareRows(parsePatch(patch)[0].rows, true);
		expect(calm.find((r) => r.t === "  return {")).toMatchObject({ k: "c", o: 6, n: 6 });
		expect(calm.filter((r) => r.k !== "c").map((r) => r.t)).toEqual(["  jitter: false,", "  jitter: true,"]);
		expect(wordChanges("const a = 1;", "throw new Error(message)")).toBeUndefined();
	});

	it("labels the nearest declaration above a change", () => {
		expect(enclosing(parsePatch(patch)[0].rows, 1)).toBe("policy()");
		expect(enclosing([{ k: "c", t: '  it("caps attempts", () => {' }], 0)).toBe("“caps attempts”");
		expect(enclosing([{ k: "c", t: "## What is never retried" }], 0)).toBe("What is never retried");
	});

	it("names supporting files by kind and leaves source to start review", () => {
		const file = (path: string, extra = {}) => ({ path, status: "modified" as const, binary: false, additions: 1, deletions: 1, ...extra });
		expect(supportingKind(file("src/http/client.ts"))).toBe("");
		expect(supportingKind(file("pnpm-lock.yaml"))).toBe("Lockfile");
		expect(supportingKind(file("src/generated/openapi.ts"))).toBe("Generated");
		expect(supportingKind(file("test/retry/policy.test.ts"))).toBe("Tests");
		expect(supportingKind(file("docs/retries.md"))).toBe("Docs");
		expect(supportingKind(file("src/legacy/once.ts", { status: "deleted" }))).toBe("Deleted");
		expect(supportingKind(file("script.sh", { additions: 0, deletions: 0 }))).toBe("Mode only");
		expect(supportingKind(file("src/timeout.ts"), true)).toBe("From canonical");
	});

	it("places notes on exact lines, carries identical text forward and never guesses", () => {
		const hunks = [{ rows: prepareRows(parsePatch(patch)[0].rows, false) }];
		const [onNew, onOld, carried, elsewhere, whole] = placeNotes(
			[
				note({ anchor: { path: "src/retry.ts", line: 8, revision: "r3", text: "  jitter: true," } }),
				note({ anchor: { path: "src/retry.ts", line: 8, revision: "r2", text: "  jitter: false," } }),
				note({ anchor: { path: "src/retry.ts", line: 40, revision: "r1", text: "    attempts," } }),
				note({ anchor: { path: "src/retry.ts", line: 2, revision: "r1", text: "  return attempt < retries && isTransient(error);" } }),
				note({}),
			],
			hunks,
			"r2",
			"r3",
		);
		expect(onNew).toMatchObject({ key: "n8", changed: false });
		expect(onOld).toMatchObject({ key: "o8", changed: true });
		expect(carried).toMatchObject({ key: "n7", carried: true });
		expect(elsewhere.key).toBeUndefined();
		expect(whole.key).toBeUndefined();
	});

	it("colours common syntax without parsing across lines", () => {
		expect(grammarFor("src/a.ts")).toBe("c");
		expect(grammarFor("README.md")).toBe("markdown");
		expect(grammarFor("Makefile")).toBeUndefined();
		expect(segments('const x = "a"; // note', "c")).toEqual([
			{ text: "const", syntax: "syn-kw" },
			{ text: " x = " },
			{ text: '"a"', syntax: "syn-str" },
			{ text: "; " },
			{ text: "// note", syntax: "syn-com" },
		]);
		expect(segments("abc", undefined, [[1, 2]])).toEqual([{ text: "a" }, { text: "b", changed: true }, { text: "c" }]);
	});
});
