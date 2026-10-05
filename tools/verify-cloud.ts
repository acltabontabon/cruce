/** Explicit, opt-in real-provider convergence check; authentication and authority are fixtures. */
import { mkdir, writeFile } from "node:fs/promises";
import { ArtifactsRestHost } from "../src/worker/artifacts.ts";
import { CONVERGENCE_BUDGET, convergenceRuntime, nativeGit, runConvergenceScenario } from "./verification/convergence.ts";

const accountId = process.env.CRUCE_TEST_ACCOUNT_ID,
	token = process.env.CRUCE_TEST_TOKEN;
if (!accountId || !token) throw new Error("Set explicit CRUCE_TEST_ACCOUNT_ID and CRUCE_TEST_TOKEN for an authorized test account");
console.log(
	`Declared hosted budget: ${CONVERGENCE_BUDGET} logical reservations, one isolated namespace, three forks; retain canonical/source/evidence.`,
);
const namespace = `cruce-check-${Date.now().toString(36)}`;
const fixture = convergenceRuntime(namespace);
const host = new ArtifactsRestHost(accountId, namespace, token);
const testedCommit = await nativeGit(["rev-parse", "HEAD"]);
const workingTreeDirty = Boolean(await nativeGit(["status", "--porcelain"]));
await mkdir("dist/live-verification", { recursive: true });
try {
	const result = await runConvergenceScenario(fixture, host);
	await writeFile(
		"dist/live-verification/result.json",
		JSON.stringify(
			{
				...result,
				testedCommit,
				workingTreeDirty,
				verifiedAt: new Date().toISOString(),
				environment: "real Artifacts / in-process Cruce runtime",
				limitations: ["Fixture grants/human authority", "Deployed OAuth/Git gateway unverified", "Actual independent clients unverified"],
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ namespace, revisions: result.revisions, checks: result.checks }));
} catch (error) {
	// Persist non-secret control state for uncertain-resource diagnosis, never the sealed account or provider errors.
	await writeFile(
		"dist/live-verification/failure.json",
		JSON.stringify(
			{
				namespace,
				testedCommit,
				workingTreeDirty,
				attemptedAt: new Date().toISOString(),
				errorType: (error as Error).name,
				state: fixture.runtime.state(),
				reservations: fixture.controller.state.reservations,
			},
			null,
			2,
		),
	);
	console.error(`Live verification stopped; namespace ${namespace} retained for diagnosis. See dist/live-verification/failure.json.`);
	throw new Error("Live convergence verification failed; inspect the operation with the configured test account");
}
