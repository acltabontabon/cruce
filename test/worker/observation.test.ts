import { describe, expect, it, vi } from "vitest";
import { initialNamespace, NamespaceController } from "../../src/core/ownership.ts";
import { initialRepository, RepositoryController } from "../../src/core/platform.ts";
import type { Actor, Repository, Workspace } from "../../src/shared/platform.ts";
import type { RepositoryHost } from "../../src/worker/artifacts.ts";
import { MemoryFs } from "../../src/worker/git/memory-fs.ts";
import { GitWorkspace } from "../../src/worker/git/workspace.ts";
import { OBSERVATION_INTERVAL, Observation, type ObservationRoute, pushSignal } from "../../src/worker/observation.ts";
import { observationQueue } from "../../src/worker/observation-queue.ts";
import { ObservationSubscriptions, type Subscription } from "../../src/worker/observation-subscriptions.ts";
import { memoryStore } from "../../src/worker/store.ts";

const owner: Actor = { id: "owner", userId: "owner", name: "Owner", kind: "human" };
const A = "a".repeat(40),
	B = "b".repeat(40);
function fixture(count = 1) {
	let now = 1000,
		denied = false,
		remote = A;
	const state = initialRepository({
		id: "repo",
		namespaceId: "ns",
		name: "repo",
		storageName: "canonical",
		defaultBranch: "main",
		createdAt: 1,
		grants: [],
		policy: { requiredEvidence: [], protectedPaths: [], resourceRules: {} },
	} satisfies Repository);
	state.canonical = { id: "canonical-id", name: "canonical", remote: "https://example.test/canonical" };
	state.sourceHead = A;
	for (let i = 0; i < count; i++)
		state.workspaces.push({
			id: `w${i}`,
			repositoryId: "repo",
			ownerId: "owner",
			createdBy: owner,
			title: "work",
			state: "active",
			branch: "work",
			baseRevision: A,
			headRevision: A,
			publishedRevision: A,
			lastReportAt: 5,
			startedAt: 1,
			lastActivity: 5,
			changes: [],
			commits: [],
			fork: { id: `fork-${i}`, name: `fork-${i}`, remote: `https://example.test/fork-${i}`, state: "ready" },
		} satisfies Workspace);
	const ns = new NamespaceController(
		initialNamespace({ id: "ns", name: "ns", handle: "ns", kind: "personal", ownerId: "owner", createdAt: 1 }),
		now,
	);
	ns.state.repositories.push(state.repository);
	const store = memoryStore();
	const routes = new Map<string, ObservationRoute>();
	const git = new GitWorkspace(new MemoryFs() as never);
	vi.spyOn(git, "ancestors").mockResolvedValue(new Set([A, B]));
	vi.spyOn(git, "recover").mockResolvedValue(undefined);
	const refs = vi
		.spyOn(git, "remoteRefs")
		.mockImplementation(async ({ url }) =>
			remote ? [{ ref: url.endsWith("canonical") ? "refs/heads/main" : "refs/heads/work", oid: remote }] : [],
		);
	const host: RepositoryHost = {
		info: vi.fn(async (name) => ({ id: name === "canonical" ? "canonical-id" : name, name, remote: `https://example.test/${name}` })),
		verifyFork: vi.fn(async () => {}),
		withToken: vi.fn(async (_name, _scope, run) => ({ result: await run("secret"), tokenId: "token" })),
		ensure: vi.fn(),
		fork: vi.fn(),
		remove: vi.fn(),
		gitRequest: vi.fn(),
	};
	const env = {
		CF_EVENTS_API_TOKEN: "secret",
		CRUCE_OBSERVATION_QUEUE_ID: "queue-id",
		CRUCE_OBSERVATION_QUEUE: "queue",
		CRUCE_STORAGE_ACCOUNT_ID: "account",
		CRUCE_ARTIFACTS_NAMESPACE: "storage",
	};
	const schedule = vi.fn(async (_at: number) => {});
	const settle = vi.fn(async (id: string) => {
		ns.state.reservations.find((r) => r.id === id)!.state = "complete";
	});
	const subscriptions = { ensure: vi.fn(async (name: string) => name), remove: vi.fn(async () => {}) };
	const make = () =>
		new Observation(store, env, git, () => now, {
			authority: async (grant) => {
				if (denied) throw Object.assign(new Error("revoked"), { status: 403 });
				return ns.authority(grant.actor, "repo");
			},
			reserve: async (grant, id, fingerprint) => ns.reserve(ns.authority(grant.actor, "repo"), id, fingerprint, "observation.read"),
			settle,
			schedule,
			subscriptions: () => subscriptions,
			host: async () => host,
			route: async (id, route) => {
				routes.set(id, route);
			},
			canonical: (observation) => {
				state.observedCanonical = observation;
			},
		});
	let observer = make();
	return {
		state,
		store,
		routes,
		git,
		refs,
		host,
		schedule,
		subscriptions,
		ns,
		settle,
		env,
		get observer() {
			return observer;
		},
		restart() {
			observer = make();
		},
		time(value: number) {
			now = value;
		},
		deny() {
			denied = true;
		},
		remote(value: string) {
			remote = value;
		},
		enable: () => observer.configure(state, { actor: owner }, true),
		recover: () => observer.recover(state),
		signal: async (id = "message", target = "w0") => {
			const [subscription, route] = [...routes].find(([, r]) => r.targetId === target)!;
			await observer.ingest(
				state,
				id,
				pushSignal({
					type: "cf.artifacts.repo.pushed",
					source: {
						type: "artifacts.repo",
						namespace: "storage",
						repoName: target === "canonical" ? "ns-ns-canonical" : `ns-ns-fork-${target.slice(1)}`,
					},
					metadata: { accountId: "account", eventSubscriptionId: subscription, eventSchemaVersion: 1 },
					payload: { after: A, commitsTruncated: true },
				})!,
				route,
			);
		},
	};
}
describe("durable observation", () => {
	it("requires opt-in, observes pushed refs separately and ignores duplicate/reordered payload heads", async () => {
		const f = fixture();
		await f.recover();
		expect(f.refs).not.toHaveBeenCalled();
		await f.enable();
		await f.recover();
		expect(f.observer.status(f.state).state).toBe("healthy");
		f.remote(B);
		f.time(40_000);
		await f.signal();
		await f.signal();
		expect(f.store.scan("observation-message:")).toHaveLength(1);
		f.restart();
		f.time(41_000);
		await f.recover();
		expect(f.observer.status(f.state).workspaces.w0.revision).toBe(B);
		expect(f.state.workspaces[0]).toMatchObject({
			headRevision: A,
			publishedRevision: A,
			baseRevision: A,
			lastReportAt: 5,
			lastActivity: 5,
		});
		expect(f.state.sourceHead).toBe(A);
		expect(f.state.promotions).toEqual([]);
		f.time(80_000);
		await f.signal("older-delivery");
		f.time(81_000);
		await f.recover();
		expect(f.observer.status(f.state).workspaces.w0.revision).toBe(B);
	});
	it("records rewinds and deleted refs without erasing history or accepting canonical", async () => {
		const f = fixture();
		await f.enable();
		await f.recover();
		f.remote(B);
		f.time(OBSERVATION_INTERVAL + 1000);
		await f.recover();
		expect(f.state.observedCanonical?.revision).toBe(B);
		expect(f.state.sourceHead).toBe(A);
		f.remote(A);
		f.time(2 * OBSERVATION_INTERVAL + 1000);
		await f.recover();
		f.remote("");
		f.time(3 * OBSERVATION_INTERVAL + 1000);
		await f.recover();
		expect(f.state.observedCanonical).toMatchObject({ deleted: true, revision: undefined });
		expect(f.store.scan("observation-history:")).toHaveLength(8);
		expect(f.state.workspaces[0].publishedRevision).toBe(A);
	});
	it("backfills after silent gaps in bounded batches and labels overdue checks", async () => {
		const f = fixture(6);
		await f.enable();
		await f.recover();
		expect(f.refs).toHaveBeenCalledTimes(4);
		f.time(2000);
		await f.recover();
		expect(f.refs).toHaveBeenCalledTimes(7);
		f.remote(B);
		f.time(OBSERVATION_INTERVAL + 3000);
		expect(f.observer.status(f.state).state).toBe("degraded");
		await f.recover();
		f.time(OBSERVATION_INTERVAL + 4000);
		await f.recover();
		expect(Object.values(f.observer.status(f.state).workspaces).every((w) => w.revision === B)).toBe(true);
	});
	it("reuses the reservation after lost settlement and never repeats a confirmed provider read", async () => {
		const f = fixture(0);
		await f.enable();
		f.settle.mockRejectedValueOnce(new Error("lost settlement"));
		await f.recover();
		expect(f.ns.state.reservations).toHaveLength(1);
		f.restart();
		f.time(40_000);
		await f.recover();
		expect(f.refs).toHaveBeenCalledTimes(1);
		expect(f.ns.state.reservations).toHaveLength(1);
		expect(f.observer.status(f.state).state).toBe("healthy");
	});
	it("does no provider work after policy or authority denial", async () => {
		for (const kind of ["policy", "authority"] as const) {
			const f = fixture();
			await f.enable();
			if (kind === "policy") f.ns.state.policy.rules["observation.read"] = "deny";
			if (kind === "authority") f.deny();
			await f.recover();
			expect(f.host.info).not.toHaveBeenCalled();
			expect(f.subscriptions.ensure).not.toHaveBeenCalled();
			expect(f.observer.status(f.state).state).toBe("degraded");
		}
	});
	it("fails closed on provider identity, incomplete refs and revoked authority during I/O", async () => {
		const f = fixture(0);
		await f.enable();
		vi.mocked(f.host.info).mockResolvedValueOnce({ id: "recreated", name: "canonical", remote: "https://example.test/canonical" });
		await f.recover();
		expect(f.state.observedCanonical).toBeUndefined();
		f.time(40_000);
		f.refs.mockResolvedValueOnce(Array.from({ length: 257 }, (_, i) => ({ ref: `refs/heads/${i}`, oid: A })));
		await f.recover();
		expect(f.state.observedCanonical).toBeUndefined();
		f.time(120_000);
		f.refs.mockImplementationOnce(async () => {
			f.deny();
			return [{ ref: "refs/heads/main", oid: B }];
		});
		await f.recover();
		expect(f.state.observedCanonical).toBeUndefined();
	});
	it("removes subscriptions on disable and explicit fork deletion without ref reads", async () => {
		const f = fixture();
		await f.enable();
		await f.recover();
		f.state.workspaces[0].fork!.state = "deleted";
		await f.recover();
		expect(f.subscriptions.remove).toHaveBeenCalledTimes(1);
		await f.observer.configure(f.state, { actor: owner }, false);
		await f.recover();
		expect(f.subscriptions.remove).toHaveBeenCalledTimes(2);
		expect(f.refs).toHaveBeenCalledTimes(2);
		expect(f.observer.status(f.state).state).toBe("disabled");
	});
	it("does not grant approval when observed canonical differs", async () => {
		const f = fixture(0);
		await f.enable();
		f.remote(B);
		await f.recover();
		const c = new RepositoryController(f.state, 1000, () => "id");
		const readiness = c.readiness({
			id: "p",
			number: 1,
			workspaceId: "w",
			artifactId: "a",
			title: "change",
			base: A,
			revision: B,
			state: "open",
			reviews: [],
			at: 1,
		});
		expect(readiness.ready).toBe(false);
		expect(readiness.reasons).toContain("Observed canonical differs from accepted history; reconcile canonical before promotion");
	});
});
describe("subscription management", () => {
	it("finds uncertain creation by exact managed identity before creating again", async () => {
		const f = fixture();
		let item: Subscription | undefined;
		const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST") {
				item = { id: "sub", ...JSON.parse(init.body as string) };
				throw new Error("lost response");
			}
			return Response.json({ success: true, result: item ? [item] : [], result_info: { total_pages: 1 } });
		});
		const authorized = vi.fn(async () => {});
		const subscriptions = new ObservationSubscriptions(f.env, authorized, send as typeof fetch);
		await expect(subscriptions.ensure("managed", "physical")).rejects.toThrow("lost response");
		await expect(subscriptions.ensure("managed", "physical")).resolves.toBe("sub");
		expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
		expect(authorized).toHaveBeenCalledTimes(3);
	});
	it("rejects malformed event envelopes without reading payload commit claims", () => {
		expect(pushSignal(null)).toBeUndefined();
		expect(pushSignal({ type: "cf.artifacts.repo.pushed" })).toBeUndefined();
	});
});

it("disabling after uncertain subscription creation removes it without doing another Git read", async () => {
	const f = fixture(0);
	await f.enable();
	f.subscriptions.ensure.mockRejectedValueOnce(new Error("lost creation response"));
	await f.recover();
	expect(f.refs).not.toHaveBeenCalled();
	await f.observer.configure(f.state, { actor: owner }, false);
	f.time(40_000);
	await f.recover();
	expect(f.subscriptions.remove).toHaveBeenCalledOnce();
	expect(f.refs).not.toHaveBeenCalled();
	expect(f.ns.state.reservations.every((r) => r.state === "complete")).toBe(true);
});
it("configuration response loss reuses the configuration generation", async () => {
	const f = fixture(0);
	f.schedule.mockRejectedValueOnce(new Error("lost schedule"));
	await expect(f.observer.configure(f.state, { actor: owner }, true, "configure-id")).rejects.toThrow("lost schedule");
	await f.observer.configure(f.state, { actor: owner }, true, "configure-id");
	expect(f.observer.status(f.state).generation).toBe(1);
});

it("disabling preserves the last confirmed refs and check time after subscription removal", async () => {
	const f = fixture();
	await f.enable();
	await f.recover();
	const before = f.observer.status(f.state);
	await f.observer.configure(f.state, { actor: owner }, false);
	await f.recover();
	expect(f.observer.status(f.state)).toMatchObject({
		state: "disabled",
		pending: 0,
		lastCheckedAt: before.lastCheckedAt,
		workspaces: before.workspaces,
	});
});

it("invokes subscription transport without an adapter receiver, as required by Worker fetch", async () => {
	const f = fixture(0);
	const send = async function (this: unknown) {
		expect(this).toBeUndefined();
		return Response.json({ success: true, result: [] });
	};
	const subscriptions = new ObservationSubscriptions(f.env, async () => {}, send as typeof fetch);
	await subscriptions.remove("none", "physical");
});

it("shows an overdue initial sweep before the first successful check", async () => {
	const f = fixture(0);
	await f.enable();
	f.time(OBSERVATION_INTERVAL + 1001);
	expect(f.observer.status(f.state)).toMatchObject({ state: "degraded", pending: 1, reason: "Observation checks are overdue" });
});

it("backfills missing ancestry and exposes bounded failure without hiding confirmed refs", async () => {
	const f = fixture(0);
	vi.mocked(f.git.ancestors).mockRejectedValue(new Error("missing objects"));
	vi.mocked(f.git.recover).mockRejectedValueOnce(new Error("transfer bound"));
	await f.enable();
	await f.recover();
	expect(f.git.recover).toHaveBeenCalledWith(expect.objectContaining({ ref: "refs/heads/main", expected: A }));
	expect(f.observer.status(f.state)).toMatchObject({ state: "degraded", canonical: { revision: A } });
	expect(f.state.sourceHead).toBe(A);
	f.time(OBSERVATION_INTERVAL + 1001);
	await f.recover();
	expect(f.observer.status(f.state).state).toBe("healthy");
	expect(f.store.get("observation-cursor")).toBe("canonical");
});

it("acknowledges Queue messages only after committed private ingestion and retries transport failures", async () => {
	const f = fixture(0);
	await f.enable();
	await f.recover();
	const [subscription, route] = [...f.routes][0];
	const message = {
		id: "delivery",
		body: {
			type: "cf.artifacts.repo.pushed",
			source: { type: "artifacts.repo", namespace: "storage", repoName: "ns-ns-canonical" },
			metadata: { accountId: "account", eventSubscriptionId: subscription, eventSchemaVersion: 1 },
		},
		ack: vi.fn(),
		retry: vi.fn(),
	};
	const ingest = vi.fn(async () => {
		expect(message.ack).not.toHaveBeenCalled();
	});
	const env = {
		...f.env,
		DIRECTORY: { getByName: () => ({ observationRoute: async () => route }) },
		CONTROL_TOWER: { getByName: () => ({ ingestObservation: ingest }) },
	};
	const batch = { queue: "queue", messages: [message], retryAll: vi.fn() };
	await observationQueue(batch as never, env as never);
	expect(message.ack).toHaveBeenCalledOnce();
	message.ack.mockClear();
	ingest.mockRejectedValueOnce(new Error("DO response lost"));
	await observationQueue(batch as never, env as never);
	expect(message.ack).not.toHaveBeenCalled();
	expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
	batch.queue = "unconfigured";
	await observationQueue(batch as never, env as never);
	expect(batch.retryAll).toHaveBeenCalledOnce();
	batch.queue = "queue-dead";
	await observationQueue(batch as never, env as never);
	expect(ingest).toHaveBeenLastCalledWith("delivery", expect.anything(), route, true);
});
