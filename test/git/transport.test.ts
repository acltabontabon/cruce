import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace, NOTES_REF } from "../../src/worker/git/workspace.ts";

it("fetches real smart-HTTP Git into a bare workspace without moving accepted source", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cruce-git-transport-"));
	const git = (args: string[], input?: Uint8Array) => execFileSync("git", args, { input, stdio: ["pipe", "pipe", "pipe"] });
	const requests: string[] = [];
	const server = createServer(async (request, response) => {
		requests.push(request.headers.authorization ?? "");
		if (request.headers.authorization !== "Bearer fixture-read-token") {
			response.writeHead(401).end();
			return;
		}
		try {
			if (request.url?.includes("/info/refs?service=git-upload-pack")) {
				response.setHeader("content-type", "application/x-git-upload-pack-advertisement");
				response.end(
					Buffer.concat([
						Buffer.from("001e# service=git-upload-pack\n0000"),
						git(["upload-pack", "--stateless-rpc", "--advertise-refs", directory]),
					]),
				);
			} else {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				response.setHeader("content-type", "application/x-git-upload-pack-result");
				response.end(git(["upload-pack", "--stateless-rpc", directory], Buffer.concat(chunks)));
			}
		} catch {
			response.writeHead(500).end();
		}
	});
	try {
		git(["init", "--bare", "--initial-branch=main", directory]);
		const upstream = new GitWorkspace(new MemoryFs() as never);
		await upstream.ensureInit();
		const author = { name: "Fixture", email: "fixture@cruce.invalid", timestamp: 1700000000 };
		const base = await upstream.commit({
			ref: "refs/heads/main",
			parent: null,
			files: { "README.md": "Initial source\n" },
			message: "Initial",
			author,
		});
		const install = async (ref: string, oid: string) => {
			git(["--git-dir", directory, "index-pack", "--stdin"], await upstream.exportPack(oid));
			git(["--git-dir", directory, "update-ref", ref, oid]);
		};
		await install("refs/heads/main", base);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture address");
		const input = { url: `http://127.0.0.1:${address.port}/source.git`, token: "fixture-read-token" };
		const fs = new MemoryFs();
		const local = new GitWorkspace(fs as never);
		await local.ensureInit();
		expect(await local.fetch({ ...input, localRef: "refs/cruce/accepted" })).toBe(base);
		expect(await local.readFiles(base)).toEqual({ "README.md": "Initial source\n" });
		const next = await upstream.commit({
			ref: "refs/heads/main",
			parent: base,
			files: { "README.md": "Proposed source\n" },
			message: "Change",
			author,
		});
		await install("refs/heads/main", next);
		expect(await local.fetch({ ...input, localRef: "refs/cruce/observed-source" })).toBe(next);
		expect(await local.fetch({ ...input, localRef: "refs/cruce/observed-source" })).toBe(next);
		expect(await local.resolve("refs/cruce/accepted")).toBe(base);
		await upstream.addNote(next, { proposalId: "fixture-proposal" }, author);
		await install(NOTES_REF, (await upstream.resolve(NOTES_REF))!);
		await local.fetchNotes(input);
		expect(await local.readNote(next)).toEqual({ proposalId: "fixture-proposal" });
		expect(requests.length).toBeGreaterThanOrEqual(4);
		expect(requests.every((authorization) => authorization === "Bearer fixture-read-token")).toBe(true);
		const config = await fs.promises.readFile("/workspace.git/config", "utf8");
		expect(config).not.toContain(input.token);
		expect(config).not.toContain(input.url);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
