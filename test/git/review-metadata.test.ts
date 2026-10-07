import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { nativeRepository } from "./native-fixture.ts";

it("reviews native executable bits, symlink conversions and every submodule operation", async () => {
	const f = await nativeRepository();
	try {
		await writeFile(join(f.root, "script.sh"), "echo hello\n");
		await writeFile(join(f.root, "link"), "script.sh");
		f.run(["add", "."]);
		f.run(["commit", "-qm", "Base"]);
		const base = f.run(["rev-parse", "HEAD"]);
		f.run(["update-index", "--chmod=+x", "script.sh"]);
		f.run(["commit", "-qm", "Mode"]);
		const mode = f.run(["rev-parse", "HEAD"]);
		await rm(join(f.root, "link"));
		await symlink("script.sh", join(f.root, "link"));
		f.run(["add", "link"]);
		f.run(["commit", "-qm", "Symlink"]);
		const link = f.run(["rev-parse", "HEAD"]);
		f.run(["update-index", "--add", "--cacheinfo", `160000,${base},vendor`]);
		f.run(["commit", "-qm", "Submodule added"]);
		const added = f.run(["rev-parse", "HEAD"]);
		f.run(["update-index", "--cacheinfo", `160000,${mode},vendor`]);
		f.run(["commit", "-qm", "Submodule updated"]);
		const updated = f.run(["rev-parse", "HEAD"]);
		f.run(["update-index", "--force-remove", "vendor"]);
		f.run(["commit", "-qm", "Submodule removed"]);
		const removed = f.run(["rev-parse", "HEAD"]);
		const ws = new GitWorkspace(new MemoryFs() as never);
		await ws.ensureInit();
		await ws.importPack(f.pack(removed));
		const diff = await ws.reviewChanges(base, mode, "script.sh");
		expect(diff.files[0]).toMatchObject({
			path: "script.sh",
			before: { mode: "100644" },
			after: { mode: "100755" },
			additions: 0,
			deletions: 0,
		});
		expect(diff.file?.reason).toBe("File mode changed; contents unchanged.");
		expect(diff.file?.patch).toBeNull();
		expect((await ws.reviewChanges(mode, link)).files[0]).toMatchObject({
			path: "link",
			before: { mode: "100644" },
			after: { mode: "120000" },
		});
		for (const [before, after, status] of [
			[link, added, "added"],
			[added, updated, "modified"],
			[updated, removed, "deleted"],
		]) {
			const diff = await ws.reviewChanges(before, after, "vendor");
			expect(diff.files[0]).toMatchObject({ path: "vendor", status });
			expect(diff.file?.patch).toContain("Subproject commit");
		}
	} finally {
		await f.close();
	}
});
