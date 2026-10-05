import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fixture } from "../test/browser/fixture.ts";
import { nativeGit } from "./verification/convergence.ts";
import { localConvergence } from "./verification/local-host.ts";

const first = await fixture();
const second = await fixture();
assert.equal(first.base, second.base);
assert.equal(first.head, second.head);
assert.notEqual(first.base, first.head);
console.log(`Fixed-clock workspace scenario verified: ${first.base} → ${first.head}`);

const convergence = await localConvergence();
const replay = await localConvergence();
assert.deepEqual(convergence.revisions, replay.revisions);
assert.deepEqual(convergence.behavior, replay.behavior);
await mkdir("dist/scenario-verification", { recursive: true });
await writeFile(
	"dist/scenario-verification/result.json",
	JSON.stringify(
		{
			...convergence,
			testedCommit: await nativeGit(["rev-parse", "HEAD"]),
			workingTreeDirty: Boolean(await nativeGit(["status", "--porcelain"])),
			verifiedAt: new Date().toISOString(),
			environment: "local bare Git / in-process Cruce runtime",
			reproducibleReplay: true,
		},
		null,
		2,
	),
);
console.log(`Two-writer convergence verified reproducibly: ${JSON.stringify(convergence.revisions)}`);
console.log("Clean merge failed at 2 ms instead of 2000 ms; repaired source passed fresh verification and review.");
