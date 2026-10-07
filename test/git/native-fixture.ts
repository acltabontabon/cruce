import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function nativeRepository(pack?: Uint8Array, base?: string) {
	const root = await mkdtemp(join(tmpdir(), "cruce-git-review-"));
	const bytes = (args: string[], input?: Uint8Array | string) =>
		execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
			cwd: root,
			input,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.com",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.com",
				GIT_AUTHOR_DATE: "2026-10-07T00:00:00Z",
				GIT_COMMITTER_DATE: "2026-10-07T00:00:00Z",
			},
		});
	const run = (args: string[], input?: Uint8Array | string) => bytes(args, input).toString().trim();
	run(["init", "-q", "-b", "main"]);
	if (pack && base) {
		run(["index-pack", "--stdin"], pack);
		run(["checkout", "--detach", base]);
	}
	return {
		root,
		run,
		pack: (head: string) => bytes(["pack-objects", "--revs", "--stdout", "-q"], `${head}\n`),
		close: () => rm(root, { recursive: true, force: true }),
	};
}
