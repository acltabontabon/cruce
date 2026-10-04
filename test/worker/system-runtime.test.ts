import { describe, expect, it, vi } from "vitest";
import { CommandInput, type SystemConnection } from "../../src/shared/coordination.ts";
import { type Actor, type Artifact, PlatformCommandInput, type Proposal } from "../../src/shared/platform.ts";
import type { ArtifactsHost } from "../../src/worker/artifacts-host.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { SystemRuntime } from "../../src/worker/system-runtime.ts";
import type { TowerStore } from "../../src/worker/tower.ts";

async function setup() {
	const data = new Map<string, unknown>(),
		store: TowerStore = {
			get: <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
			put: (k, v) => {
				data.set(k, structuredClone(v));
			},
			delete: (k) => {
				data.delete(k);
			},
			appendEvents: () => {},
		};
	const git = new GitWorkspace(new MemoryFs() as never, "/native.git"),
		repos = new Map<string, { name: string; remote: string; description: string; head?: string }>();
	const host = {
		ensure: vi.fn(async (name: string, description: string) => {
			const old = repos.get(name);
			if (old) return { ...old, created: false };
			const r = { name, description, remote: `https://artifacts.test/${name}` };
			repos.set(name, r);
			return { ...r, created: true };
		}),
		info: vi.fn(async (name: string) => {
			const r = repos.get(name);
			if (!r) throw new Error("not found");
			return r;
		}),
		find: vi.fn(async (name: string) => repos.get(name)),
		log: vi.fn(async (name: string) => (repos.get(name)?.head ? [{ hash: repos.get(name)!.head }] : [])),
		fork: vi.fn(async (source: string, name: string, description: string) => {
			const old = repos.get(name);
			if (old) return { ...old, created: false };
			const r = { name, remote: `https://artifacts.test/${name}`, description, head: repos.get(source)?.head };
			repos.set(name, r);
			return { ...r, created: true };
		}),
		withToken: vi.fn(async (_name: string, _scope: string, fn: (token: string) => Promise<unknown>) => ({
			result: await fn("short-lived-fixture"),
			tokenId: "revoked-fixture",
		})),
	};
	const push = vi.spyOn(git, "push").mockImplementation(async (input) => {
		const name = input.url.split("/").at(-1)!;
		const r = repos.get(name)!;
		r.head = (await git.resolve(input.localRef))!;
		return {} as never;
	});
	vi.spyOn(git, "fetch").mockImplementation(async (input) => {
		const r = repos.get(input.url.split("/").at(-1)!);
		if (r?.head) await git.setRef(input.localRef, r.head);
		return r?.head ?? null;
	});
	const system: SystemConnection = {
		id: "native-system",
		tenantId: "tenant",
		name: "Payments",
		artifactRepository: "native-payments",
		active: true,
		version: 1,
		capabilities: ["managed_artifacts", "intent_mcp", "native_promotion"],
		policy: { mode: "enforced", semantic: "off" },
	};
	const runtime = new SystemRuntime(
		store,
		git,
		system,
		host as unknown as ArtifactsHost,
		() => {},
		() => 1700000000000,
	);
	await runtime.initialize();
	const human: Actor = {
			developerId: "owner",
			tenantId: "tenant",
			systemIds: [system.id],
			maintainer: true,
			canWrite: true,
			kind: "human",
		},
		agent: Actor = { ...human, kind: "agent" };
	let count = 0;
	const command = (tool: typeof PlatformCommandInput._output.tool, fields: Record<string, unknown> = {}) =>
		PlatformCommandInput.parse({ tool, systemId: system.id, idempotencyKey: `op-${++count}`, ...fields });
	return { runtime, git, push, store, system, human, agent, host, repos, command };
}
async function source() {
	const x = await setup(),
		base = x.runtime.coordination.state().system.canonicalHead!;
	const i = (await x.runtime.command(
		x.command("create_intent", { title: "Retry payment", context: "Retries preserve idempotency" }),
		x.human,
	)) as { id: string };
	const m = (await x.runtime.command(
		x.command("create_mission", {
			intentId: i.id,
			plan: {
				summary: "Retry",
				intent: "Implement retry",
				writeSet: [{ type: "file", resource: "src/pay.ts" }],
				contractSet: [{ resource: "pay", change: "signature" }],
			},
		}),
		x.agent,
	)) as { id: string; version: number };
	const accepted = (await x.runtime.command(
		x.command("accept_mission", {
			missionId: m.id,
			expectedVersion: m.version,
			workspace: {
				id: "local",
				checkoutId: "local",
				branch: "local",
				base,
				head: base,
				isolation: "isolated",
				precision: "symbols",
				capabilities: ["intent_mcp"],
			},
			agent: { tool: "codex", instance: "one", role: "writer" },
		}),
		x.agent,
	)) as { mission: { id: string; version: number }; coordination: { sessionId: string; planVersion: number; workstreamId: string } };
	const publication = x.command("publish_source", {
		missionId: m.id,
		expectedVersion: accepted.mission.version,
		expectedPlanVersion: accepted.coordination.planVersion,
		sessionId: accepted.coordination.sessionId,
		base,
		files: { "src/pay.ts": "export function pay(id:string){return id;}\n" },
		summary: "Idempotent payment",
	});
	const output = (await x.runtime.command(publication, x.agent)) as { artifact: Artifact };
	return { ...x, base, i, m: accepted.mission, accepted, publication, output };
}

async function promoteSource(x: Awaited<ReturnType<typeof source>>, artifact: Artifact, missionId: string) {
	const m = x.runtime.state().missions.find((m) => m.id === missionId)!;
	const evidence = (await x.runtime.command(
		x.command("publish_artifact", {
			missionId,
			expectedVersion: m.version,
			kind: "test_report",
			content: "Inspected test fixture",
			revision: artifact.revision,
		}),
		x.agent,
	)) as Artifact;
	const p = (await x.runtime.command(x.command("create_proposal", { missionId, artifactId: artifact.id }), x.agent)) as Proposal;
	await x.runtime.command(
		x.command("attach_verification", {
			proposalId: p.id,
			expectedVersion: p.version,
			verificationKind: "tests",
			outcome: "pass",
			related: [evidence.id],
		}),
		x.human,
	);
	await x.runtime.command(
		x.command("review_proposal", {
			proposalId: p.id,
			expectedVersion: x.runtime.state().proposals.find((other) => other.id === p.id)!.version,
			outcome: "approve",
			summary: "Reviewed exact source and test evidence",
		}),
		x.human,
	);
	const cmd = x.command("promote_proposal", {
		proposalId: p.id,
		expectedVersion: x.runtime.state().proposals.find((other) => other.id === p.id)!.version,
	});
	return x.runtime.command(cmd, x.human);
}
describe("native Artifacts collaboration", () => {
	it("publishes an inspectable source artifact without changing accepted source", async () => {
		const x = await source();
		expect(x.runtime.coordination.state().system.canonicalHead).toBe(x.base);
		expect(x.output.artifact.revision).not.toBe(x.base);
		expect(x.output.artifact.storage.repository).toContain("--w-");
		expect(await x.git.readFiles(x.output.artifact.revision)).toHaveProperty("src/pay.ts");
		expect(await x.runtime.command(x.publication, x.agent)).toEqual(x.output);
		expect(x.host.fork).toHaveBeenCalledTimes(1);
	});
	it("keeps source, evidence, review and promotion in one causal history", async () => {
		const x = await source();
		const artifact = (await x.runtime.command(
			x.command("publish_artifact", {
				missionId: x.m.id,
				expectedVersion: x.m.version,
				kind: "test_report",
				title: "Retry test run",
				content: "Assertions: passed",
				revision: x.output.artifact.revision,
				related: [x.output.artifact.id],
			}),
			x.agent,
		)) as Artifact;
		const p = (await x.runtime.command(
			x.command("create_proposal", { missionId: x.m.id, artifactId: x.output.artifact.id, impact: "No new dependencies" }),
			x.agent,
		)) as Proposal;
		await expect(
			x.runtime.command(x.command("promote_proposal", { proposalId: p.id, expectedVersion: p.version }), x.agent),
		).rejects.toThrow("agents cannot promote");
		await x.runtime.command(
			x.command("attach_verification", {
				proposalId: p.id,
				expectedVersion: p.version,
				verificationKind: "tests",
				outcome: "pass",
				summary: "Human inspected the test report",
				related: [artifact.id],
			}),
			x.human,
		);
		let current = x.runtime.state().proposals[0];
		await x.runtime.command(
			x.command("review_proposal", {
				proposalId: p.id,
				expectedVersion: current.version,
				outcome: "approve",
				summary: "Reviewed source and report",
			}),
			x.human,
		);
		current = x.runtime.state().proposals[0];
		const promote = x.command("promote_proposal", { proposalId: p.id, expectedVersion: current.version }),
			put = x.store.put.bind(x.store);
		let interrupted = false;
		vi.spyOn(x.store, "put").mockImplementation((key, value) => {
			if (
				key === "platform" &&
				(value as { promotions?: { state: string }[] }).promotions?.some((p) => p.state === "complete") &&
				!interrupted
			) {
				interrupted = true;
				throw new Error("simulated promotion crash");
			}
			put(key, value);
		});
		await expect(x.runtime.command(promote, x.human)).rejects.toThrow("promotion crash");
		const ticket = (await x.runtime.command(promote, x.human)) as { state: string; to: string };
		expect(await x.runtime.command(promote, x.human)).toEqual(ticket);

		expect(ticket.state).toBe("complete");
		expect(x.runtime.coordination.state().system.canonicalHead).toBe(x.output.artifact.revision);
		expect(x.repos.get("native-payments")?.head).toBe(ticket.to);
		expect(x.runtime.state().timeline.map((e) => e.kind)).toEqual(
			expect.arrayContaining(["intent", "mission", "execution", "artifact", "proposal", "verification", "review", "promotion"]),
		);
		expect(x.push.mock.calls.every((c) => c[0].force !== true)).toBe(true);
	});
	it("rejects scope expansion at the managed boundary", async () => {
		const x = await source();
		const r = x.runtime.coordination.snapshot(x.agent).managed[0];
		await expect(
			x.runtime.command(
				x.command("publish_source", {
					missionId: x.m.id,
					expectedVersion: x.m.version,
					expectedPlanVersion: 1,
					sessionId: x.accepted.coordination.sessionId,
					base: r.head,
					files: { "unsafe.py": "danger = True\n" },
				}),
				x.agent,
			),
		).rejects.toThrow("REPLAN");
		expect(x.repos.get(r.repository)?.head).toBe(x.output.artifact.revision);
	});
	it("recovers publication receipts after a crash without generating another revision", async () => {
		const x = await source(),
			record = x.runtime.coordination.snapshot(x.agent).managed[0],
			cmd = x.command("publish_source", {
				missionId: x.m.id,
				expectedVersion: x.m.version,
				expectedPlanVersion: 1,
				sessionId: x.accepted.coordination.sessionId,
				base: record.head,
				files: { "src/pay.ts": "export function pay(id:string){return id + ''; }\n" },
			});
		const put = x.store.put.bind(x.store);
		let interrupted = false;
		vi.spyOn(x.store, "put").mockImplementation((key, value) => {
			if (key === "platform" && !interrupted) {
				interrupted = true;
				throw new Error("simulated process restart");
			}
			put(key, value);
		});
		await expect(x.runtime.command(cmd, x.agent)).rejects.toThrow("restart");
		const durable = x.runtime.coordination.snapshot(x.agent).managed[0].head;
		const receipt = (await x.runtime.command(cmd, x.agent)) as { artifact: Artifact };
		expect(receipt.artifact.revision).toBe(durable);
		expect(await x.runtime.command(cmd, x.agent)).toEqual(receipt);
		await expect(x.runtime.command({ ...cmd, summary: "Changed inputs" }, x.agent)).rejects.toThrow("Idempotency");
	});
	it("detects external accepted-source movement without promoting it", async () => {
		const x = await source();
		x.repos.get(x.system.artifactRepository)!.head = x.output.artifact.revision;
		expect(await x.runtime.verifySource()).toMatchObject({ state: "unexpected_revision" });
		expect(x.runtime.coordination.state().system.canonicalHead).toBe(x.base);
		expect(x.runtime.state().promotions).toHaveLength(0);
	});

	it("refreshes two native missions while preserving independent work and one fork each", async () => {
		const x = await source(),
			plan = {
				summary: "Retry API",
				intent: "Expose retry status",
				writeSet: [{ type: "file", resource: "src/response.ts" }],
				readSet: [{ type: "file", resource: "src/pay.ts" }],
				contractSet: [{ resource: "PaymentResponse", change: "signature" }],
			};
		const m = (await x.runtime.command(x.command("create_mission", { intentId: x.i.id, plan }), x.agent)) as {
			id: string;
			version: number;
		};
		const accepted = (await x.runtime.command(
			x.command("accept_mission", {
				missionId: m.id,
				expectedVersion: m.version,
				workspace: {
					id: "api",
					checkoutId: "api",
					branch: "api",
					base: x.base,
					head: x.base,
					isolation: "isolated",
					precision: "symbols",
					capabilities: ["intent_mcp"],
				},
				agent: { tool: "claude", instance: "api", role: "writer" },
			}),
			x.agent,
		)) as { mission: { version: number }; coordination: { workstreamId: string; sessionId: string; working: string; cleared: string[] } };
		expect(accepted.coordination.working).toBe("PROCEED");
		expect(accepted.coordination.cleared).toContain("f:src/response.ts");
		const published = (await x.runtime.command(
			x.command("publish_source", {
				missionId: m.id,
				expectedVersion: accepted.mission.version,
				expectedPlanVersion: 1,
				sessionId: accepted.coordination.sessionId,
				base: x.base,
				files: { "src/response.ts": "export interface PaymentResponse { id: string }\n" },
			}),
			x.agent,
		)) as { artifact: Artifact };
		expect(
			x.runtime.coordination.state().workstreams.find((w) => w.id === x.accepted.coordination.workstreamId)!.staleRevision,
			"implementation unexpectedly stale",
		).toBeUndefined();
		await promoteSource(x, x.output.artifact, x.m.id);
		const work = x.runtime.coordination.state().workstreams.find((w) => w.id === accepted.coordination.workstreamId)!;
		expect(work.staleRevision).toBe(x.output.artifact.revision);
		expect(work.instructions.some((i) => i.kind === "refresh" && !i.resolvedAt)).toBe(true);
		await x.runtime.coordination.command(
			CommandInput.parse({
				tool: "update_intent",
				systemId: x.system.id,
				idempotencyKey: "api-refresh",
				workstreamId: work.id,
				sessionId: accepted.coordination.sessionId,
				expectedVersion: work.version,
				expectedPlanVersion: 1,
				plan,
				workspace: {
					id: "api",
					checkoutId: "api",
					branch: "api",
					base: x.output.artifact.revision,
					head: published.artifact.revision,
					isolation: "isolated",
					precision: "symbols",
					capabilities: ["intent_mcp"],
				},
			}),
			x.agent,
		);
		const refreshed = (await x.runtime.command(
			x.command("publish_source", {
				missionId: m.id,
				expectedVersion: accepted.mission.version,
				expectedPlanVersion: 2,
				sessionId: accepted.coordination.sessionId,
				base: published.artifact.revision,
				files: { "src/response.ts": "export interface PaymentResponse { id: string; retry: number }\n" },
			}),
			x.agent,
		)) as { artifact: Artifact };
		expect(refreshed.artifact.parentRevision).toBe(x.output.artifact.revision);
		expect(await x.git.mergeBase(refreshed.artifact.revision, published.artifact.revision)).toBe(published.artifact.revision);
		expect(await x.git.mergeBase(refreshed.artifact.revision, x.output.artifact.revision)).toBe(x.output.artifact.revision);
		const files = await x.git.readFiles(refreshed.artifact.revision);
		expect(files).toHaveProperty("src/pay.ts");
		expect(files["src/response.ts"]).toContain("retry: number");
		expect(
			x.runtime.coordination.state().workstreams.find((w) => w.id === accepted.coordination.workstreamId)!.staleRevision,
			"API unexpectedly stale",
		).toBeUndefined();
		await promoteSource(x, refreshed.artifact, m.id);
		expect(x.runtime.coordination.state().system.canonicalHead).toBe(refreshed.artifact.revision);
		expect(x.host.fork).toHaveBeenCalledTimes(2);
		expect(
			x.runtime
				.state()
				.artifacts.filter((a) => a.missionId === m.id && a.kind === "source")
				.every((a) => a.producer.tool === "claude"),
		).toBe(true);
	});

	it("exports accepted source as real Git objects and preserves exact revisions", async () => {
		const x = await source();
		const target = new GitWorkspace(new MemoryFs() as never, "/export.git");
		await target.ensureInit();
		await target.importPack(await x.git.exportPack(x.base));
		expect(await target.readFiles(x.base)).toHaveProperty("README.md");
	});
	it("isolates unauthorized human and agent identities", async () => {
		const x = await setup();
		await expect(
			x.runtime.command(x.command("create_intent", { title: "Unauthorized", context: "test" }), { ...x.agent, tenantId: "other" }),
		).rejects.toThrow("access denied");
		await expect(
			x.runtime.command(x.command("create_intent", { title: "Unauthorized", context: "test" }), { ...x.agent, canWrite: false }),
		).rejects.toThrow("permission");
	});
});
