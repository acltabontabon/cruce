import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { stateDirectory } from "../../runner/execution.ts";
import { git } from "../../runner/local-git.ts";
import { writeState } from "../../runner/state-file.ts";
import { nativeRepository } from "../git/native-fixture.ts";

it("replays an interrupted start across processes and starts fresh after detachment without changing origin or branch", async () => {
	const f = await nativeRepository();
	const keys: string[] = [];
	const workspaces = new Map<string, { id: string; baseRevision: string }>();
	let attachFails = true;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw) as { tool: string; idempotencyKey: string; baseRevision: string; workspaceId: string };
		response.setHeader("content-type", "application/json");
		if (body.tool === "start_workspace") {
			keys.push(body.idempotencyKey);
			if (!workspaces.has(body.idempotencyKey))
				workspaces.set(body.idempotencyKey, { id: `workspace-${workspaces.size + 1}`, baseRevision: body.baseRevision });
			response.end(JSON.stringify(workspaces.get(body.idempotencyKey)));
			return;
		}
		if (body.tool === "attach_workspace") {
			if (attachFails) {
				attachFails = false;
				response.statusCode = 503;
				response.end(JSON.stringify({ error: "Interrupted attachment" }));
				return;
			}
			response.end(JSON.stringify({ id: body.workspaceId, fork: { id: "fork", name: "fork", state: "ready" } }));
			return;
		}
		if (body.tool === "get_git_access") {
			response.end(JSON.stringify({ fork: `/mcp/git/ns/repo/${body.workspaceId}.git` }));
			return;
		}
		response.end(JSON.stringify({ id: body.workspaceId, state: body.tool === "end_workspace" ? "completed" : "detached" }));
	});
	try {
		await writeFile(join(f.root, "code.txt"), "baseline");
		f.run(["add", "."]);
		f.run(["commit", "-qm", "Base"]);
		f.run(["remote", "add", "origin", "https://example.invalid/original.git"]);
		f.run(["config", "branch.main.remote", "origin"]);
		f.run(["config", "branch.main.merge", "refs/heads/main"]);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture address");
		const path = join(await stateDirectory(f.root), "connection.json");
		await writeState(path, {
			server: `http://127.0.0.1:${address.port}`,
			namespaceId: "ns",
			repositoryId: "repo",
			humanToken: "fixture-terminal",
		});
		const cli = (operation: string) =>
			promisify(execFile)(process.execPath, [resolve("runner/cruce.mjs"), operation, "--cwd", f.root], { timeout: 15000 });
		await expect(cli("start")).rejects.toThrow("Interrupted attachment");
		const interrupted = JSON.parse(await readFile(path, "utf8"));
		expect(interrupted.workspaceId).toBe("workspace-1");
		expect(interrupted.pending.command.idempotencyKey).toBe(keys[0]);
		await cli("start");
		expect(keys).toEqual([keys[0], keys[0]]);
		expect(JSON.parse(await readFile(path, "utf8")).pending).toBeUndefined();
		await cli("detach");
		const detached = JSON.parse(await readFile(path, "utf8"));
		expect(detached.workspaceId).toBeUndefined();
		expect(detached.directory).toBeUndefined();
		await cli("start");
		expect(JSON.parse(await readFile(path, "utf8")).workspaceId).toBe("workspace-2");
		await cli("end");
		expect(JSON.parse(await readFile(path, "utf8")).workspaceId).toBeUndefined();
		expect(await git(f.root, ["remote", "get-url", "origin"])).toBe("https://example.invalid/original.git");
		expect(await git(f.root, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
		expect(await git(f.root, ["config", "branch.main.remote"])).toBe("origin");
		expect(await git(f.root, ["config", "branch.main.merge"])).toBe("refs/heads/main");
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
		await f.close();
	}
}, 20000);
