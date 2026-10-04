import { describe, expect, it, vi } from "vitest";
import type { ArtifactsHost } from "../../src/worker/artifacts-host.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace, NOTES_REF } from "../../src/worker/git/workspace.ts";
import { CANONICAL, ProjectGit } from "../../src/worker/project-git.ts";

describe("cleanup Git safety", () => {
	it("revokes a read token minted concurrently with termination instead of returning it", async () => {
		let resolve!: (token: { plaintext: string; id: string }) => void;
		const mint = vi.fn(
			() =>
				new Promise<{ plaintext: string; id: string }>((done) => {
					resolve = done;
				}),
		);
		const revokeToken = vi.fn(async () => {});
		const host = { namespace: "cruce", mint, revokeToken } as unknown as ArtifactsHost;
		const git = new ProjectGit(new GitWorkspace(new MemoryFs() as never), "auth-service", host);
		let active = true;
		const request = git.readToken("F-001", () => {
			if (!active) throw new Error("terminal");
		});
		active = false;
		resolve({ plaintext: "test-only", id: "read-id" });
		await expect(request).rejects.toThrow("terminal");
		expect(revokeToken).toHaveBeenCalledWith("auth-service--f001", "read-id");
	});

	it("requires the canonical remote's landing note and reachable published work", async () => {
		const ws = new GitWorkspace(new MemoryFs() as never);
		await ws.ensureInit();
		const author = { name: "Test", email: "test@example.com", timestamp: 1 };
		const base = await ws.commit({ ref: CANONICAL, parent: null, files: { "code.ts": "base" }, message: "base", author });
		const published = await ws.commit({
			ref: "refs/heads/flights/F-001",
			parent: base,
			files: { "code.ts": "work" },
			message: "work",
			author,
		});
		const merge = await ws.merge({ ours: CANONICAL, theirs: published, message: "landing", author });
		await ws.addNote(merge.oid!, { kind: "landing", flightId: "F-001" }, author);
		const readFile = vi.fn(async () => new Blob([JSON.stringify({ kind: "landing", flightId: "F-001" })]));
		const host = {
			namespace: "cruce",
			info: async () => ({ remote: "https://example.test/canonical.git" }),
			readFile,
			withToken: async (_name: string, _scope: string, work: (token: string) => Promise<unknown>) => ({
				result: await work("test-only"),
				tokenId: "read-id",
			}),
		} as unknown as ArtifactsHost;
		const fetch = vi.spyOn(ws, "fetch").mockResolvedValue(merge.oid!);
		const git = new ProjectGit(ws, "auth-service", host);
		const flight = { id: "F-001", landedCommit: merge.oid, publishedHead: published };
		await expect(git.verifyLanding(flight)).resolves.toBeUndefined();
		expect(readFile).toHaveBeenCalledWith("auth-service", NOTES_REF, merge.oid);
		readFile.mockResolvedValueOnce(null as never);
		await expect(git.verifyLanding(flight)).rejects.toThrow("note missing");
		fetch.mockResolvedValueOnce(base);
		await expect(git.verifyLanding(flight)).rejects.toThrow("not preserved in canonical");
		const unrelated = await ws.commit({
			ref: "refs/heads/other",
			parent: base,
			files: { "other.ts": "unaccepted" },
			message: "other",
			author,
		});
		await expect(git.verifyLanding({ ...flight, publishedHead: unrelated })).rejects.toThrow("Published work is not preserved");
	});
});
