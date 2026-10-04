import { resolveResource } from "../core/airspace.ts";
import { CoordinationError, decide, initialCoordination, semanticFingerprint, stable, WorkstreamController } from "../core/workstreams.ts";
import { JEV_LIMITS, type JevBinding, type JevJob, JevResponse, packetFor, validateAssessment } from "../intelligence/jev.ts";
import { buildIndex } from "../intelligence/structural-index.ts";
import {
	type Command,
	type CoordinationState,
	type ManagedWorkspaceRecord,
	type Observation,
	type Principal,
	type ProjectConnection,
	READ_TOOLS,
} from "../shared/coordination.ts";
import type { GitWorkspace } from "./git/workspace.ts";
import type { CloudflareArtifactWorkspace } from "./managed-workspace.ts";
import type { TowerStore } from "./tower.ts";

/** Application commands shared by HTTP and MCP. Business state is independent of transport sessions. */
export class CoordinationRuntime {
	private queue: Promise<unknown> = Promise.resolve();
	private running = new Set<string>();
	constructor(
		readonly store: TowerStore,
		readonly git: GitWorkspace,
		readonly background: (work: Promise<unknown>) => void,
		readonly now: () => number = Date.now,
		readonly ai?: JevBinding,
		readonly managed?: CloudflareArtifactWorkspace,
	) {}
	state(): CoordinationState {
		const state = this.store.get<CoordinationState>("coordination");
		if (!state) throw new CoordinationError(503, "Project authority not initialized");
		return state;
	}
	private save(s: CoordinationState) {
		this.store.put("coordination", s);
	}
	metadata(project: ProjectConnection) {
		return this.serialize(() => {
			const s = this.state();
			if (project.id !== s.project.id) throw new CoordinationError(403, "Project authority mismatch");
			if (project.name !== s.project.name || project.active !== s.project.active) {
				s.project = { ...s.project, name: project.name, active: project.active, version: s.project.version + 1 };
				this.save(s);
			}
		});
	}
	withAuthority<T>(run: (state: CoordinationState) => T | Promise<T>) {
		return this.serialize(() => run(this.state()));
	}
	private serialize<T>(run: () => T | Promise<T>): Promise<T> {
		const next = this.queue.then(run);
		this.queue = next.catch(() => {});
		return next;
	}
	initialize(project: ProjectConnection, head: string, files: Record<string, string>) {
		return this.serialize(() => {
			const old = this.store.get<CoordinationState>("coordination");
			if (old) return old;
			const s = initialCoordination({ ...project, canonicalHead: head }, buildIndex(files, head));
			this.save(s);
			return s;
		});
	}
	command(cmd: Command, p: Principal) {
		return this.serialize(async () => {
			const c = new WorkstreamController(this.state(), this.now());
			let result: unknown;
			if (cmd.tool === "report_change") {
				if (!cmd.observation) throw new CoordinationError(400, "Git observation required");
				const o = cmd.observation;
				const index = buildIndex(o.files ?? {}, o.base),
					headIndex = buildIndex(o.headFiles ?? {}, o.head);
				const limitations = [...index.files, ...headIndex.files].filter((f) => f.limitation).map((f) => `${f.path}: ${f.limitation}`);
				if (!o.files || !o.headFiles) limitations.push("Missing base or head content; local scope is incomplete");
				result = c.observe(
					{
						id: `local:${p.developerId}:${cmd.idempotencyKey}`,
						workstreamIds: [cmd.workstreamId as string],
						source: "local_git",
						verified: false,
						at: this.now(),
						index,
						headIndex,
						limitations,
						...{ kind: o.kind, base: o.base, head: o.head, branch: o.branch, changes: o.changes },
					},
					p,
					cmd,
				);
			} else result = c.execute(cmd, p);
			this.save(c.state);
			if (
				!READ_TOOLS.has(cmd.tool) &&
				["register_intent", "update_intent", "report_scope", "report_change", "attach_workstream"].includes(cmd.tool)
			)
				await this.enqueueSemantic();
			return result;
		});
	}
	snapshot(p: Principal) {
		const c = new WorkstreamController(this.state(), this.now());
		c.authorize(p);
		return {
			...c.state,
			replays: undefined,
			workstreams: c.state.workstreams.map((w) => ({ ...w, decision: decide(c.state, w.id, this.now()) })),
			managed: this.store.get<ManagedWorkspaceRecord[]>("managed") ?? [],
		};
	}
	override(p: Principal, id: string, resources: string[], reason: string, fingerprint: string, expiresAt: number) {
		return this.serialize(() => {
			const c = new WorkstreamController(this.state(), this.now());
			const d = c.override(p, id, resources, reason, fingerprint, expiresAt);
			this.save(c.state);
			return d;
		});
	}
	policy(p: Principal, policy: ProjectConnection["policy"]) {
		return this.serialize(() => {
			const c = new WorkstreamController(this.state(), this.now());
			c.authorize(p);
			if (!p.maintainer) throw new CoordinationError(403, "Maintainer required");
			c.state.project.policy = policy;
			c.state.project.version++;
			c.state.revision++;
			this.save(c.state);
			return policy;
		});
	}
	provision(p: Principal, id: string) {
		return this.serialize(async () => {
			const c = new WorkstreamController(this.state(), this.now());
			c.authorize(p);
			const w = c.state.workstreams.find((w) => w.id === id);
			if (p.canWrite === false || !w || w.owner !== p.developerId) throw new CoordinationError(403, "Workstream owner required");
			if (!this.managed) throw new CoordinationError(503, "Artifacts binding unavailable");
			const records = this.store.get<ManagedWorkspaceRecord[]>("managed") ?? [],
				old = records.find((r) => r.workstreamId === id);
			if (old && !["requested", "provisioning"].includes(old.state)) return old;
			const baseline = w.plans[0].baseline;
			await this.git.readFiles(baseline);
			const pending: ManagedWorkspaceRecord = old ?? {
				workstreamId: id,
				backend: "cloudflare_artifacts",
				repository: `${this.managed.domainName}--${id.toLowerCase()}`,
				remote: "",
				baseline,
				head: baseline,
				state: "requested",
				createdAt: this.now(),
				owned: true,
			};
			pending.state = "provisioning";
			this.store.put("managed", records.filter((r) => r.workstreamId !== id).concat(pending));
			try {
				const r = await this.managed.provision(id, baseline);
				this.store.put("managed", records.filter((r) => r.workstreamId !== id).concat(r));
				return r;
			} catch (error) {
				pending.error = "Managed provisioning incomplete; retry or inspect the owned resource";
				this.store.put("managed", records.filter((r) => r.workstreamId !== id).concat(pending));
				throw error;
			}
		});
	}
	managedPublish(p: Principal, cmd: Command, pack: Uint8Array, head: string) {
		return this.serialize(async () => {
			const c = new WorkstreamController(this.state(), this.now());
			c.authorize(p);
			const w = c.state.workstreams.find((w) => w.id === cmd.workstreamId);
			if (!w || w.owner !== p.developerId || !/^[a-f0-9]{40}$/.test(head))
				throw new CoordinationError(403, "Workstream owner and exact commit required");
			const records = this.store.get<ManagedWorkspaceRecord[]>("managed") ?? [],
				r = records.find((r) => r.workstreamId === w.id);
			if (!r || !this.managed) throw new CoordinationError(409, "Managed workspace required");
			await this.git.importPack(pack);
			if ((await this.git.mergeBase(r.baseline, head)) !== r.baseline)
				throw new CoordinationError(409, "Original workspace baseline is not preserved");

			const o: Observation = {
				id: `managed:${head}`,
				workstreamIds: [w.id],
				branch: "main",
				source: "managed_git",
				verified: false,
				at: this.now(),
				...(await this.managed.validate({ ...r, baseline: w.plans.at(-1)!.baseline }, head)),
			};
			c.observe(o, p, { ...cmd, tool: "report_change" });
			const d = decide(c.state, w.id, this.now(), o);
			if (d.publication !== "PROCEED") throw new CoordinationError(409, `Managed publication ${d.publication}: ${d.nextAction}`);
			const published = await this.managed.publish(r, head);
			this.store.put(
				"managed",
				records.map((old) => (old.workstreamId === w.id ? published : old)),
			);
			c.observe({ ...o, id: `managed:published:${head}`, verified: true }, p);
			this.save(c.state);
			return decide(c.state, w.id, this.now());
		});
	}
	async enqueueSemantic() {
		const s = this.state();
		if (s.project.policy.semantic === "off" || !this.ai) return;
		const jobs = this.store.get<JevJob[]>("jev:jobs") ?? [],
			fingerprint = semanticFingerprint(s);
		const source = await this.git.readFiles(s.index.revision).catch(() => ({}) as Record<string, string>);
		for (const job of jobs)
			if (job.packet.fingerprint !== fingerprint && job.status !== "complete" && job.status !== "running") job.status = "superseded";
		const active = s.workstreams.filter((w) => w.state === "active" && w.plans.length);
		for (const w of active)
			for (const other of active.filter((o) => o.id !== w.id)) {
				const id = `${w.id}:${other.id}:${w.plans.length}:${other.plans.length}:${s.project.version}`;
				if (jobs.some((j) => j.id === id && j.packet.fingerprint === fingerprint)) continue;
				const evidence = [w, other]
					.flatMap((stream) => stream.plans.at(-1)?.writeSet ?? [])
					.flatMap((r) => {
						const resolved = resolveResource(r, s.index),
							file = s.index.files.find((f) => f.path === resolved.file);
						if (!file) return [];
						return [
							{
								id: `index:${s.index.revision}:${resolved.id}`,
								revision: s.index.revision,
								resource: resolved.id,
								excerpt: JSON.stringify({
									symbols: file.symbols,
									imports: file.imports,
									source: source[file.path]?.slice(0, 6000),
									limitations: file.limitation,
								}),
								verified: source[file.path] !== undefined && s.project.canonicalHead === s.index.revision,
							},
						];
					});
				try {
					jobs.push({ id, packet: packetFor(s, w.id, other.id, evidence), status: "queued", attempts: 0, nextAt: this.now() });
				} catch {
					jobs.push({
						id,
						packet: { fingerprint, workstreamId: w.id, otherId: other.id, resources: [], evidence: [], state: {}, questions: {} },
						status: "uncertain",
						attempts: 0,
						nextAt: this.now(),
						error: "Evidence exceeds coverage or budget",
					});
				}
			}
		this.store.put("jev:jobs", jobs);
		this.background(this.runJev());
	}
	async runJev() {
		if (!this.ai) return;
		const jobs = this.store.get<JevJob[]>("jev:jobs") ?? [];
		for (const job of jobs)
			if (job.status === "running" && !this.running.has(job.id) && (job.deadline ?? 0) <= this.now()) {
				job.status = job.attempts < JEV_LIMITS.attempts ? "queued" : "unavailable";
				job.error = "Interrupted request exceeded its durable deadline";
				job.nextAt = this.now();
				this.updateJob(job);
			}
		const ready = jobs.filter((j) => j.status === "queued" && j.nextAt <= this.now()).slice(0, JEV_LIMITS.concurrency - this.running.size);
		await Promise.all(
			ready.map(async (job) => {
				if (this.running.has(job.id)) return;
				this.running.add(job.id);
				try {
					const day = new Date(this.now()).toISOString().slice(0, 10),
						usage = this.store.get<{ attempts: number; tokens: number }>(`jev:usage:${day}`) ?? { attempts: 0, tokens: 0 };
					const reserve = new TextEncoder().encode(stable({ state: job.packet.state, questions: job.packet.questions })).length;
					if (usage.attempts >= JEV_LIMITS.dailyAttempts || usage.tokens + reserve > JEV_LIMITS.dailyTokens) {
						job.status = "unavailable";
						job.error = "Daily usage budget exhausted";
						return;
					}
					this.store.put(`jev:usage:${day}`, { attempts: usage.attempts + 1, tokens: usage.tokens + reserve });
					job.status = "running";
					job.attempts++;
					job.startedAt = this.now();
					job.deadline = this.now() + JEV_LIMITS.deadline;
					this.updateJob(job);
					// Do not free this slot at the logical deadline: an uncancelled binding call still consumes it.
					const raw = await this.ai!.run("typesafe/jev", { state: job.packet.state, questions: job.packet.questions });
					job.result = raw;
					const usageResult = JevResponse.safeParse(raw);
					if (usageResult.success) {
						const current = this.store.get<{ attempts: number; tokens: number }>(`jev:usage:${day}`)!;
						this.store.put(`jev:usage:${day}`, { ...current, tokens: current.tokens - reserve + usageResult.data.usage.input_tokens });
					}
					if (this.now() > job.deadline) throw new Error("Logical deadline exceeded");
					const constraints = validateAssessment(job.packet, raw);
					await this.serialize(() => {
						const c = new WorkstreamController(this.state(), this.now());
						if (semanticFingerprint(c.state) !== job.packet.fingerprint) {
							job.status = "superseded";
							return;
						}
						for (const constraint of constraints) c.applySemantic(constraint, false);
						this.save(c.state);
						job.status = "complete";
					});
				} catch (error) {
					job.error = (error as Error).message;
					job.status = job.attempts < JEV_LIMITS.attempts ? "queued" : "unavailable";
					job.nextAt = this.now() + 1000 * 2 ** job.attempts;
				} finally {
					this.running.delete(job.id);
					this.updateJob(job);
				}
			}),
		);
	}
	private updateJob(job: JevJob) {
		const jobs = this.store.get<JevJob[]>("jev:jobs") ?? [];
		this.store.put(
			"jev:jobs",
			jobs.map((j) => (j.id === job.id ? job : j)),
		);
	}
	nextAlarm() {
		const dates = (this.store.get<JevJob[]>("jev:jobs") ?? []).flatMap((j) =>
			j.status === "queued" ? [j.nextAt] : j.status === "running" && !this.running.has(j.id) ? [j.deadline ?? this.now()] : [],
		);
		return dates.length ? Math.min(...dates) : undefined;
	}
}
