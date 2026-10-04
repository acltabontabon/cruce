import { describe, expect, it, vi } from "vitest";
import { Controller } from "../../src/core/controller.ts";
import { FAILED_FLIGHT_RETENTION_MS } from "../../src/core/domain.ts";
import { ArtifactsHost } from "../../src/worker/artifacts-host.ts";
import type { ProjectGit } from "../../src/worker/project-git.ts";
import { ResourceCleanup } from "../../src/worker/resource-cleanup.ts";
import type { TowerStore } from "../../src/worker/tower.ts";
import { freshState } from "../fixtures.ts";

function harness(count = 1) {
	let now = 1_000;
	const c = new Controller(freshState(), now);
	for (let i = 0; i < count; i++) c.createFlight({ missionId: c.createMission({ title: `task ${i}` }).id, agent: "external" });
	const flights = c.commit().state.flights;
	const repos = new Map<string, { id: string; name: string; description: string; source: string }>();
	const revoked = vi.fn(async () => true);
	const deleted = vi.fn(async (name: string) => repos.delete(name));
	const list = vi.fn(async () => ({ repos: [...repos.values()], total: repos.size }));
	const binding = {
		get: async (name: string) => ({
			[Symbol.dispose]() {},
			info: async () => {
				const info = repos.get(name);
				if (!info) throw new Error("NOT_FOUND");
				return info;
			},
			listTokens: async () => ({ tokens: [{ id: "test-token-id", state: "active" }] }),
			revokeToken: revoked,
		}),
		delete: deleted,
		list,
	} as unknown as Artifacts;
	const clear = vi.fn(async () => {});
	const verify = vi.fn(async () => {});
	const git = {
		repo: "auth-service",
		namespace: "cruce",
		epoch: 0,
		artifacts: new ArtifactsHost(binding, "cruce"),
		flightRepoName: (id: string) => `auth-service--${id.toLowerCase().replace("-", "")}${git.epoch ? `-r${git.epoch}` : ""}`,
		clearFlightResources: clear,
		verifyLanding: verify,
	} as unknown as ProjectGit;
	const kv = new Map<string, unknown>();
	const store: TowerStore = {
		get: (key) => structuredClone(kv.get(key)) as never,
		put: (key, value) => {
			kv.set(key, structuredClone(value));
		},
		delete: (key) => {
			kv.delete(key);
		},
		appendEvents: () => {},
	};
	const attention = vi.fn();
	const notes = vi.fn();
	const unsubscribe = vi.fn(async () => {});
	const hooks = {
		flights: () => flights,
		update: (id: string, cleanup: (typeof flights)[number]["cleanup"]) => {
			flights.find((f) => f.id === id)!.cleanup = cleanup;
		},
		attention,
		note: notes,
		unsubscribe,
	};
	const create = () => new ResourceCleanup("demo", git, store, hooks, () => now);
	let cleanup = create();
	const provision = (index = 0) => {
		const flight = flights[index];
		const owned = cleanup.ensure(flight);
		const repo = { id: `repo-${index}`, name: owned.repo, description: owned.description, source: "artifacts:cruce/auth-service" };
		repos.set(repo.name, repo);
		flight.artifact = {
			namespace: "cruce",
			repo: repo.name,
			repoId: repo.id,
			remote: "https://example.test/repo.git",
			forkedFrom: "auth-service",
			baseCommit: "base",
			createdAt: now,
		};
		cleanup.register(owned.key, { repoId: repo.id });
		return owned;
	};
	const finish = (index = 0, phase: "failed" | "landed" | "cancelled" | "lost" = "failed") => {
		const flight = flights[index];
		flight.phase = phase;
		flight.finishedAt = now;
		flight.landedCommit = phase === "landed" ? "merge" : undefined;
		flight.cleanup = { status: "pending", expiresAt: now + (phase === "landed" ? 0 : FAILED_FLIGHT_RETENTION_MS), keep: false };
	};
	return {
		flights,
		repos,
		git,
		kv,
		clear,
		verify,
		revoked,
		deleted,
		attention,
		notes,
		unsubscribe,
		list,
		provision,
		finish,
		setTime: (value: number) => {
			now = value;
		},
		get now() {
			return now;
		},
		get cleanup() {
			return cleanup;
		},
		restart: () => {
			cleanup = create();
		},
	};
}

describe("durable Flight resource cleanup", () => {
	it("does not overwrite a retention change made while credential revocation is in flight", async () => {
		const h = harness();
		h.provision();
		h.finish(0, "failed");
		let release!: () => void;
		h.revoked.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					release = () => resolve(true);
				}),
		);
		const running = h.cleanup.run();
		await vi.waitFor(() => expect(h.revoked).toHaveBeenCalled());
		h.flights[0].cleanup!.keep = true;
		h.cleanup.sync();
		release();
		await running;
		expect(h.cleanup.records()[0].keep).toBe(true);
		expect(h.flights[0].cleanup?.keep).toBe(true);
	});

	it("pages reconciliation across restarts and repairs a recorded repository that reappears", async () => {
		const h = harness();
		const owned = h.provision();
		const info = h.repos.get(owned.repo)!;
		h.finish(0, "landed");
		await h.cleanup.run();
		h.repos.set(info.name, info);
		h.setTime(h.now + FAILED_FLIGHT_RETENTION_MS);
		h.list.mockResolvedValueOnce({ repos: [info], total: 2, cursor: "second" } as never);
		await h.cleanup.run();
		expect(h.cleanup.records()[0].steps.repository.done).toBeUndefined();
		h.restart();
		h.setTime(h.now + 1_000);
		await h.cleanup.run();
		expect(h.list).toHaveBeenLastCalledWith({ limit: 100, cursor: "second" });
		expect(h.deleted).toHaveBeenCalledTimes(2);
	});
	it.each(["failed", "cancelled", "lost"] as const)(
		"revokes credentials immediately and expires %s work at exactly 24 hours",
		async (phase) => {
			const h = harness();
			h.provision();
			h.finish(0, phase);
			await h.cleanup.run();
			expect(h.revoked).toHaveBeenCalledOnce();
			expect(h.deleted).not.toHaveBeenCalled();
			h.setTime(1_000 + FAILED_FLIGHT_RETENTION_MS - 1);
			await h.cleanup.run();
			expect(h.deleted).not.toHaveBeenCalled();
			h.restart();
			h.setTime(h.now + 1);
			await h.cleanup.run();
			expect(h.deleted).toHaveBeenCalledOnce();
			expect(h.unsubscribe).toHaveBeenCalledOnce();
			expect(h.clear).toHaveBeenCalledWith(h.flights[0].id, h.flights[0].artifact!.repo, true);
			expect(h.flights[0].cleanup?.status).toBe("complete");
		},
	);

	it("verifies canonical preservation before deleting landed work and never changes its terminal phase", async () => {
		const h = harness();
		h.provision();
		h.finish(0, "landed");
		h.verify.mockRejectedValueOnce(new Error("canonical note missing"));
		await h.cleanup.run();
		expect(h.deleted).not.toHaveBeenCalled();
		expect(h.flights[0].phase).toBe("landed");
		expect(h.cleanup.nextAt()).toBe(h.now + 60_000);
		h.setTime(h.now + 60_000);
		h.restart();
		await h.cleanup.run();
		expect(h.deleted).toHaveBeenCalledOnce();
		expect(h.flights[0].cleanup?.deletedAt).toBe(h.now);
		await h.cleanup.run();
		expect(h.deleted).toHaveBeenCalledOnce();
	});

	it("retention keeps the original deadline while releasing credentials and execution", async () => {
		const h = harness();
		h.provision();
		h.finish();
		h.flights[0].cleanup!.keep = true;
		await h.cleanup.run();
		h.setTime(h.now + FAILED_FLIGHT_RETENTION_MS * 2);
		await h.cleanup.run();
		expect(h.revoked).toHaveBeenCalledOnce();
		expect(h.deleted).not.toHaveBeenCalled();
		h.flights[0].cleanup!.keep = false;
		await h.cleanup.run();
		expect(h.deleted).toHaveBeenCalledOnce();
	});

	it("retries independent steps and raises one attention item after three attempts", async () => {
		const h = harness();
		h.provision();
		h.finish(0, "landed");
		h.unsubscribe.mockRejectedValue(new Error("unavailable"));
		await h.cleanup.run();
		expect(h.clear).toHaveBeenCalledOnce();
		expect(h.deleted).toHaveBeenCalledOnce();
		for (const delay of [60_000, 300_000]) {
			h.setTime(h.now + delay);
			h.restart();
			await h.cleanup.run();
		}
		expect(h.attention).toHaveBeenLastCalledWith(h.cleanup.records()[0].key, h.flights[0].id, true);
		expect(h.cleanup.nextAt()).toBe(h.now + 3_600_000);
		h.unsubscribe.mockResolvedValue();
		h.setTime(h.now + 3_600_000);
		await h.cleanup.run();
		expect(h.attention).toHaveBeenLastCalledWith(h.cleanup.records()[0].key, h.flights[0].id, false);
		expect(h.flights[0].cleanup?.status).toBe("complete");
		expect(h.deleted).toHaveBeenCalledOnce();
	});

	it("waits for eventually consistent deletion before unsubscribing or expiring review data", async () => {
		const h = harness();
		h.provision();
		h.finish(0, "landed");
		h.deleted.mockResolvedValueOnce(true);
		await h.cleanup.run();
		expect(h.unsubscribe).not.toHaveBeenCalled();
		expect(h.flights[0].cleanup?.deletedAt).toBeUndefined();
		h.setTime(h.now + 60_000);
		await h.cleanup.run();
		expect(h.flights[0].cleanup?.status).toBe("complete");
	});

	it("never cleans active Flights, canonical, or a repository whose identity changed", async () => {
		const h = harness();
		h.provision();
		await h.cleanup.run();
		expect(h.deleted).not.toHaveBeenCalled();
		h.finish(0, "landed");
		h.repos.get(h.flights[0].artifact!.repo)!.id = "replacement";
		await h.cleanup.run();
		expect(h.deleted).not.toHaveBeenCalled();
		expect(h.revoked).not.toHaveBeenCalled();
		const records = h.cleanup.records();
		records[0].repo = "auth-service";
		h.kv.set("flightResources", records);
		h.setTime(h.now + 60_000);
		await h.cleanup.run();
		expect(h.deleted).not.toHaveBeenCalled();
	});

	it("records intent before a partial fork and adopts only a matching owned repository", async () => {
		const h = harness();
		const owned = h.cleanup.ensure(h.flights[0]);
		expect(h.cleanup.records()[0].repoId).toBeUndefined();
		h.repos.set(owned.repo, {
			id: "partial-fork",
			name: owned.repo,
			description: owned.description,
			source: "artifacts:cruce/auth-service",
		});
		h.finish();
		h.restart();
		await h.cleanup.run();
		expect(h.revoked).toHaveBeenCalledOnce();
		expect(h.cleanup.records()[0].repoId).toBe("partial-fork");
	});

	it("late fork completion resets credential cleanup without reopening a terminal Flight", async () => {
		const h = harness();
		const owned = h.cleanup.ensure(h.flights[0]);
		h.cleanup.provisioning(owned.key, true);
		h.finish(0, "landed");
		await h.cleanup.run();
		expect(h.deleted).not.toHaveBeenCalled();
		h.provision();
		h.cleanup.provisioning(owned.key, false);
		await h.cleanup.run();
		expect(h.revoked).toHaveBeenCalledOnce();
		expect(h.deleted).toHaveBeenCalledOnce();
		expect(h.flights[0].phase).toBe("landed");
	});

	it("preserves reset jobs across epochs without deleting new Flight refs", async () => {
		const h = harness();
		const old = h.provision();
		h.deleted.mockRejectedValueOnce(new Error("unavailable"));
		h.cleanup.reset();
		await h.cleanup.run();
		h.git.epoch = 1;
		h.flights[0].artifact = undefined;
		const current = h.provision();
		h.restart();
		h.setTime(h.now + 60_000);
		await h.cleanup.run();
		expect(h.deleted).toHaveBeenLastCalledWith(old.repo);
		expect(h.repos.has(current.repo)).toBe(true);
		expect(h.clear).toHaveBeenLastCalledWith(h.flights[0].id, old.repo, false);
	});

	it("limits cleanup to ten jobs and reconciles unknown candidates without deleting them", async () => {
		const h = harness(12);
		for (let i = 0; i < 12; i++) {
			h.provision(i);
			h.finish(i, "landed");
		}
		await h.cleanup.run();
		expect(h.deleted).toHaveBeenCalledTimes(10);
		await h.cleanup.run();
		expect(h.deleted).toHaveBeenCalledTimes(12);
		h.repos.set("auth-service--legacy", {
			id: "unknown",
			name: "auth-service--legacy",
			description: "unknown",
			source: "artifacts:cruce/auth-service",
		});
		h.setTime(h.now + FAILED_FLIGHT_RETENTION_MS);
		await h.cleanup.run();
		expect(h.attention).toHaveBeenCalledWith("unowned:cruce/auth-service--legacy", undefined, true);
		expect(h.repos.has("auth-service--legacy")).toBe(true);
	});
});
