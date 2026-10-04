import { describe, expect, it } from "vitest";
import { overlayFiles, seedFiles } from "../../src/demo/scenario.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";

const author = (minute: number) => ({ name: "Cruce", email: "tower@cruce.acltabontabon.com", timestamp: 1_791_190_800 + minute * 60 });

async function seeded() {
	const ws = new GitWorkspace(new MemoryFs() as never);
	await ws.ensureInit();
	const seed = await ws.commit({ ref: "refs/heads/main", parent: null, files: seedFiles(), message: "Baseline", author: author(0) });
	return { ws, seed };
}

describe("git workspace (isomorphic-git, bare, in the control plane)", () => {
	it("produces reproducible commits from trees", async () => {
		const a = await seeded();
		const b = await seeded();
		expect(a.seed).toBe(b.seed);
		expect(Object.keys(await a.ws.readFiles(a.seed))).toContain("src/auth/token-validator.ts");
	});

	it("computes diffs with base line ranges", async () => {
		const { ws, seed } = await seeded();
		await ws.setRef("refs/heads/flights/F-022", seed);
		const head = await ws.commit({
			ref: "refs/heads/flights/F-022",
			parent: seed,
			files: overlayFiles("f022-jwt-migration"),
			message: "jwt",
			author: author(1),
		});
		const { files, base } = await ws.changes(seed, head);
		expect(files.map((f) => f.path)).toEqual([
			"src/auth/auth-service.ts",
			"src/auth/jwt-decoder.ts",
			"src/auth/middleware.ts",
			"src/auth/security-config.ts",
			"src/auth/token-validator.ts",
			"test/token-validator.test.ts",
		]);
		expect(files.every((f) => f.status === "modified" && f.ranges.length > 0)).toBe(true);
		expect(base["src/auth/token-validator.ts"]).toContain("validate(token: string): Claims | null");
	});

	it("replays the whole demo with real three-way merges, notes, and a baseline refresh", async () => {
		const { ws, seed } = await seeded();
		const branch = (id: string) => `refs/heads/flights/${id}`;
		for (const id of ["F-021", "F-022", "F-023"]) await ws.setRef(branch(id), seed);

		const c22 = await ws.commit({
			ref: branch("F-022"),
			parent: seed,
			files: overlayFiles("f022-jwt-migration"),
			message: "jwt",
			author: author(1),
		});
		const c23 = await ws.commit({
			ref: branch("F-023"),
			parent: seed,
			files: overlayFiles("f023-session-cleanup"),
			message: "sessions",
			author: author(2),
		});
		const c21 = await ws.commit({
			ref: branch("F-021"),
			parent: seed,
			files: overlayFiles("f021-rotation-1"),
			message: "rotation 1",
			author: author(3),
		});

		const pre = await ws.merge({ ours: "refs/heads/main", theirs: c22, message: "x", author: author(4), dryRun: true });
		expect(pre).toMatchObject({ clean: true, mergeBase: seed });
		expect(await ws.resolve("refs/heads/main")).toBe(seed);

		const land22 = await ws.merge({ ours: "refs/heads/main", theirs: c22, message: "Land F-022", author: author(5) });
		expect(land22.clean).toBe(true);
		await ws.addNote(land22.oid as string, { flightId: "F-022", planVersion: 1 }, author(5));
		const land23 = await ws.merge({ ours: "refs/heads/main", theirs: c23, message: "Land F-023", author: author(6) });
		expect(land23.clean).toBe(true);

		// Refresh F-021 onto canonical: merge canonical into the Flight branch (auth-service.ts auto-merges).
		const refreshed = await ws.merge({ ours: branch("F-021"), theirs: "refs/heads/main", message: "Refresh F-021", author: author(7) });
		expect(refreshed.clean).toBe(true);
		const merged = await ws.readFiles(branch("F-021"));
		expect(merged["src/auth/auth-service.ts"]).toContain("result.valid ? result.claims : null");
		expect(merged["src/auth/auth-service.ts"]).toContain("revokeFamily(record.family ?? record.token)");

		const c21b = await ws.commit({
			ref: branch("F-021"),
			parent: refreshed.oid as string,
			files: overlayFiles("f021-rotation-2"),
			message: "rotation 2",
			author: author(8),
		});
		const step2 = await ws.changes(refreshed.oid as string, c21b);
		expect(step2.files.map((f) => f.path)).toEqual(["src/auth/auth-service.ts", "test/auth-service.test.ts"]);

		const land21 = await ws.merge({ ours: "refs/heads/main", theirs: c21b, message: "Land F-021", author: author(9) });
		expect(land21.clean).toBe(true);
		const final = await ws.readFiles("refs/heads/main");
		expect(final["src/auth/auth-service.ts"]).toBe(overlayFiles("f021-rotation-2")["src/auth/auth-service.ts"]);
		expect(await ws.readNote(land22.oid as string)).toEqual({ flightId: "F-022", planVersion: 1 });
		expect((await ws.log("refs/heads/main", 10)).map((l) => l.message)).toContain("Land F-022");
		expect(c21).not.toBe(c21b);
	});

	it("reports an actual Git conflict without landing", async () => {
		const { ws, seed } = await seeded();
		const path = "src/auth/token-validator.ts";
		const original = seedFiles()[path];
		const a = await ws.commit({
			ref: "refs/heads/a",
			parent: seed,
			files: { [path]: original.replace("Claims | null", "Claims | undefined") },
			message: "a",
			author: author(1),
		});
		await ws.commit({
			ref: "refs/heads/main",
			parent: seed,
			files: { [path]: original.replace("Claims | null", "Claims | false") },
			message: "b",
			author: author(2),
		});
		const before = await ws.resolve("refs/heads/main");
		const result = await ws.merge({ ours: "refs/heads/main", theirs: a, message: "m", author: author(3) });
		expect(result).toMatchObject({ clean: false, conflicts: [path] });
		expect(await ws.resolve("refs/heads/main")).toBe(before);
	});
});
