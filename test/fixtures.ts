import { overlayFiles, seedFiles } from "../src/demo/scenario.ts";
import { buildIndex } from "../src/intelligence/structural-index.ts";

export const seed = seedFiles();
export const baseIndex = buildIndex(seed, "base");

export function indexAfter(...overlays: string[]) {
	const files = { ...seed };
	for (const o of overlays) Object.assign(files, overlayFiles(o));
	return { files, index: buildIndex(files, overlays.join("+") || "base") };
}

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Three-way merge of one file with real git (`git merge-file`). Throws on conflict. */
export function gitMergeFile(base: string, ours: string, theirs: string): string {
	const dir = mkdtempSync(join(tmpdir(), "cruce-merge-"));
	try {
		for (const [name, content] of Object.entries({ base, ours, theirs })) writeFileSync(join(dir, name), content);
		execFileSync("git", ["merge-file", "ours", "base", "theirs"], { cwd: dir });
		return readFileSync(join(dir, "ours"), "utf8");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Files after merging several overlays onto the seed, each as an independent branch (like landings). */
export function mergedAfter(...overlays: string[]) {
	const files = { ...seed };
	for (const o of overlays) {
		for (const [path, content] of Object.entries(overlayFiles(o))) {
			const base = seed[path];
			files[path] =
				base !== undefined && files[path] !== base && files[path] !== content ? gitMergeFile(base, files[path], content) : content;
		}
	}
	return { files, index: buildIndex(files, overlays.join("+")) };
}
