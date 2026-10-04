import { initialPlatform, PlatformController } from "../core/platform.ts";
import { CoordinationError, decide, WorkstreamController } from "../core/workstreams.ts";
import type { JevBinding } from "../intelligence/jev.ts";
import { buildIndex } from "../intelligence/structural-index.ts";
import { CommandInput, type Principal, type ProjectConnection } from "../shared/coordination.ts";
import { type Actor, PLATFORM_READ_TOOLS, type PlatformCommand, type PlatformState } from "../shared/platform.ts";
import type { ArtifactsHost } from "./artifacts-host.ts";
import { CoordinationRuntime } from "./coordination-runtime.ts";
import type { GitWorkspace } from "./git/workspace.ts";
import { CloudflareArtifactWorkspace } from "./managed-workspace.ts";
import type { TowerStore } from "./tower.ts";

const SOURCE = "refs/cruce/accepted",
	EVIDENCE = "refs/cruce/evidence";
/** Native source, collaboration and promotion authority. No external Git provider is consulted. */
export class ProjectRuntime {
	readonly coordination: CoordinationRuntime;
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		readonly store: TowerStore,
		readonly git: GitWorkspace,
		readonly project: ProjectConnection,
		readonly host: ArtifactsHost | undefined,
		readonly background: (p: Promise<unknown>) => void,
		readonly now: () => number = Date.now,
		ai?: JevBinding,
	) {
		this.coordination = new CoordinationRuntime(
			store,
			git,
			background,
			now,
			ai,
			host ? new CloudflareArtifactWorkspace(host, git, project.artifactRepository, now) : undefined,
		);
	}
	private serialize<T>(run: () => T | Promise<T>) {
		const next = this.queue.then(run);
		this.queue = next.catch(() => {});
		return next;
	}
	state() {
		return this.store.get<PlatformState>("platform") ?? initialPlatform();
	}
	private save(state: PlatformState) {
		this.store.put("platform", state);
	}
	private author() {
		return { name: "Cruce", email: "system@cruce.invalid", timestamp: Math.floor(this.now() / 1000) };
	}
	async initialize() {
		await this.git.ensureInit();
		let head = await this.git.resolve(SOURCE);
		if (this.host) {
			const repo = await this.host.ensure(this.project.artifactRepository, `Cruce project ${this.project.id}`);
			const info = await this.host.info(repo.name);
			if (info.description !== `Cruce project ${this.project.id}`) throw new CoordinationError(409, "Project artifact ownership mismatch");
			if ((await this.host.log(repo.name, "main", 1)).length)
				head = (await this.host.withToken(repo.name, "read", (token) => this.git.fetch({ url: repo.remote, token, localRef: SOURCE })))
					.result;
			else {
				head =
					head ??
					(await this.git.commit({
						ref: SOURCE,
						parent: null,
						files: { "README.md": `# ${this.project.name}\n\nSource is governed by Cruce proposals and promotion.\n` },
						message: "Initial source revision",
						author: this.author(),
					}));
				await this.host.withToken(repo.name, "write", (token) =>
					this.git.push({ url: repo.remote, token, localRef: SOURCE, remoteRef: "refs/heads/main", force: false }),
				);
			}
		} else
			head =
				head ??
				(await this.git.commit({
					ref: SOURCE,
					parent: null,
					files: { "README.md": `# ${this.project.name}\n` },
					message: "Offline source fixture",
					author: this.author(),
				}));
		if (!head) throw new CoordinationError(503, "Source revision unavailable");
		const known = this.store.get<ReturnType<CoordinationRuntime["state"]>>("coordination");
		await this.git.setRef(SOURCE, known?.project.canonicalHead ?? head);
		await this.coordination.initialize(this.project, head, await this.git.readFiles(head));
		if (!this.store.get("platform")) this.save(initialPlatform());
		this.store.put("source-health", {
			state: known && known.project.canonicalHead !== head ? "unexpected_revision" : "verified",
			observedHead: head,
			verifiedHead: known?.project.canonicalHead ?? head,
			at: this.now(),
		});
	}
	authorize(actor: Principal) {
		new WorkstreamController(this.coordination.state(), this.now()).authorize(actor);
	}
	snapshot(actor: Actor) {
		this.authorize(actor);
		const coordination = this.coordination.snapshot(actor),
			state = this.state(),
			canonical = coordination.project.canonicalHead!;
		return {
			...state,
			missions: state.missions.map((m) => {
				const w = coordination.workstreams.find((w) => w.id === m.workstreamId);
				return {
					...m,
					plan: w?.plans.at(-1) ?? m.plan,
					state: w?.state === "integrated" || w?.state === "completed" ? "completed" : m.state,
				};
			}),
			project: coordination.project,
			coordination,
			proposals: state.proposals.map((p) => ({ ...p, readiness: new PlatformController(state, this.now()).readiness(p.id, canonical) })),
			replays: undefined,
			sourceBackend: this.host ? "cloudflare_artifacts" : "offline_fixture",
			sourceHealth: this.store.get("source-health"),
			permissions: { contribute: actor.canWrite !== false, govern: actor.kind === "human" && actor.maintainer === true },
		};
	}
	verifySource() {
		return this.serialize(async () => {
			if (!this.host) return;
			const accepted = this.coordination.state().project.canonicalHead;
			try {
				const repo = await this.host.info(this.project.artifactRepository);
				if (repo.description !== `Cruce project ${this.project.id}`) throw new CoordinationError(409, "Source ownership mismatch");
				const observed = await this.host.withToken(repo.name, "read", (token) =>
					this.git.fetch({ url: repo.remote, token, localRef: "refs/cruce/observed-source" }),
				);
				const health = {
					state: observed.result === accepted ? "verified" : "unexpected_revision",
					observedHead: observed.result,
					verifiedHead: accepted,
					at: this.now(),
				};
				this.store.put("source-health", health);
				return health;
			} catch {
				this.store.put("source-health", { state: "unavailable", verifiedHead: accepted, at: this.now() });
				return { state: "unavailable" };
			}
		});
	}
	command(cmd: PlatformCommand, actor: Actor) {
		return this.serialize(async () => {
			this.authorize(actor);
			if (cmd.projectId !== this.project.id) throw new CoordinationError(403, "Project authority mismatch");
			const c = new PlatformController(this.state(), this.now()),
				canonical = this.coordination.state().project.canonicalHead!;
			if (PLATFORM_READ_TOOLS.has(cmd.tool)) {
				if (cmd.tool === "read_artifact") {
					const artifact = c.state.artifacts.find((a) => a.id === cmd.artifactId);
					if (!artifact) throw new CoordinationError(404, "Artifact unavailable");
					if (!artifact.storage.path)
						return {
							artifact,
							paths: Object.keys(await this.git.readFiles(artifact.revision)),
							nextAction: "Use get_source for a source excerpt",
						};
					const files = await this.git.readFiles(artifact.storage.revision, (p) => p === artifact.storage.path);
					const body = JSON.parse(files[artifact.storage.path] ?? "null") as { content: string } | null;
					if (!body) throw new CoordinationError(503, "Artifact content unavailable");
					return { artifact, content: body.content };
				}
				if (cmd.tool === "get_source") {
					const revision = cmd.revision ?? canonical,
						files = await this.git.readFiles(revision, cmd.path ? (path) => path === cmd.path : () => true);
					return cmd.path
						? { revision, path: cmd.path, content: files[cmd.path]?.slice(0, 100000), truncated: (files[cmd.path]?.length ?? 0) > 100000 }
						: { revision, paths: Object.keys(files), limitations: [] };
				}
				if (cmd.tool === "get_diff") {
					const p = c.proposal(cmd.proposalId);
					return { revision: p.revision, base: p.base, ...(await this.git.reviewChanges(p.base, p.revision, cmd.path)) };
				}
				if (cmd.tool === "get_history") return { timeline: c.state.timeline, revisions: await this.git.log(SOURCE, 25) };
				return c.execute(cmd, actor, canonical);
			}
			if (!cmd.idempotencyKey) throw new CoordinationError(400, "Idempotency key required");
			if (actor.canWrite === false) throw new CoordinationError(403, "Contribution permission required");
			const replayKey = `${actor.developerId}:${actor.kind}:${cmd.idempotencyKey}`,
				prior = c.state.replays[replayKey];
			if (prior) {
				if (prior.request !== stableCommand(cmd)) throw new CoordinationError(409, "Idempotency key reused with different inputs");
				return prior.result;
			}
			const ledgerKey = `native-io:${replayKey}`,
				pending = this.store.get<{ request: string; revision?: string; ticketId?: string }>(ledgerKey);
			if (pending && pending.request !== stableCommand(cmd))
				throw new CoordinationError(409, "Idempotency key reused with different inputs");
			if (cmd.tool === "promote_proposal") {
				const promoted = await this.promote(cmd, actor, c);
				c.state.replays[replayKey] = { request: stableCommand(cmd), result: promoted };
				this.save(c.state);
				return promoted;
			}
			if (cmd.tool === "rollback") return this.rollback(cmd, actor, c);
			const result = await c.replay(cmd, actor, () => {
				// I/O commands are replayed by the application after durable storage succeeds.
				if (["accept_mission", "publish_artifact", "publish_source"].includes(cmd.tool)) return undefined;
				// execute owns its own replay; remove the provisional replay to avoid recursion.
				return c.execute(cmd, actor, canonical);
			});
			if (result !== undefined) {
				this.save(c.state);
				return result;
			}
			delete c.state.replays[replayKey];
			const m = c.mission(cmd.missionId);
			if (cmd.expectedVersion !== m.version) throw new CoordinationError(409, "Mission changed; refresh context");
			let output: unknown;
			if (cmd.tool === "accept_mission") {
				if (!cmd.workspace || !cmd.agent) throw new CoordinationError(400, "Agent identity and execution context required");
				const work = m.workstreamId ? this.coordination.state().workstreams.find((w) => w.id === m.workstreamId) : undefined;
				const d = (await this.coordination.command(
					CommandInput.parse({
						tool: work ? "attach_workstream" : "register_intent",
						projectId: cmd.projectId,
						idempotencyKey: `mission:${cmd.idempotencyKey}`,
						workstreamId: work?.id,
						expectedVersion: work?.version,
						expectedPlanVersion: work?.plans.at(-1)?.version,
						workspace: cmd.workspace,
						agent: cmd.agent,
						plan: m.plan,
					}),
					actor,
				)) as { workstreamId: string; sessionId: string };
				m.workstreamId = d.workstreamId;
				m.state = "active";
				m.version++;
				if (this.host) await this.coordination.provision(actor, d.workstreamId);
				c.event(actor.developerId, "execution", [m.intentId, m.id, d.workstreamId], `${cmd.agent.tool}: ${m.specialization}`);
				output = { mission: m, coordination: d };
			} else if (cmd.tool === "publish_source") {
				if (!m.workstreamId || !cmd.files || !cmd.base)
					throw new CoordinationError(400, "Accepted mission, exact base and source files required");
				const w = this.coordination.state().workstreams.find((w) => w.id === m.workstreamId)!;
				if (cmd.expectedPlanVersion !== w.plans.at(-1)?.version) throw new CoordinationError(409, "Plan changed; re-evaluate actual scope");
				const writer = this.coordination
					.state()
					.sessions.find(
						(s) =>
							s.id === cmd.sessionId &&
							s.workstreamId === w.id &&
							s.developerId === actor.developerId &&
							s.connected &&
							s.expiresAt > this.now(),
					);
				if (writer?.role !== "writer") throw new CoordinationError(403, "Current mission writer required");
				const record = this.coordination.snapshot(actor).managed.find((r) => r.workstreamId === w.id);
				if (!record || !this.host) throw new CoordinationError(503, "Managed Artifacts workspace required for source publication");
				if (record.head !== cmd.base && record.head !== pending?.revision)
					throw new CoordinationError(409, "Workspace source changed; refresh the exact revision");
				let revision =
					pending?.revision ??
					(await this.git.commit({
						ref: `refs/cruce/candidate/${w.id}`,
						parent: cmd.base,
						files: cmd.files,
						message: cmd.summary ?? m.title,
						author: this.author(),
					}));
				if (!pending?.revision && (await this.git.mergeBase(w.plans.at(-1)!.baseline, revision)) !== w.plans.at(-1)!.baseline) {
					await this.git.setRef(`refs/cruce/candidate/${w.id}`, revision);
					const refresh = await this.git.merge({
						ours: `refs/cruce/candidate/${w.id}`,
						theirs: w.plans.at(-1)!.baseline,
						message: "Refresh isolated source against the amended baseline",
						author: this.author(),
					});
					if (!refresh.clean || !refresh.oid)
						throw new CoordinationError(
							409,
							`Source refresh requires conflict resolution: ${refresh.conflicts.join(", ")}. Existing source is preserved.`,
						);
					revision = refresh.oid;
				}
				this.store.put(ledgerKey, { request: stableCommand(cmd), revision });
				const pack = await this.git.exportPack(revision, cmd.base);
				const observed = this.coordination
					.state()
					.observations.find((o) => o.head === revision && o.verified && o.workstreamIds.includes(w.id));
				const d = observed
					? decide(this.coordination.state(), w.id, this.now(), observed)
					: await this.coordination.managedPublish(
							actor,
							CommandInput.parse({
								tool: "report_change",
								projectId: cmd.projectId,
								idempotencyKey: `source:${cmd.idempotencyKey}`,
								workstreamId: w.id,
								sessionId: cmd.sessionId,
								expectedVersion: w.version,
								expectedPlanVersion: cmd.expectedPlanVersion,
							}),
							pack,
							revision,
						);
				const a = c.artifact({
					kind: "source",
					missionId: m.id,
					intentId: m.intentId,
					title: cmd.title ?? m.title,
					summary: cmd.summary ?? m.title,
					revision,
					parentRevision: w.plans.at(-1)!.baseline,
					contentHash: revision,
					storage: { repository: record.repository, revision },
					producer: { actor: actor.developerId, kind: actor.kind, sessionId: writer.id, tool: writer.tool, model: cmd.model },
					environment: cmd.environment ?? "external agent tools",
					related: cmd.related,
					trust: "verified",
				});
				output = { artifact: a, coordination: d };
			} else if (cmd.tool === "publish_artifact") {
				if (!cmd.kind || cmd.kind === "source" || cmd.content === undefined || !cmd.revision)
					throw new CoordinationError(400, "Typed output, content and parent source revision required");
				if (cmd.related.some((id) => !c.state.artifacts.some((a) => a.id === id)))
					throw new CoordinationError(400, "Related artifact unavailable");
				await this.git.readFiles(cmd.revision, () => false);
				const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cmd.content))))
					.map((b) => b.toString(16).padStart(2, "0"))
					.join("");
				const storage = await this.storeEvidence(
					ledgerKey,
					cmd.content,
					{
						missionId: m.id,
						revision: cmd.revision,
						producer: actor.developerId,
						model: cmd.model,
						kind: cmd.kind,
						hash,
					},
					stableCommand(cmd),
				);
				output = c.artifact({
					kind: cmd.kind,
					missionId: m.id,
					intentId: m.intentId,
					title: cmd.title ?? cmd.kind,
					summary: cmd.summary ?? "",
					revision: cmd.revision,
					parentRevision: cmd.revision,
					contentHash: hash,
					storage,
					producer: { actor: actor.developerId, kind: actor.kind, sessionId: cmd.sessionId, model: cmd.model },
					environment: cmd.environment ?? "external tools",
					related: cmd.related,
					trust: actor.kind === "runtime" ? "verified" : "reported",
				});
			} else throw new CoordinationError(400, "Unsupported native command");
			c.state.replays[replayKey] = { request: JSON.stringify(cmd), result: output }; // replaced below with canonical fingerprint
			c.state.replays[replayKey].request = stableCommand(cmd);
			this.save(c.state);
			return output;
		});
	}
	private async storeEvidence(ledgerKey: string, content: string, metadata: unknown, request: string) {
		if (!this.host) throw new CoordinationError(503, "Cloudflare Artifacts evidence storage unavailable");
		const name = `${this.project.artifactRepository}--evidence`,
			repo = await this.host.ensure(name, `Cruce evidence ${this.project.id}`),
			id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ledgerKey))))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(""),
			path = `artifacts/${id}.json`;
		if ((await this.host.info(name)).description !== `Cruce evidence ${this.project.id}`)
			throw new CoordinationError(409, "Evidence ownership mismatch");
		const pending = this.store.get<{ request: string; revision: string }>(ledgerKey);
		if (pending && pending.request !== request) throw new CoordinationError(409, "Artifact inputs changed");
		const old = await this.git.resolve(EVIDENCE),
			revision =
				pending?.revision ??
				(await this.git.commit({
					ref: EVIDENCE,
					parent: old,
					files: { [path]: JSON.stringify({ metadata, content }) },
					message: "Immutable evidence artifact",
					author: this.author(),
				}));
		this.store.put(ledgerKey, { request, revision });
		await this.git.setRef(EVIDENCE, revision);
		await this.host.withToken(name, "write", (token) =>
			this.git.push({ url: repo.remote, token, localRef: EVIDENCE, remoteRef: "refs/heads/main", force: false }),
		);
		return { repository: name, path, revision };
	}
	private async promote(cmd: PlatformCommand, actor: Actor, c: PlatformController) {
		return this.coordination.withAuthority(async (state) => {
			const p = c.proposal(cmd.proposalId),
				m = c.mission(p.missionId),
				canonical = state.project.canonicalHead!;
			const ticket = c.preparePromotion(cmd, actor, canonical);
			if (ticket.state === "complete") return ticket;
			const ledgerKey = `native-io:${actor.developerId}:${actor.kind}:${cmd.idempotencyKey}`;
			this.store.put(ledgerKey, { request: stableCommand(cmd), ticketId: ticket.id });
			if (!m.workstreamId) throw new CoordinationError(409, "Mission coordination missing");
			const observation = state.observations.find((o) => o.head === p.revision && o.verified && o.workstreamIds.includes(m.workstreamId!));
			if (!observation) throw new CoordinationError(409, "Exact proposal revision has not been verified");
			const decision = decide(state, m.workstreamId, this.now(), observation);
			if (canonical !== ticket.to && decision.integration !== "PROCEED")
				throw new CoordinationError(409, `Coordination ${decision.integration}: ${decision.nextAction}`);
			if (canonical !== ticket.to) ticket.coordinationFingerprint = decision.fingerprint;
			if (!this.host) throw new CoordinationError(503, "Artifacts canonical source required for promotion");
			this.save(c.state); // Durable prepared ticket recovers a push that succeeds before a process restart.
			const repo = await this.host.info(this.project.artifactRepository);
			const remote = await this.host.withToken(repo.name, "read", (token) =>
				this.git.fetch({ url: repo.remote, token, localRef: "refs/cruce/promotion/current" }),
			);
			if (remote.result !== ticket.from && remote.result !== ticket.to)
				throw new CoordinationError(409, "Accepted source changed; refresh proposal");
			if (remote.result !== ticket.to) {
				await this.git.setRef("refs/cruce/promotion/next", ticket.to);
				await this.host.withToken(repo.name, "write", (token) =>
					this.git.push({ url: repo.remote, token, localRef: "refs/cruce/promotion/next", remoteRef: "refs/heads/main", force: false }),
				);
			}
			await this.git.setRef(SOURCE, ticket.to);
			const changes = (await this.git.changes(ticket.from, ticket.to)).files;
			if (canonical !== ticket.to) {
				const wc = new WorkstreamController(state, this.now());
				wc.canonical(
					ticket.to,
					buildIndex(await this.git.readFiles(ticket.to), ticket.to),
					[p.revision],
					observation.changes.length ? evaluateTouched(changes, observation.index) : [],
				);
				this.store.put("coordination", wc.state);
			}
			this.store.put("source-health", { state: "verified", observedHead: ticket.to, verifiedHead: ticket.to, at: this.now() });
			c.completePromotion(ticket.id);
			this.save(c.state);
			return ticket;
		});
	}
	private async rollback(cmd: PlatformCommand, actor: Actor, _c: PlatformController) {
		if (actor.kind !== "human" || !actor.maintainer || !cmd.revision)
			throw new CoordinationError(403, "Human maintainer and target revision required");
		// Rollback creates a proposal with a forward revision; accepted history is never rewritten.
		const current = this.coordination.state().project.canonicalHead!,
			before = await this.git.readFiles(current),
			target = await this.git.readFiles(cmd.revision),
			files: Record<string, string | null> = {};
		for (const path of new Set([...Object.keys(before), ...Object.keys(target)])) files[path] = target[path] ?? null;
		return {
			requiresProposal: true,
			base: current,
			files,
			summary: `Restore source state from ${cmd.revision}`,
			risk: "high",
			nextAction: "Create a rollback mission, publish this source snapshot, attach verification and request human promotion",
		};
	}
}

import { evaluatePublish } from "../core/publish-gate.ts";
import { stable as stableCommand } from "../core/workstreams.ts";

const evaluateTouched = (changes: Parameters<typeof evaluatePublish>[1], index: Parameters<typeof evaluatePublish>[2]) =>
	evaluatePublish([], changes, index, { allowNewTests: false }).touched;
