import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitWorkspace } from "../../src/worker/git/workspace.ts";

/** Native receive-pack checks the advertised old OID under its ref lock. */
export async function gitServer(source: GitWorkspace, base: string, candidates: string[] = []) {
	const directory = await mkdtemp(join(tmpdir(), "cruce-promotion-"));
	const native = (args: string[], input?: Uint8Array) =>
		execFileSync("git", ["--git-dir", directory, ...args], { input, stdio: ["pipe", "pipe", "pipe"] });
	native(["init", "--bare", "--initial-branch=trunk"]);
	native(["config", "gc.auto", "0"]);
	native(["config", "maintenance.auto", "false"]);
	for (const oid of [base, ...candidates]) native(["index-pack", "--stdin"], await source.exportPack(oid));
	const setHead = (oid: string) => {
		native(["update-ref", "refs/heads/trunk", oid]);
	};
	setHead(base);
	const fixture = {
		url: "",
		updates: 0,
		beforeAdvertisement: () => {},
		beforeUpdate: () => {},
		afterUpdate: () => {},
		setHead,
		setRef: (ref: string, oid: string) => {
			native(["update-ref", ref, oid]);
		},
		deleteRef: (ref: string) => {
			native(["update-ref", "-d", ref]);
		},
		setShallow: (oid: string) => writeFile(join(directory, "shallow"), `${oid}\n`),
		head: () => native(["rev-parse", "refs/heads/trunk"]).toString().trim(),
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true, maxRetries: 3 });
		},
	};
	const server = createServer(async (request, response) => {
		try {
			if (request.url?.includes("/info/refs")) {
				const service = new URL(request.url, "http://localhost").searchParams.get("service")!;
				if (service === "git-receive-pack") fixture.beforeAdvertisement();
				response.setHeader("content-type", `application/x-${service}-advertisement`);
				const line = `# service=${service}\n`;
				response.end(
					Buffer.concat([
						Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0") + line}0000`),
						native([service.replace("git-", ""), "--stateless-rpc", "--advertise-refs", directory]),
					]),
				);
			} else {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const receive = request.url?.endsWith("/git-receive-pack");
				if (receive) {
					fixture.updates++;
					fixture.beforeUpdate();
				}
				const result = native([receive ? "receive-pack" : "upload-pack", "--stateless-rpc", directory], Buffer.concat(chunks));
				if (receive) fixture.afterUpdate();
				response.setHeader("content-type", `application/x-git-${receive ? "receive" : "upload"}-pack-result`);
				response.end(result);
			}
		} catch {
			response.writeHead(500).end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing Git server address");
	fixture.url = `http://127.0.0.1:${address.port}/canonical.git`;
	return fixture;
}
