import { describe, expect, it, vi } from "vitest";
import { CommandInput, type ProjectConnection } from "../../src/shared/coordination.ts";
import {
	type Actor,
	type Artifact,
	type Deployment,
	type Mission,
	PlatformCommandInput,
	type Proposal,
} from "../../src/shared/platform.ts";
import type { ArtifactsHost } from "../../src/worker/artifacts-host.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { ProjectRuntime, type RuntimeOptions } from "../../src/worker/project-runtime.ts";
import type { TowerStore } from "../../src/worker/tower.ts";

async function setup(options: RuntimeOptions = {}) {
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
	const project: ProjectConnection = {
		id: "native-project",
		tenantId: "tenant",
		name: "Payments",
		artifactRepository: "native-payments",
		active: true,
		version: 1,
		capabilities: ["managed_artifacts", "intent_mcp", "native_promotion"],
		policy: { mode: "enforced", semantic: "off" },
	};
	const runtime = new ProjectRuntime(
		store,
		git,
		project,
		host as unknown as ArtifactsHost,
		() => {},
		() => 1700000000000,
		undefined,
		options,
	);
	await runtime.initialize();
	expect(host.ensure).not.toHaveBeenCalled();
	const human: Actor = {
			developerId: "owner",
			tenantId: "tenant",
			projectIds: [project.id],
			maintainer: true,
			canWrite: true,
			kind: "human",
		},
		agent: Actor = { ...human, kind: "agent" };
	await runtime.provision(human);
	let count = 0;
	const command = (tool: typeof PlatformCommandInput._output.tool, fields: Record<string, unknown> = {}) =>
		PlatformCommandInput.parse({ tool, projectId: project.id, idempotencyKey: `op-${++count}`, ...fields });
	return { runtime, git, push, store, project, human, agent, host, repos, command };
}
async function source(options: RuntimeOptions = {}, extra: Record<string, string> = {}) {
	const x = await setup(options),
		base = x.runtime.coordination.state().project.canonicalHead!;
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
				writeSet: [
					{ type: "file", resource: "src/pay.ts" },
					...Object.keys(extra).map((resource) => ({ type: "file" as const, resource })),
				],
				contractSet: [{ resource: "pay", change: "signature" }],
			},
		}),
		x.agent,
	)) as { id: string; version: number };
	const accepted = (await x.runtime.command(
		x.command("start_mission", {
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
	const publication = x.command("publish_revision", {
		missionId: m.id,
		expectedVersion: accepted.mission.version,
		expectedPlanVersion: accepted.coordination.planVersion,
		sessionId: accepted.coordination.sessionId,
		base,
		files: { "src/pay.ts": "export function pay(id:string){return id;}\n", ...extra },
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
		x.command("attach_evidence", {
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
		expect(x.runtime.coordination.state().project.canonicalHead).toBe(x.base);
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
			x.command("attach_evidence", {
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
		expect(x.runtime.coordination.state().project.canonicalHead).toBe(x.output.artifact.revision);
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
				x.command("publish_revision", {
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
			cmd = x.command("publish_revision", {
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
		x.repos.get(x.project.artifactRepository)!.head = x.output.artifact.revision;
		expect(await x.runtime.verifySource()).toMatchObject({ state: "unexpected_revision" });
		expect(x.runtime.coordination.state().project.canonicalHead).toBe(x.base);
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
			x.command("start_mission", {
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
			x.command("publish_revision", {
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
				projectId: x.project.id,
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
			x.command("publish_revision", {
				missionId: m.id,
				expectedVersion: accepted.mission.version,
				expectedPlanVersion: 2,
				sessionId: accepted.coordination.sessionId,
				base: published.artifact.revision,
				files: { "src/response.ts": "export interface PaymentResponse { id: string; retry: number }\n" },
			}),
			x.agent,
		)) as { artifact: Artifact };
		expect(refreshed.artifact.source?.base).toBe(x.output.artifact.revision);
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
		expect(x.runtime.coordination.state().project.canonicalHead).toBe(refreshed.artifact.revision);
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

describe("Git revisions and project source", () => {
	it("never creates repositories when an unprovisioned project is read", async () => {
		const x = await setup();
		const empty = new Map<string, unknown>();
		const store = {
			get: (k: string) => empty.get(k),
			put: (k: string, v: unknown) => void empty.set(k, v),
			delete: (k: string) => void empty.delete(k),
			appendEvents: () => {},
		};
		const git = new GitWorkspace(new MemoryFs() as never, "/u.git");
		const push = vi.spyOn(git, "push").mockResolvedValue({} as never);
		const unprovisioned = new ProjectRuntime(
			store as never,
			git,
			{ ...x.project, id: "u", artifactRepository: "u" },
			x.host as never,
			() => {},
		);
		x.host.ensure.mockClear();
		await unprovisioned.initialize();
		expect(unprovisioned.snapshot(x.human)).toMatchObject({ provisioned: false });
		await expect(unprovisioned.command(x.command("get_project"), x.agent)).rejects.toThrow("not provisioned");
		await expect(unprovisioned.provision(x.agent)).rejects.toThrow("Human maintainer");
		expect(x.host.ensure).not.toHaveBeenCalled();
		await unprovisioned.provision(x.human);
		expect(x.host.ensure).toHaveBeenCalledWith("u", "Cruce project u");
		expect(push).toHaveBeenCalledWith(expect.objectContaining({ remoteRef: "refs/heads/main", force: false }));
		expect(unprovisioned.snapshot({ ...x.human, projectIds: ["u"] })).toMatchObject({
			provisioned: true,
			source: { name: "u", backend: "cloudflare_artifacts" },
		});
	});
	it("publishes real local commits as the exact revision the agent produced", async () => {
		const x = await source();
		const record = x.runtime.coordination.snapshot(x.agent).managed[0];
		const local = new GitWorkspace(new MemoryFs() as never, "/local.git");
		await local.ensureInit();
		await local.importPack(await x.git.exportPack(record.head));
		const commit = await local.commit({
			ref: "refs/heads/main",
			parent: record.head,
			files: { "src/pay.ts": "export function pay(id: string) {\n\treturn String(id);\n}\n" },
			message: "Use a template literal for payment ids",
			author: { name: "Developer", email: "dev@example.com", timestamp: 1700000100 },
		});
		const pack = Buffer.from(await local.exportPack(commit, record.head)).toString("base64");
		const publish = (base: string) =>
			x.command("publish_revision", {
				missionId: x.m.id,
				expectedVersion: x.m.version,
				expectedPlanVersion: 1,
				sessionId: x.accepted.coordination.sessionId,
				base,
				revision: commit,
				pack,
			});
		await expect(x.runtime.command(publish(x.base), x.agent)).rejects.toThrow("Workspace source changed");
		const out = (await x.runtime.command(publish(record.head), x.agent)) as { artifact: Artifact; revision: string };
		expect(out.revision).toBe(commit);
		expect(out.artifact).toMatchObject({ revision: commit, parentRevision: record.head, trust: "verified" });
		expect(out.artifact.source?.commits.map((c) => c.oid)).toEqual([commit, record.head]);
		expect(out.artifact.source?.base).toBe(x.base);
		expect(x.repos.get(record.repository)?.head).toBe(commit);
		expect(x.runtime.state().missions.find((m) => m.id === x.m.id)?.headRevision).toBe(commit);
		const p = (await x.runtime.command(
			x.command("create_proposal", { missionId: x.m.id, artifactId: out.artifact.id }),
			x.agent,
		)) as Proposal;
		expect(p).toMatchObject({ base: x.base, revision: commit, repository: record.repository, commits: 2, files: 1, number: 1 });
	});
	it("keeps cloud AI analysis off until project resource policy allows it", async () => {
		const x = await setup();
		expect(x.runtime.coordination.inferenceAllowed()).toBe(false);
		await x.runtime.command(
			x.command("set_policy", {
				expectedVersion: 1,
				reason: "Enable semantic analysis",
				policy: { approvals: 1, requiredEvidence: ["tests"], resources: { rules: { "ai.inference": "allow" } } },
			}),
			x.human,
		);
		expect(x.runtime.coordination.inferenceAllowed()).toBe(true);
		await expect(
			x.runtime.command(
				x.command("set_policy", { expectedVersion: 2, reason: "x", policy: { approvals: 1, requiredEvidence: ["tests"] } }),
				x.agent,
			),
		).rejects.toThrow("Human maintainer");
	});
	it("starts missions only from accepted revisions", async () => {
		const x = await source();
		const stray = await x.git.commit({
			ref: "refs/test/stray",
			parent: null,
			files: { "x.ts": "x" },
			message: "stray",
			author: { name: "a", email: "a@b.c", timestamp: 1 },
		});
		const m = (await x.runtime.command(
			x.command("create_mission", {
				intentId: x.i.id,
				plan: { summary: "Other", intent: "Other", writeSet: [{ type: "file", resource: "x.ts" }] },
			}),
			x.agent,
		)) as Mission;
		const workspace = {
			id: "w",
			checkoutId: "w",
			branch: "w",
			base: stray,
			head: stray,
			isolation: "isolated",
			precision: "symbols",
			capabilities: ["intent_mcp"],
		};
		await expect(
			x.runtime.command(
				x.command("start_mission", {
					missionId: m.id,
					expectedVersion: m.version,
					workspace,
					agent: { tool: "codex", instance: "2", role: "writer" },
				}),
				x.agent,
			),
		).rejects.toThrow("not an accepted revision");
	});
});

describe("Worker preview, verification and production lineage", () => {
	const account = {
		mode: "operator",
		accountId: "a".repeat(32),
		label: "fixture",
		credential: "stored",
		capabilities: ["artifacts", "builds"],
	};
	async function worker(rules: Record<string, string> = {}) {
		const sent: string[] = [],
			orchestrated: string[] = [];
		const builds = {
			scriptTag: vi.fn(async () => "tag-1"),
			buildFor: vi.fn(async (_tag: string, revision: string, branch: string) => ({
				build_uuid: `build-${branch}`,
				status: "stopped",
				build_outcome: "success",
				preview_url: branch === "main" ? null : "https://p-1-customer-api.example.workers.dev",
				build_trigger_metadata: { commit_hash: revision, branch },
			})),
		};
		let host: unknown;
		const resources = { account: () => account, host: async () => host, builds: async () => builds };
		const x = await source(
			{
				resources: resources as never,
				orchestrate: async (id) => void orchestrated.push(id),
				send: async (url) => {
					sent.push(String(url));
					return new Response("ok", { status: 200 });
				},
			},
			{ "wrangler.jsonc": '{ "name": "customer-api", "main": "src/pay.ts" }' },
		);
		host = x.host;
		await x.runtime.command(
			x.command("configure_environment", {
				environment: { kind: "cloudflare_worker", workerName: "customer-api", smokePaths: ["/", "/health"] },
			}),
			x.human,
		);
		if (Object.keys(rules).length)
			await x.runtime.command(
				x.command("set_policy", {
					expectedVersion: 1,
					reason: "Cost control",
					policy: { approvals: 1, requiredEvidence: ["tests"], resources: { rules } },
				}),
				x.human,
			);
		const p = (await x.runtime.command(
			x.command("create_proposal", { missionId: x.m.id, artifactId: x.output.artifact.id }),
			x.agent,
		)) as Proposal;
		return { ...x, p, sent, orchestrated, builds };
	}
	it("deploys a preview of the exact proposed revision and records runtime-verified smoke evidence", async () => {
		const x = await worker();
		expect(x.runtime.state().environments.map((e) => e.kind)).toEqual(["preview", "production"]);
		await expect(
			x.runtime.command(x.command("configure_environment", { environment: { kind: "external", description: "k8s" } }), x.agent),
		).rejects.toThrow("Human maintainer");
		const r = (await x.runtime.command(x.command("request_preview", { proposalId: x.p.id }), x.agent)) as {
			deployment: Deployment;
			cost: string;
		};
		expect(r.cost).toBe("Metered Cloudflare operation");
		expect(r.deployment).toMatchObject({ state: "building", revision: x.p.revision, branch: "cruce/proposal-1" });
		expect(x.orchestrated).toEqual([r.deployment.id]);
		expect(x.repos.get("native-payments--deploy")?.head).toBe(x.p.revision);
		expect(await x.runtime.deploymentTick(r.deployment.id)).toBe("deployed");
		expect(x.sent).toEqual(["https://p-1-customer-api.example.workers.dev/", "https://p-1-customer-api.example.workers.dev/health"]);
		const state = x.runtime.state();
		expect(state.verifications.find((v) => v.kind === "preview")).toMatchObject({
			trust: "runtime_verified",
			revision: x.p.revision,
			outcome: "pass",
			deploymentId: r.deployment.id,
		});
		expect(state.artifacts.find((a) => a.kind === "preview_report")).toMatchObject({
			trust: "verified",
			execution: { location: "cloudflare" },
		});
		expect(await x.runtime.deploymentTick(r.deployment.id)).toBe("deployed");
		const again = (await x.runtime.command(x.command("request_preview", { proposalId: x.p.id }), x.agent)) as { deployment: Deployment };
		expect(again.deployment.id).toBe(r.deployment.id);
	});
	it("requires a human for metered previews when policy says so", async () => {
		const x = await worker({ "preview.deploy": "approval" });
		const r = (await x.runtime.command(x.command("request_preview", { proposalId: x.p.id }), x.agent)) as {
			resourceRequest: { id: string; state: string };
			nextAction: string;
		};
		expect(r.resourceRequest.state).toBe("pending");
		expect(r.nextAction).toContain("may consume Cloudflare resources");
		expect(x.orchestrated).toEqual([]);
		const decided = (await x.runtime.command(
			x.command("decide_resource_request", { requestId: r.resourceRequest.id, decision: "approve", reason: "Needed for review" }),
			x.human,
		)) as {
			request: { state: string };
			deployment: Deployment;
		};
		expect(decided.request.state).toBe("executed");
		expect(decided.deployment.requestId).toBe(r.resourceRequest.id);
		expect(x.orchestrated).toEqual([decided.deployment.id]);
	});
	it("promotes and deploys production by one human decision, then explains and performs a rollback", async () => {
		const x = await worker();
		const evidence = (await x.runtime.command(
			x.command("publish_artifact", {
				missionId: x.m.id,
				expectedVersion: x.m.version,
				kind: "test_report",
				content: "12 passed",
				revision: x.p.revision,
			}),
			x.agent,
		)) as Artifact;
		const version = () => x.runtime.state().proposals.find((p) => p.id === x.p.id)!.version;
		await x.runtime.command(
			x.command("attach_evidence", {
				proposalId: x.p.id,
				expectedVersion: version(),
				verificationKind: "tests",
				outcome: "pass",
				related: [evidence.id],
			}),
			x.human,
		);
		await x.runtime.command(
			x.command("review_proposal", { proposalId: x.p.id, expectedVersion: version(), outcome: "approve", summary: "Reviewed" }),
			x.human,
		);
		await expect(x.runtime.command(x.command("deploy_revision", { revision: x.p.revision }), x.agent)).rejects.toThrow("Human maintainer");
		const promoted = (await x.runtime.command(
			x.command("promote_proposal", { proposalId: x.p.id, expectedVersion: version(), deploy: true }),
			x.human,
		)) as {
			promotion: { state: string; deploy: boolean };
			deployment: Deployment;
		};
		expect(promoted.promotion).toMatchObject({ state: "complete", deploy: true });
		expect(promoted.deployment).toMatchObject({ branch: "main", revision: x.p.revision, proposalId: x.p.id, state: "building" });
		expect(await x.runtime.deploymentTick(promoted.deployment.id)).toBe("deployed");
		expect(x.runtime.state().deployments.find((d) => d.id === promoted.deployment.id)).toMatchObject({ state: "deployed", url: undefined });
		const lineage = (await x.runtime.command(x.command("get_lineage", { subjectId: promoted.deployment.id }), x.agent)) as {
			intents: { title: string }[];
			missions: { title: string; agent?: { tool: string } }[];
			proposals: { id: string }[];
		};
		expect(lineage.intents.map((i) => i.title)).toEqual(["Retry payment"]);
		expect(lineage.missions[0].agent?.tool).toBe("codex");
		const rollback = (await x.runtime.command(x.command("plan_rollback", { revision: x.base }), x.human)) as {
			removes: { number: number }[];
			current: string;
		};
		expect(rollback.current).toBe(x.p.revision);
		expect(rollback.removes.map((r) => r.number)).toEqual([1]);
		const restored = (await x.runtime.command(x.command("deploy_revision", { revision: x.base }), x.human)) as Deployment;
		expect(restored).toMatchObject({ revision: x.base, rollbackOf: x.p.revision, previous: x.p.revision, branch: "main" });
		expect(x.repos.get("native-payments--deploy")?.head).toBe(x.base);
		expect(x.runtime.coordination.state().project.canonicalHead).toBe(x.p.revision);
	});
});
