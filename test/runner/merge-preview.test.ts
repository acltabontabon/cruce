import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { previewReconciliation } from "../../runner/merge-preview.ts";
import { nativeRepository } from "../git/native-fixture.ts";

it("previews clean exact commits without changing refs, index, working files or source objects", async () => {
	const f = await nativeRepository();
	try {
		await writeFile(join(f.root, "base"), "base\n");
		f.run(["add", "."]);
		f.run(["commit", "-qm", "base"]);
		const base = f.run(["rev-parse", "HEAD"]);
		await writeFile(join(f.root, "canonical"), "canonical\n");
		f.run(["add", "."]);
		f.run(["commit", "-qm", "canonical"]);
		const canonical = f.run(["rev-parse", "HEAD"]);
		f.run(["checkout", "-qb", "workspace", base]);
		await writeFile(join(f.root, "workspace"), "workspace\n");
		f.run(["add", "."]);
		f.run(["commit", "-qm", "workspace"]);
		await writeFile(join(f.root, "workspace"), "dirty changes stay here\n");
		f.run(["add", "workspace"]);
		await writeFile(join(f.root, "untracked"), "untracked\n");
		const head = f.run(["rev-parse", "HEAD"]),
			refs = f.run(["show-ref"]),
			status = f.run(["status", "--porcelain"]);
		const index = await readFile(join(f.root, ".git", "index"));
		const objects = await readdir(join(f.root, ".git", "objects"), { recursive: true });
		expect(await previewReconciliation(f.root, canonical)).toMatchObject({
			status: "clean",
			workspaceRevision: head,
			canonicalRevision: canonical,
			workingChangesExcluded: true,
			conflictingPaths: [],
		});
		expect(f.run(["show-ref"])).toBe(refs);
		expect(f.run(["status", "--porcelain"])).toBe(status);
		expect(await readFile(join(f.root, ".git", "index"))).toEqual(index);
		expect(await readdir(join(f.root, ".git", "objects"), { recursive: true })).toEqual(objects);
		expect(await readFile(join(f.root, "workspace"), "utf8")).toBe("dirty changes stay here\n");
	} finally {
		await f.close();
	}
});

it("reports real content and binary conflicts, including newline filenames, without applying the merge", async () => {
	const f = await nativeRepository();
	try {
		const name = "line\nbreak.txt";
		await writeFile(join(f.root, name), "base\n");
		await writeFile(join(f.root, "binary"), Buffer.from([0, 1]));
		f.run(["add", "."]);
		f.run(["commit", "-qm", "base"]);
		const base = f.run(["rev-parse", "HEAD"]);
		await writeFile(join(f.root, name), "canonical\n");
		await writeFile(join(f.root, "binary"), Buffer.from([0, 2]));
		f.run(["add", "."]);
		f.run(["commit", "-qm", "canonical"]);
		const canonical = f.run(["rev-parse", "HEAD"]);
		f.run(["checkout", "-qb", "workspace", base]);
		await writeFile(join(f.root, name), "workspace\n");
		await writeFile(join(f.root, "binary"), Buffer.from([0, 3]));
		f.run(["add", "."]);
		f.run(["commit", "-qm", "workspace"]);
		const result = await previewReconciliation(f.root, canonical);
		expect(result.status).toBe("conflicts");
		if (result.status !== "conflicts") throw new Error("Missing conflicts");
		expect(result.conflictingPaths).toEqual(expect.arrayContaining([name, "binary"]));
		expect(result.conflicts).toEqual(expect.arrayContaining([{ type: "CONFLICT (binary)", paths: ["binary"] }]));
		expect(await readFile(join(f.root, name), "utf8")).toBe("workspace\n");
		expect(f.run(["status", "--porcelain"])).toBe("");
	} finally {
		await f.close();
	}
});

it("keeps missing source unavailable and unrelated histories separate from conflicts", async () => {
	const f = await nativeRepository();
	try {
		await writeFile(join(f.root, "base"), "base");
		f.run(["add", "."]);
		f.run(["commit", "-qm", "base"]);
		const canonical = f.run(["rev-parse", "HEAD"]);
		expect(await previewReconciliation(f.root, "f".repeat(40))).toMatchObject({
			status: "unavailable",
			reason: expect.stringContaining("Fetch canonical"),
		});
		f.run(["checkout", "--orphan", "unrelated"]);
		f.run(["rm", "-rf", "."]);
		await writeFile(join(f.root, "other"), "other");
		f.run(["add", "."]);
		f.run(["commit", "-qm", "unrelated"]);
		expect(await previewReconciliation(f.root, canonical)).toMatchObject({ status: "unrelated" });
		expect(await previewReconciliation(f.root, "--help")).toMatchObject({ status: "unavailable" });
	} finally {
		await f.close();
	}
});
