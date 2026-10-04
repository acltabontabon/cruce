import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactsHost } from "../../src/worker/artifacts-host.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { CloudflareArtifactWorkspace } from "../../src/worker/managed-workspace.ts";

async function fixture() {
	const fs = new MemoryFs(),
		workspace = new GitWorkspace(fs as never);
	await workspace.ensureInit();
	const base = await workspace.commit({
		ref: "refs/heads/main",
		parent: null,
		files: { "src/pay.ts": "export function pay(){return 1;}\n" },
		message: "base",
		author: { name: "fixture", email: "f@test.invalid", timestamp: 1700000000 },
	});
	const head = await workspace.commit({
		ref: "refs/heads/feature",
		parent: base,
		files: { "src/pay.ts": "export function pay(){return 2;}\n" },
		message: "feature",
		author: { name: "fixture", email: "f@test.invalid", timestamp: 1700000001 },
	});
	return { fs, workspace, base, head };
}
describe("managed Git substrate", () => {
	it("imports exact native Git object packs without rebuilding commits", async () => {
		const x = await fixture();
		const oids: string[] = [];
		for (const dir of (await x.fs.promises.readdir("/workspace.git/objects")).filter((n) => /^[a-f0-9]{2}$/.test(n)))
			for (const name of await x.fs.promises.readdir(`/workspace.git/objects/${dir}`)) oids.push(dir + name);
		const pack = await git.packObjects({ fs: x.fs as never, gitdir: "/workspace.git", oids });
		const imported = new GitWorkspace(new MemoryFs() as never, "/repository.git");
		await imported.ensureInit();
		await imported.importPack(pack.packfile!);
		expect(await imported.readFiles(x.head)).toEqual({ "src/pay.ts": "export function pay(){return 2;}\n" });
		expect(await imported.mergeBase(x.base, x.head)).toBe(x.base);
		const corrupt = pack.packfile!.slice();
		corrupt[10] ^= 1;
		await expect(imported.importPack(corrupt)).rejects.toThrow("checksum");
	});
	it("retains one fork and the original baseline across repeated provisioning", async () => {
		const x = await fixture(),
			fork = vi.fn(async (_source: string, name: string) => ({ name, remote: "https://artifact.test/workstream", created: false }));
		const host = {
			ensure: vi.fn(async (name: string) => ({ name, remote: "https://artifact.test/mirror", created: true })),
			info: vi.fn(async () => ({ description: `Cruce baseline snapshot ${x.base}` })),
			fork,
			withToken: vi.fn(async (_name: string, _scope: string, callback: (token: string) => Promise<unknown>) => ({
				result: await callback("ephemeral-fixture"),
				tokenId: "revoked",
			})),
		};
		vi.spyOn(x.workspace, "push").mockResolvedValue(undefined as never);
		const backend = new CloudflareArtifactWorkspace(host as unknown as ArtifactsHost, x.workspace, "gh-1-123", () => 100);
		const a = await backend.provision("W-1", x.base),
			b = await backend.provision("W-1", x.base);
		expect(a).toEqual(b);
		expect(new Set(fork.mock.calls.map((c) => c[1])).size).toBe(1);
		expect(a.baseline).toBe(x.base);
		expect(a.remote).not.toContain("ephemeral");
		expect((await backend.validate(a, x.head)).changes).toHaveLength(1);
	});
	it("refuses cleanup without matching owned identity", async () => {
		const x = await fixture(),
			remove = vi.fn(),
			host = { delete: remove };
		const backend = new CloudflareArtifactWorkspace(host as unknown as ArtifactsHost, x.workspace, "gh-1-123");
		await expect(
			backend.archive({
				workstreamId: "W-1",
				backend: "cloudflare_artifacts",
				repository: "someone-else",
				remote: "https://artifact.test/other",
				baseline: x.base,
				head: x.head,
				state: "active",
				createdAt: 0,
				owned: true,
			}),
		).rejects.toThrow("Cruce-owned");
		expect(remove).not.toHaveBeenCalled();
	});
});
