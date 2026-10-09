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
		// Git may exit before reading stdin (e.g. `diff` with no input); its exit code decides the outcome.
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") reject(error);
		});
		child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("Native Git object transfer failed"))));
		child.stderr.resume();
		child.stdin.end(input);
	});
}
