import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function git(cwd: string, args: string[]) {
	return (await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
}
export async function pipeGit(cwd: string, args: string[], input: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
			chunks: Buffer[] = [];
		let bytes = 0;
		child.stdout.on("data", (b: Buffer) => {
			bytes += b.length;
			if (bytes > 32 * 1024 * 1024) {
				child.kill();
				reject(new Error("Git transfer exceeds 32 MiB"));
			} else chunks.push(b);
		});
		child.on("error", reject);
		child.stdin.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("Native Git object transfer failed"))));
		child.stderr.resume();
		child.stdin.end(input);
	});
}
/** Explicit publication includes all reachable objects so the server can validate local baselines. */
export async function packRevision(cwd: string, base: string, head?: string) {
	if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Exact base required");
	const revision = head ?? (await git(cwd, ["rev-parse", "HEAD"]));
	if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Exact revision required");
	await git(cwd, ["merge-base", "--is-ancestor", base, revision]);
	const pack = await pipeGit(cwd, ["pack-objects", "--revs", "--stdout", "-q"], Buffer.from(`${revision}\n`));
	return { base, revision, pack: pack.toString("base64") };
}
