import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { RepositoryController } from "../../src/core/platform.ts";
import type { Actor, Artifact, Command, Proposal, Repository, Workspace } from "../../src/shared/platform.ts";
import type { RepositoryHost } from "../../src/worker/artifacts.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import type { ConnectionGrant } from "../../src/worker/namespace-runtime.ts";
import { RepositoryRuntime } from "../../src/worker/repository-runtime.ts";
import type { Store } from "../../src/worker/store.ts";

export const CONVERGENCE_TIME = 1791158400000;
export const CONVERGENCE_BUDGET = 20;
const fixtureRoot = fileURLToPath(new URL("../../demo/convergence/", import.meta.url));
const execute = promisify(execFile);

/** No credentials enter command arguments, remotes, persistent config or test reports. */
export async function nativeGit(args: string[], token?: string) {
	return (
		await execute("git", args, {
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_TRACE: "0",
				GIT_TRACE_CURL: "0",
				GIT_CURL_VERBOSE: "0",
				GIT_AUTHOR_NAME: "Convergence fixture",
				GIT_AUTHOR_EMAIL: "verify@cruce.invalid",
				GIT_COMMITTER_NAME: "Convergence fixture",
				GIT_COMMITTER_EMAIL: "verify@cruce.invalid",
				GIT_AUTHOR_DATE: "2026-10-05T00:00:00Z",
				GIT_COMMITTER_DATE: "2026-10-05T00:00:00Z",
				GIT_CONFIG_COUNT: token ? "4" : "3",
				GIT_CONFIG_KEY_0: "commit.gpgsign",
				GIT_CONFIG_VALUE_0: "false",
				GIT_CONFIG_KEY_1: "core.hooksPath",
				GIT_CONFIG_VALUE_1: "/dev/null",
				GIT_CONFIG_KEY_2: "protocol.version",
				GIT_CONFIG_VALUE_2: "1",
				...(token ? { GIT_CONFIG_KEY_3: "http.extraHeader", GIT_CONFIG_VALUE_3: `Authorization: Bearer ${token}` } : {}),
			},
		})
	).stdout.trim();
}

/** Fixture authority only: this harness does not authenticate browser or OAuth participants. */
export function convergenceRuntime(namespace: string) {
	const values = new Map<string, unknown>();
	const store: Store = {
		get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
		put: (key, value) => {
			values.set(key, structuredClone(value));
		},
		delete: (key) => {
			values.delete(key);
		},
	};
	const owner: Actor = { id: "test-owner", userId: "test-owner", name: "Convergence reviewer", kind: "human" };
	const controller = new NamespaceController(
		initialNamespace({
			id: namespace,
			handle: namespace,
			name: "Isolated convergence verification",
			ownerId: owner.id,
			kind: "personal",
			createdAt: CONVERGENCE_TIME,
		}),
		CONVERGENCE_TIME,
	);
	controller.state.policy.dailyLimit = CONVERGENCE_BUDGET;
	const repository: Repository = {
		id: "repository",
		namespaceId: namespace,
		name: "convergence-check",
		defaultBranch: "trunk",
		createdAt: CONVERGENCE_TIME,
		storageName: "repo-repository",
		grants: [],
		policy: { protectedPaths: [], requiredEvidence: ["tests"], resourceRules: {} },
	};
	controller.repository(controller.authority(owner), repository);
	const env = { CRUCE_SECRET: crypto.randomUUID() };
	const runtime = new RepositoryRuntime(
		store,
		new GitWorkspace(new MemoryFs() as never),
		{
			authority: (g: ConnectionGrant, id?: string) => controller.authority(g.actor, id, g.scopes, g.repositories),
			repository: (g: ConnectionGrant, id: string) => {
				controller.authority(g.actor, id, g.scopes, g.repositories);
				assert.equal(id, repository.id);
				return repository;
			},
			reserve: (g, id, key, fingerprint, action, workspace) =>
				controller.reserve(controller.authority(g.actor, id, g.scopes, g.repositories), key, fingerprint, action, workspace),
			settle: (id, state) => {
				controller.state.reservations.find((r) => r.id === id)!.state = state;
			},
			resourceConfiguration: () => ({ namespace, account: store.get("resource-account"), policy: controller.state.policy }),
		},
		env,
		() => CONVERGENCE_TIME,
	);
	runtime.initialize(repository);
	const human: ConnectionGrant = { actor: owner };
	const agent = (id: string): ConnectionGrant => ({
		actor: { id, userId: owner.id, name: id, kind: "agent", connectionId: `${id}-connection` },
		scopes: ["cruce:read", "workspace:write", "revision:publish", "artifact:publish", "change:write", "promotion:request"],
		repositories: [repository.id],
	});
	let sequence = 0;
	const call = (tool: string, fields: Partial<Command> = {}, grant = human) =>
		runtime.command(
			{
				tool,
				namespaceId: namespace,
				repositoryId: repository.id,
				idempotencyKey: `operation-${++sequence}`,
				...fields,
			},
			grant,
		);
	return { namespace, store, env, controller, repository, runtime, human, a: agent("writer-a"), b: agent("writer-b"), call };
}
export type ConvergenceRuntime = ReturnType<typeof convergenceRuntime>;

async function testCheckout(checkout: string, outcome: "pass" | "fail") {
	let output: string;
	let passed = true;
	try {
		output = (await execute(process.execPath, ["--test", "--test-reporter=tap"], { cwd: checkout })).stdout;
	} catch (error) {
		const failure = error as { stdout: string; code: number };
		assert.equal(failure.code, 1, "Expected an assertion failure, not an unavailable test runner");
		output = failure.stdout;
		passed = false;
	}
	assert.equal(passed, outcome === "pass", output);
	if (!passed) {
		assert.match(output, /not ok \d+ - retry waits two seconds/);
		assert.match(output, /expected: 2000/);
		assert.match(output, /actual: 2\b/);
		assert.match(output, /# fail 1\b/);
	}
	const retry = output.includes("retry waits two seconds");
	const tests = Number(output.match(/# tests (\d+)/)?.[1]);
	assert.equal(tests, retry ? 2 : 1, "The complete fixture suite must execute");
	const capture = `const module = await import("./src/${retry ? "retry" : "request"}.mjs");
let delay; module.${retry ? "scheduleRetry" : "scheduleRequest"}(milliseconds => { delay = milliseconds; });
console.log(delay);`;
	const observedDelayMs = Number((await execute(process.execPath, ["--input-type=module", "--eval", capture], { cwd: checkout })).stdout);
	assert.equal(observedDelayMs, retry ? (passed ? 2000 : 2) : 1000);
	// Exclude temporary paths and elapsed times from retained verification evidence.
	return { outcome, tests, expectedDelayMs: retry ? 2000 : 1000, observedDelayMs };
}

export async function runConvergenceScenario(f: ConvergenceRuntime, host: RepositoryHost) {
	const root = await mkdtemp(join(tmpdir(), "cruce-convergence-"));
	const sources: Artifact[] = [],
		evidence: Artifact[] = [],
		checks: string[] = [];
	const workspaces: { workspace: Workspace; checkout: string; grant: ConnectionGrant }[] = [];
	const progress = (check: string) => {
		checks.push(check);
	};
	const currentWorkspace = (id: string) => f.runtime.state().workspaces.find((w) => w.id === id)!;
	const readiness = (p: Proposal) => {
		const c = new RepositoryController(f.runtime.state(), CONVERGENCE_TIME, () => "read");
		return c.readiness(c.proposal(p.id));
	};
	const approve = (p: Proposal) =>
		f.call("review_proposal", {
			proposalId: p.id,
			revision: p.revision,
			outcome: "approve",
			reason: "Fixture human inspected this exact source revision",
		});
	const verify = (p: Proposal, artifact: Artifact, grant: ConnectionGrant, attested = false) =>
		f.call(
			"record_verification",
			{
				proposalId: p.id,
				revision: p.revision,
				artifactId: artifact.id,
				kind: "tests",
				outcome: "pass",
				reason: "Complete Node suite independently exercised by the scenario driver; authority is a fixture",
				humanAttested: attested,
			},
			grant,
		);
	const promote = async (p: Proposal) => {
		assert.equal(readiness(p).ready, true);
		await f.call("promote_proposal", { proposalId: p.id });
		assert.equal(await remoteHead(), p.revision);
	};
	const canonicalName = f.repository.storageName!;
	const remoteHead = async () => {
		const info = await host.info(canonicalName);
		return (
			await host.withToken(canonicalName, "read", (token) =>
				nativeGit(["ls-remote", info.remote, `refs/heads/${f.repository.defaultBranch}`], token),
			)
		).result.split(/\s/)[0];
	};
	const attach = async (title: string, baseRevision: string, grant: ConnectionGrant) => {
		const workspace = (await f.call("start_workspace", { title, baseRevision }, grant)) as Workspace;
		const fields = {
			workspaceId: workspace.id,
			idempotencyKey: `attach-${workspace.id}`,
			execution: {
				id: workspace.id,
				checkoutId: workspace.id,
				machineId: "verification",
				kind: "clone" as const,
				owned: true,
				branch: "work",
			},
		};
		for (let attempt = 0; ; attempt++) {
			try {
				await f.call("attach_workspace", fields, grant);
				break;
			} catch (error) {
				if (attempt >= 4) throw error;
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
		}
		const fork = currentWorkspace(workspace.id).fork!;
		const checkout = join(root, workspace.id);
		await host.withToken(fork.name, "read", (token) => nativeGit(["clone", fork.remote, checkout], token));
		await nativeGit(["-C", checkout, "checkout", "-b", "work", baseRevision]);
		const writer = { workspace, checkout, grant };
		workspaces.push(writer);
		return writer;
	};
	type Writer = Awaited<ReturnType<typeof attach>>;
	const commit = async (writer: Writer, overlay: string, message: string) => {
		await cp(join(fixtureRoot, overlay), writer.checkout, { recursive: true });
		await nativeGit(["-C", writer.checkout, "add", "."]);
		await nativeGit(["-C", writer.checkout, "commit", "-m", message]);
		return nativeGit(["-C", writer.checkout, "rev-parse", "HEAD"]);
	};
	const publish = async (writer: Writer, revision: string, outcome: "pass" | "fail") => {
		const report = await testCheckout(writer.checkout, outcome);
		const fork = currentWorkspace(writer.workspace.id).fork!;
		await host.withToken(fork.name, "write", (token) => nativeGit(["-C", writer.checkout, "push", "origin", "HEAD:work"], token));
		const source = (await f.call(
			"publish_revision",
			{
				workspaceId: writer.workspace.id,
				revision,
				ref: "work",
				idempotencyKey: `publish-${revision}`,
			},
			writer.grant,
		)) as Artifact;
		assert.equal(source.revision, revision);
		assert.equal(source.storage.revision, revision);
		sources.push(source);
		const proposal = (await f.call("create_proposal", { artifactId: source.id }, writer.grant)) as Proposal;
		const reportArtifact = (await f.call(
			"publish_artifact",
			{
				workspaceId: writer.workspace.id,
				revision,
				title: "Complete Node test suite",
				content: JSON.stringify({ revision, ...report }),
			},
			writer.grant,
		)) as Artifact;
		evidence.push(reportArtifact);
		await f.call(
			"record_verification",
			{
				proposalId: proposal.id,
				revision,
				kind: "tests",
				artifactId: reportArtifact.id,
				outcome,
				reason: outcome === "pass" ? "Complete suite passed" : "Clean merge schedules retry at 2 ms; expected 2000 ms",
			},
			writer.grant,
		);
		return { source, proposal, evidence: reportArtifact, report };
	};
	try {
		const provision = (await f.call("provision_repository")) as { revision: string };
		const setup = await attach("Seed timeout fixture", provision.revision, f.human);
		const s0 = await commit(setup, "baseline", "Seed timeout fixture");
		const seeded = await publish(setup, s0, "pass");
		assert.equal(await remoteHead(), provision.revision, "Publication must not advance canonical");
		await verify(seeded.proposal, seeded.evidence, f.human, true);
		await approve(seeded.proposal);
		await promote(seeded.proposal);
		progress("reviewed setup establishes S0 through real Git promotion");
		const a = await attach("Convert timeout to seconds", s0, f.a);
		const b = await attach("Add retry consumer", s0, f.b);
		const forkA = structuredClone(currentWorkspace(a.workspace.id).fork);
		const forkB = structuredClone(currentWorkspace(b.workspace.id).fork);
		assert.notEqual(forkA!.id, forkB!.id);
		assert.notEqual(f.a.actor.connectionId, f.b.actor.connectionId);
		const a1 = await commit(a, "writer-a", "Use seconds for shared timeout");
		const b1 = await commit(b, "writer-b", "Schedule retries in milliseconds");
		const originalA = await publish(a, a1, "pass"),
			originalB = await publish(b, b1, "pass");
		assert.equal(originalA.source.baseRevision, s0);
		assert.equal(originalB.source.baseRevision, s0);
		const pathsA = (await nativeGit(["-C", a.checkout, "diff", "--name-only", s0, a1])).split("\n");
		const pathsB = (await nativeGit(["-C", b.checkout, "diff", "--name-only", s0, b1])).split("\n");
		assert.equal(
			pathsA.some((path) => pathsB.includes(path)),
			false,
		);
		await approve(originalA.proposal);
		await approve(originalB.proposal);
		assert.ok(readiness(originalA.proposal).reasons.includes("Trusted passing tests evidence required"));
		assert.ok(readiness(originalB.proposal).reasons.includes("Trusted passing tests evidence required"));
		await verify(originalA.proposal, originalA.evidence, f.human, true);
		await verify(originalB.proposal, originalB.evidence, f.human, true);
		assert.equal(readiness(originalB.proposal).ready, true);
		assert.equal(await remoteHead(), s0);
		await promote(originalA.proposal);
		assert.ok(readiness(originalB.proposal).reasons.some((r) => r.includes("Base revision changed")));
		await assert.rejects(f.call("promote_proposal", { proposalId: originalB.proposal.id }), /Base revision changed/);
		progress("independent suites pass, disjoint patches, distinct forks and stale B1 review after A1 acceptance");
		const beforeFetch = currentWorkspace(b.workspace.id);
		const updates = (await f.call("get_workspace_updates", { workspaceId: b.workspace.id }, f.b)) as {
			revision: string;
			comparison: string;
		};
		assert.equal(updates.revision, a1);
		assert.equal(updates.comparison, "diverged");
		const canonical = await host.info(canonicalName);
		await nativeGit(["-C", b.checkout, "remote", "add", "canonical", canonical.remote]);
		await host.withToken(canonicalName, "read", (token) => nativeGit(["-C", b.checkout, "fetch", "canonical", "trunk"], token));
		assert.equal(await nativeGit(["-C", b.checkout, "rev-parse", "FETCH_HEAD"]), a1);
		assert.equal(await nativeGit(["-C", b.checkout, "rev-parse", "HEAD"]), b1);
		assert.deepEqual(currentWorkspace(b.workspace.id), beforeFetch);
		await nativeGit(["-C", b.checkout, "merge", "--no-ff", "-m", "Incorporate accepted A1", "FETCH_HEAD"]);
		assert.equal(await nativeGit(["-C", b.checkout, "diff", "--name-only", "--diff-filter=U"]), "");
		const merged = await nativeGit(["-C", b.checkout, "rev-parse", "HEAD"]);
		assert.equal(await nativeGit(["-C", b.checkout, "rev-list", "--parents", "-n", "1", merged]), `${merged} ${b1} ${a1}`);
		const incompatible = await publish(b, merged, "fail");
		assert.equal(incompatible.source.baseRevision, a1);
		// Deliberately supply fixture approval to prove failing evidence blocks promotion independently of the approval gate.
		await f.call("review_proposal", {
			proposalId: incompatible.proposal.id,
			revision: merged,
			outcome: "approve",
			reason: "Fixture approval exercises the failing-evidence safeguard; this source remains incorrect",
		});
		assert.deepEqual(readiness(incompatible.proposal).reasons, ["Trusted passing tests evidence required"]);
		await assert.rejects(f.call("promote_proposal", { proposalId: incompatible.proposal.id }), /Trusted passing tests evidence required/);
		assert.equal(await remoteHead(), a1);
		progress("fetch does not incorporate; clean two-parent merge fails exact 2000 ms assertion with 2 ms");
		const b2 = await commit(b, "repair", "Convert retry seconds to milliseconds");
		const repaired = await publish(b, b2, "pass");
		assert.equal(repaired.source.baseRevision, a1);
		assert.equal(repaired.proposal.base, a1);
		assert.deepEqual(repaired.proposal.reviews, []);
		await assert.rejects(
			f.call("record_verification", {
				proposalId: repaired.proposal.id,
				revision: b1,
				kind: "tests",
				outcome: "pass",
				reason: "Old test result",
			}),
			/exact revision/,
		);
		await assert.rejects(verify(repaired.proposal, originalB.evidence, f.human, true), /Evidence revision mismatch/);
		await assert.rejects(
			f.call("review_proposal", {
				proposalId: repaired.proposal.id,
				revision: b1,
				outcome: "approve",
				reason: "Old approval",
			}),
			/exact revision/,
		);
		assert.ok(readiness(repaired.proposal).reasons.includes("Trusted passing tests evidence required"));
		await verify(repaired.proposal, repaired.evidence, f.human, true);
		assert.deepEqual(readiness(repaired.proposal).reasons, ["Human approval required for this revision"]);
		await assert.rejects(f.call("promote_proposal", { proposalId: repaired.proposal.id }), /Human approval required/);
		await approve(repaired.proposal);
		await promote(repaired.proposal);
		assert.equal(await nativeGit(["-C", b.checkout, "merge-base", b1, b2]), b1);
		assert.equal(await nativeGit(["-C", b.checkout, "merge-base", a1, b2]), a1);
		assert.equal(currentWorkspace(a.workspace.id).baseRevision, s0);
		assert.equal(currentWorkspace(b.workspace.id).baseRevision, s0);
		assert.equal(currentWorkspace(b.workspace.id).integratedRevision, a1);
		assert.deepEqual(currentWorkspace(a.workspace.id).fork, forkA);
		assert.deepEqual(currentWorkspace(b.workspace.id).fork, forkB);
		assert.deepEqual(
			f.runtime.state().artifacts.find((v) => v.id === originalB.source.id),
			originalB.source,
		);
		const oldProposal = f.runtime.state().proposals.find((p) => p.id === originalB.proposal.id)!;
		assert.equal(oldProposal.base, s0);
		assert.equal(oldProposal.revision, b1);
		assert.equal(oldProposal.reviews.length, 1);
		for (const source of sources)
			assert.deepEqual(
				f.runtime.state().artifacts.find((v) => v.id === source.id),
				source,
			);
		progress("forward repair preserves published ancestry and requires new exact evidence and fresh human approval");
		const acceptedCheckout = join(root, "accepted");
		await host.withToken(canonicalName, "read", (token) => nativeGit(["clone", canonical.remote, acceptedCheckout], token));
		assert.equal(await nativeGit(["-C", acceptedCheckout, "rev-parse", "HEAD"]), b2);
		await testCheckout(acceptedCheckout, "pass");
		for (const writer of workspaces) {
			await f.call("end_workspace", { workspaceId: writer.workspace.id }, writer.grant);
			for (let attempt = 0; ; attempt++) {
				const cleanup = (await f.call(
					"cleanup_workspace",
					{
						workspaceId: writer.workspace.id,
						idempotencyKey: `cleanup-${writer.workspace.id}`,
					},
					writer.grant,
				)) as { state: string };
				if (cleanup.state === "deleted") break;
				if (attempt >= 10) throw new Error("Fork deletion still pending");
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
			assert.equal(currentWorkspace(writer.workspace.id).fork!.state, "deleted");
		}
		// Ordinary Git retrieves named immutable refs even when the artifact repository has an unborn default HEAD.
		const retained = join(root, "retained.git");
		await nativeGit(["init", "--bare", retained]);
		for (const artifact of [...sources, ...evidence]) {
			const info = await host.info(artifact.storage.repository);
			const ref = `refs/heads/${artifact.id}`;
			await host.withToken(info.name, "read", (token) =>
				nativeGit(["--git-dir", retained, "fetch", info.remote, `${artifact.storage.ref}:${ref}`], token),
			);
			assert.equal(await nativeGit(["--git-dir", retained, "rev-parse", ref]), artifact.storage.revision);
			const content = await nativeGit([
				"--git-dir",
				retained,
				"show",
				`${artifact.storage.revision}:${artifact.storage.path ?? "src/request.mjs"}`,
			]);
			if (artifact.kind === "evidence") assert.equal(JSON.parse(content).revision, artifact.revision);
			else assert.ok(content.includes("scheduleRequest"));
		}
		assert.equal(
			await nativeGit(["--git-dir", retained, "show", `${b2}:src/retry.mjs`]),
			(await readFile(join(fixtureRoot, "repair/src/retry.mjs"), "utf8")).trim(),
		);
		assert.equal(await remoteHead(), b2);
		assert.equal(f.controller.state.reservations.length, CONVERGENCE_BUDGET);
		assert.ok(f.controller.state.reservations.every((r) => r.state === "complete"));
		progress("canonical independently verified; all five source/evidence pairs survive three fork cleanups within 20 reservations");
		return {
			namespace: f.namespace,
			authority: "in-process fixture grants and human attestation",
			revisions: { s0, a1, b1, merged, b2 },
			behavior: { independentA: originalA.report, independentB: originalB.report, merged: incompatible.report, repaired: repaired.report },
			checks,
			sources,
			evidence,
			workspaces: f.runtime.state().workspaces,
			proposals: f.runtime.state().proposals,
			verifications: f.runtime.state().verifications,
			promotions: f.runtime.state().promotions,
			reservations: f.controller.state.reservations,
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
