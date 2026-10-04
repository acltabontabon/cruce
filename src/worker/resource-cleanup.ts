import { ControllerError } from "../core/controller.ts";
import { FAILED_FLIGHT_RETENTION_MS, type Flight, type FlightCleanup, TERMINAL_PHASES } from "../core/domain.ts";
import type { ProjectGit } from "./project-git.ts";
import type { TowerStore } from "./tower.ts";

const DAY = FAILED_FLIGHT_RETENTION_MS;
const STEPS = ["tokens", "workflow", "sandbox", "repository", "subscription", "local"] as const;
type Step = (typeof STEPS)[number];
interface Progress {
	done?: boolean;
	attempts: number;
	nextAt: number;
}

/** An intent survives partial provisioning and demo resets; no credentials are persisted here. */
export interface FlightResources {
	key: string;
	projectId: string;
	flightId: string;
	namespace: string;
	repo: string;
	repoId?: string;
	epoch: number;
	description: string;
	createdAt: number;
	/** Lease for a fork/subscription operation interrupted by a restart. */
	provisionUntil?: number;
	deleting?: boolean;
	workflowId?: string;
	sandboxId?: string;
	phase?: Flight["phase"];
	finishedAt?: number;
	landedCommit?: string;
	publishedHead?: string;
	expiresAt?: number;
	keep: boolean;
	subscriptionExpected: boolean;
	reset?: boolean;
	verified?: boolean;
	deletedAt?: number;
	steps: Record<Step, Progress>;
}

interface CleanupHooks {
	flights(): Flight[];
	update(flightId: string, cleanup: FlightCleanup): void;
	attention(key: string, flightId: string | undefined, failed: boolean): void;
	note(title: string, flightId?: string): void;
	workflow?(record: FlightResources): Promise<void>;
	sandbox?(record: FlightResources): Promise<void>;
	unsubscribe?(repo: string): Promise<void>;
	subscriptionConfigured?: boolean;
}

export class ResourceCleanup {
	private running?: Promise<void>;
	constructor(
		private readonly projectId: string,
		private readonly git: ProjectGit,
		private readonly store: TowerStore,
		private readonly hooks: CleanupHooks,
		private readonly now: () => number,
	) {
		if (git.artifacts && store.get<number>("cleanupReconcileAt") === undefined) store.put("cleanupReconcileAt", now() + DAY);
	}

	records(): FlightResources[] {
		return this.store.get<FlightResources[]>("flightResources") ?? [];
	}

	private save(record: FlightResources) {
		const records = this.records();
		const index = records.findIndex((r) => r.key === record.key);
		if (index < 0) records.push(record);
		else records[index] = record;
		this.store.put("flightResources", records);
	}

	private update(key: string, fn: (record: FlightResources) => void) {
		const latest = this.records().find((r) => r.key === key);
		if (!latest) throw new Error("Resource ownership intent missing");
		fn(latest);
		this.save(latest);
		return latest;
	}

	/** Must run before the fork or Workflow create call. */
	ensure(flight: Flight): FlightResources {
		const repo = flight.artifact?.repo ?? this.git.flightRepoName(flight.id);
		const key = `${this.git.namespace}/${repo}`;
		const existing = this.records().find((r) => r.key === key);
		if (existing) return existing;
		const steps = Object.fromEntries(STEPS.map((step) => [step, { attempts: 0, nextAt: this.now() }])) as Record<Step, Progress>;
		const record: FlightResources = {
			key,
			projectId: this.projectId,
			flightId: flight.id,
			namespace: this.git.namespace,
			repo,
			repoId: flight.artifact?.repoId,
			epoch: this.git.epoch,
			description: `Cruce Flight ${flight.id}: ${flight.title}`,
			createdAt: this.now(),
			keep: false,
			subscriptionExpected: (!!this.git.artifacts && !!flight.artifact) || (this.hooks.subscriptionConfigured ?? !!this.hooks.unsubscribe),
			sandboxId: flight.sandboxId,
			steps,
		};
		this.save(record);
		return record;
	}

	register(key: string, resources: Partial<Pick<FlightResources, "repoId" | "workflowId" | "sandboxId">>) {
		const record = this.records().find((r) => r.key === key);
		if (!record) throw new Error("Resource ownership intent missing");
		for (const step of STEPS) {
			if (
				((step === "tokens" || step === "repository" || step === "subscription" || step === "local") && resources.repoId) ||
				(step === "workflow" && resources.workflowId) ||
				(step === "sandbox" && resources.sandboxId)
			)
				record.steps[step] = { attempts: 0, nextAt: this.now() };
		}
		if (resources.repoId) record.deletedAt = undefined;
		Object.assign(record, resources);
		this.save(record);
	}

	provisioning(key: string, pending: boolean) {
		const record = this.records().find((r) => r.key === key);
		if (!record) throw new Error("Resource ownership intent missing");
		record.provisionUntil = pending ? this.now() + 10 * 60_000 : undefined;
		this.save(record);
	}

	assertRetainable(flight: Flight) {
		const record = this.records().find((r) => r.repo === flight.artifact?.repo || (r.epoch === this.git.epoch && r.flightId === flight.id));
		if (record?.deleting || record?.deletedAt !== undefined) throw new ControllerError("Work expiry has already started", 410);
	}

	retryTokens(flight: Flight) {
		const record = this.ensure(flight);
		this.update(record.key, (r) => {
			r.steps.tokens = { attempts: 0, nextAt: this.now() };
		});
	}

	sync() {
		for (const flight of this.hooks.flights()) {
			if (!flight.artifact && !TERMINAL_PHASES.has(flight.phase)) continue;
			const record = this.ensure(flight);
			if (record.reset) continue;
			if (!TERMINAL_PHASES.has(flight.phase)) continue;
			record.phase = flight.phase;
			record.finishedAt = flight.finishedAt ?? flight.landedAt ?? this.now();
			record.expiresAt = flight.cleanup?.expiresAt ?? record.finishedAt + (flight.phase === "landed" ? 0 : DAY);
			record.keep = flight.cleanup?.keep ?? false;
			record.landedCommit = flight.landedCommit;
			record.publishedHead = flight.artifact?.head ?? flight.publishes.filter((p) => p.approved).at(-1)?.commit;
			record.workflowId ??= this.store.get<string>(`wf:${flight.id}`);
			record.sandboxId ??= flight.agent === "claude-code" ? `${this.projectId}-${flight.id}` : undefined;
			this.save(record);
		}
		for (const record of this.records()) {
			if (record.finishedAt !== undefined || this.current(record)) continue;
			record.phase = "lost";
			record.finishedAt = this.now();
			record.expiresAt = this.now() + DAY;
			this.save(record);
		}
	}

	reset() {
		this.sync();
		for (const record of this.records()) {
			if (record.epoch !== this.git.epoch) continue;
			record.reset = true;
			record.keep = false;
			record.finishedAt ??= this.now();
			record.expiresAt = this.now();
			this.save(record);
		}
	}

	private current(record: FlightResources) {
		return this.hooks
			.flights()
			.find((f) => f.id === record.flightId && (f.artifact?.repo ?? this.git.flightRepoName(f.id)) === record.repo);
	}

	private due(record: FlightResources, step: Step) {
		if (record.finishedAt === undefined || record.steps[step].done) return undefined;
		const immediate = step === "tokens" || step === "workflow" || step === "sandbox";
		if (!immediate && record.keep) return undefined;
		const dependency =
			(step === "local" || step === "subscription") && !record.steps.repository.done
				? Math.max(record.steps.repository.nextAt, record.provisionUntil ?? 0)
				: 0;
		return Math.max(
			record.steps[step].nextAt,
			dependency,
			step === "repository" ? (record.provisionUntil ?? 0) : 0,
			immediate ? 0 : (record.expiresAt ?? Infinity),
		);
	}

	nextAt(): number | undefined {
		const dates = this.records()
			.flatMap((r) => STEPS.map((s) => this.due(r, s)))
			.filter((n): n is number => n !== undefined);
		if (this.git.artifacts) dates.push(this.store.get<number>("cleanupReconcileAt") ?? this.now() + DAY);
		return dates.length ? Math.min(...dates) : undefined;
	}

	run(): Promise<void> {
		if (this.running) return this.running;
		const work = this.process();
		this.running = work;
		return work.finally(() => {
			this.running = undefined;
		});
	}

	private async identity(record: FlightResources) {
		if (record.namespace !== this.git.namespace || record.projectId !== this.projectId || record.repo === this.git.repo)
			throw new Error("Protected repository");
		const info = await this.git.artifacts?.find(record.repo);
		if (!info) return undefined;
		const latest = this.records().find((r) => r.key === record.key) as FlightResources;
		if (latest.repoId && latest.repoId !== info.id) throw new Error("Repository ownership mismatch");
		if (
			record.repoId
				? record.repoId !== info.id
				: info.description !== record.description || info.source !== `artifacts:${record.namespace}/${this.git.repo}`
		)
			throw new Error("Repository ownership mismatch");
		if (!record.repoId) {
			record.repoId = info.id;
			this.update(record.key, (r) => {
				r.repoId = info.id;
			});
		}
		return info;
	}

	private async process() {
		this.sync();
		const due = this.records()
			.filter((r) => STEPS.some((s) => (this.due(r, s) ?? Infinity) <= this.now()))
			.slice(0, 10);
		for (const candidate of due) {
			for (const step of STEPS) {
				const record = this.records().find((r) => r.key === candidate.key) as FlightResources;
				if ((this.due(record, step) ?? Infinity) > this.now()) continue;
				// New epochs may reuse Flight IDs; old cleanup must never clear the new Flight's refs.
				if (!record.reset && this.current(record) && !TERMINAL_PHASES.has((this.current(record) as Flight).phase)) continue;
				try {
					if (step === "tokens") {
						this.git.clearReadToken(record.repo);
						if (await this.identity(record)) await this.git.artifacts?.revokeAll(record.repo);
					}
					if (step === "workflow") await this.hooks.workflow?.(record);
					if (step === "sandbox") await this.hooks.sandbox?.(record);
					if (step === "repository") {
						if (!record.reset && record.phase === "landed" && !record.verified) {
							await this.git.verifyLanding({ id: record.flightId, landedCommit: record.landedCommit, publishedHead: record.publishedHead });
							record.verified = true;
							this.update(record.key, (r) => {
								r.verified = true;
							});
						}
						if (await this.identity(record)) {
							const latest = this.records().find((r) => r.key === record.key) as FlightResources;
							if (latest.keep) continue;
							latest.deleting = true;
							this.save(latest);
							record.deleting = true;
							await this.git.artifacts?.delete(record.repo);
							if (await this.git.artifacts?.find(record.repo)) throw new Error("Repository deletion is propagating");
						}
						record.deletedAt = this.now();
						record.deleting = false;
					}
					if (step === "subscription") {
						if (!record.steps.repository.done) continue;
						if (await this.identity(record)) throw new Error("Repository reappeared before subscription cleanup");
						if (record.subscriptionExpected) {
							if (!this.hooks.unsubscribe) throw new Error("Event subscription cleanup unavailable");
							await this.hooks.unsubscribe(record.repo);
						}
					}
					if (step === "local") {
						if (!record.steps.repository.done) continue;
						const current = this.current(record);
						await this.git.clearFlightResources(record.flightId, record.repo, !!current || record.epoch === this.git.epoch);
					}
					// Merge with any late provisioning updates that happened during an await.
					const latest = this.records().find((r) => r.key === record.key) as FlightResources;
					if (latest.repoId !== record.repoId || latest.workflowId !== record.workflowId || latest.sandboxId !== record.sandboxId) continue;
					this.update(record.key, (r) => {
						r.steps[step] = { done: true, attempts: 0, nextAt: this.now() };
						if (step === "repository") {
							r.deletedAt = record.deletedAt;
							r.deleting = false;
						}
					});
				} catch {
					const latest = this.records().find((r) => r.key === record.key) as FlightResources;
					const attempts = latest.steps[step].attempts + 1;
					latest.steps[step] = { attempts, nextAt: this.now() + (attempts === 1 ? 60_000 : attempts === 2 ? 300_000 : 3_600_000) };
					this.save(latest);
					this.hooks.note(`${record.repo}: ${step} cleanup will retry (attempt ${attempts})`, this.current(record)?.id);
				}
			}
			this.publish(candidate.key);
		}
		await this.reconcile();
	}

	private publish(key: string) {
		const record = this.records().find((r) => r.key === key) as FlightResources;
		const failed = STEPS.some((s) => record.steps[s].attempts >= 3);
		this.hooks.attention(key, this.current(record)?.id, failed);
		const current = this.current(record);
		if (!current || !TERMINAL_PHASES.has(current.phase)) return;
		const retrying = STEPS.some((s) => record.steps[s].attempts > 0);
		const complete = STEPS.every((s) => record.steps[s].done);
		const cleanup: FlightCleanup = {
			status: retrying ? "retrying" : complete ? "complete" : record.keep || (record.expiresAt ?? 0) > this.now() ? "retained" : "pending",
			expiresAt: record.expiresAt as number,
			keep: record.keep,
			deletedAt: record.deletedAt,
		};
		if (JSON.stringify(current.cleanup) !== JSON.stringify(cleanup)) this.hooks.update(current.id, cleanup);
	}

	/** One page per alarm keeps reconciliation bounded even in a large shared namespace. */
	private async reconcile() {
		const host = this.git.artifacts;
		if (!host) return;
		const at = this.store.get<number>("cleanupReconcileAt");
		if (at === undefined) {
			this.store.put("cleanupReconcileAt", this.now() + DAY);
			return;
		}
		if (at > this.now()) return;
		try {
			const page = await host.list(this.store.get<string>("cleanupReconcileCursor"));
			const known = this.records();
			for (const repo of page.repos) {
				if (!repo.name.startsWith(`${this.git.repo}--`)) continue;
				const record = known.find((r) => r.repo === repo.name);
				if (!record || (record.repoId && record.repoId !== repo.id)) {
					this.hooks.attention(`unowned:${this.git.namespace}/${repo.name}`, undefined, true);
					continue;
				}
				if (record.finishedAt !== undefined && record.steps.repository.done) {
					for (const step of ["repository", "tokens", "subscription", "local"] as const)
						record.steps[step] = { attempts: 0, nextAt: this.now() };
					record.deletedAt = undefined;
					this.save(record);
					this.publish(record.key);
				}
			}
			if (page.cursor) this.store.put("cleanupReconcileCursor", page.cursor);
			else this.store.delete("cleanupReconcileCursor");
			this.store.put("cleanupReconcileAt", this.now() + (page.cursor ? 1_000 : DAY));
			this.store.delete("cleanupReconcileAttempts");
			this.hooks.attention("reconciliation", undefined, false);
		} catch {
			const attempts = (this.store.get<number>("cleanupReconcileAttempts") ?? 0) + 1;
			this.store.put("cleanupReconcileAttempts", attempts);
			this.store.put("cleanupReconcileAt", this.now() + (attempts === 1 ? 60_000 : attempts === 2 ? 300_000 : 3_600_000));
			this.hooks.attention("reconciliation", undefined, attempts >= 3);
		}
	}
}
