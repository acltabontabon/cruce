import { DurableObject } from "cloudflare:workers";
import { resolveResource, resourceLabel } from "../core/airspace.ts";
import type { ControllerState, TowerEvent } from "../core/controller.ts";
import { Controller, ControllerError } from "../core/controller.ts";
import { TERMINAL_PHASES } from "../core/domain.ts";
import { CoordinationError } from "../core/workstreams.ts";
import type { JevBinding } from "../intelligence/jev.ts";
import { type DecisionJudge, RuleBasedDecisionJudge } from "../intelligence/judge.ts";
import { type DemoCommand, type HumanCommand, PROJECTS, type ProjectMeta, type ServerMessage, type Snapshot } from "../shared/api.ts";
import type { Command, Principal, ProjectConnection } from "../shared/coordination.ts";
import type { Actor, PlatformCommand } from "../shared/platform.ts";
import { ArtifactsHost } from "./artifacts-host.ts";
import { type DemoStatus, delayFor, initialDemoStatus, prepareDemo, runNextStep } from "./demo-director.ts";
import type { DeploymentParams } from "./deployment-workflow.ts";
import { ResourceBoundary } from "./deployments.ts";
import { type ArtifactsEvent, EventSubscriptions } from "./event-subscriptions.ts";
import { SqlFs } from "./git/sql-fs.ts";
import { GitWorkspace } from "./git/workspace.ts";
import { ProjectGit } from "./project-git.ts";
import { ProjectRuntime } from "./project-runtime.ts";
import { Tower, type TowerStore } from "./tower.ts";

/**
 * One Durable Object per project: the Cruce Control Tower. For native projects it is the single
 * authority for missions, coordination, proposals, verification, policy, environments and
 * lineage around the project's Artifacts repository. It also hosts the deterministic `/demo`.
 */

export interface TowerEnv {
	ARTIFACTS?: Artifacts;
	ARTIFACTS_NAMESPACE: string;
	CF_ACCOUNT_ID?: string;
	EVENTS_QUEUE_ID?: string;
	CF_EVENTS_API_TOKEN?: string;
	GIT_BACKEND?: string;
	AI?: JevBinding;
	CRUCE_SECRET?: string;
	DEPLOYMENT_WORKFLOW?: Workflow<DeploymentParams>;
}

const LIVE_TICK_MS = 30_000;

export class ControlTower extends DurableObject<TowerEnv> {
	private projectRuntime?: ProjectRuntime;
	private projectOpening?: Promise<ProjectRuntime>;
	private tower?: Tower;
	private meta?: ProjectMeta;
	private opening?: Promise<Tower>;
	private stepping = false;
	private demoQueue: Promise<unknown> = Promise.resolve();
	private alarmQueue: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: TowerEnv) {
		super(ctx, env);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, flight TEXT, body TEXT NOT NULL)`,
		);
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
	}

	private async nativeProject(project: ProjectConnection): Promise<ProjectRuntime> {
		if (this.projectOpening) return this.projectOpening;
		if (this.projectRuntime) {
			await this.projectRuntime.coordination.metadata(project);
			return this.projectRuntime;
		}
		this.projectOpening = (async () => {
			const git = new GitWorkspace(new SqlFs(this.ctx.storage.sql), "/native.git"),
				host = this.env.ARTIFACTS ? new ArtifactsHost(this.env.ARTIFACTS, this.env.ARTIFACTS_NAMESPACE) : undefined;
			const store = this.store();
			const resources = new ResourceBoundary(
				store,
				{ CRUCE_SECRET: this.env.CRUCE_SECRET },
				{
					accountId: this.env.CF_ACCOUNT_ID,
					namespace: this.env.ARTIFACTS_NAMESPACE,
					host,
				},
			);
			const workflow = this.env.DEPLOYMENT_WORKFLOW;
			const runtime = new ProjectRuntime(
				store,
				git,
				project,
				host,
				(p) => this.ctx.waitUntil(p.then(() => this.schedule())),
				Date.now,
				this.env.AI,
				{
					namespace: this.env.ARTIFACTS_NAMESPACE,
					resources,
					orchestrate: workflow
						? async (deploymentId) =>
								void (await workflow.create({
									id: `${project.id}-${deploymentId}`.toLowerCase(),
									params: { projectId: project.id, deploymentId },
								}))
						: undefined,
				},
			);
			this.ctx.storage.kv.put("native-project", project);
			await runtime.initialize();
			this.projectRuntime = runtime;
			return runtime;
		})();
		try {
			return await this.projectOpening;
		} finally {
			this.projectOpening = undefined;
		}
	}
	async coordination(project: ProjectConnection, cmd: Command, actor: Principal) {
		const runtime = await this.nativeProject(project),
			result = await runtime.coordination.command(cmd, actor);
		await this.schedule();
		return result;
	}
	async nativeCommand(project: ProjectConnection, cmd: PlatformCommand, actor: Actor) {
		const runtime = await this.nativeProject(project),
			result = await runtime.command(cmd, actor);
		await this.schedule();
		return result;
	}
	async projectSnapshot(project: ProjectConnection, actor: Actor) {
		return (await this.nativeProject(project)).snapshot(actor);
	}
	async projectOverride(
		project: ProjectConnection,
		actor: Principal,
		id: string,
		resources: string[],
		reason: string,
		fingerprint: string,
		expiresAt: number,
	) {
		return (await this.nativeProject(project)).coordination.override(actor, id, resources, reason, fingerprint, expiresAt);
	}
	async exportSource(project: ProjectConnection, actor: Principal) {
		const runtime = await this.nativeProject(project);
		runtime.authorize(actor);
		return {
			head: runtime.coordination.state().project.canonicalHead!,
			pack: await runtime.git.exportPack(runtime.coordination.state().project.canonicalHead!),
		};
	}
	async projectArtifactEvent(project: ProjectConnection) {
		const runtime = await this.nativeProject(project);
		return runtime.verifySource();
	}
	/** Explicit, human-initiated provisioning of the project's canonical Artifacts repository. */
	async provisionProject(project: ProjectConnection, actor: Actor) {
		const runtime = await this.nativeProject(project);
		return runtime.provision(actor);
	}
	async connectAccount(project: ProjectConnection, actor: Actor, input: { accountId: string; token: string; label?: string } | null) {
		const runtime = await this.nativeProject(project);
		runtime.authorize(actor);
		if (actor.kind !== "human" || !actor.maintainer) throw new CoordinationError(403, "Human maintainer connects Cloudflare accounts");
		if (!runtime.options.resources) throw new CoordinationError(503, "Resource boundary unavailable");
		if (!input) {
			runtime.options.resources.disconnect();
			return runtime.options.resources.account() ?? null;
		}
		return runtime.options.resources.connect(input, actor.developerId);
	}
	/** Called by DeploymentWorkflow; also safe to call repeatedly. */
	async deploymentTick(deploymentId: string, expire = false) {
		const project = this.ctx.storage.kv.get("native-project") as ProjectConnection | undefined;
		if (!project) throw new CoordinationError(404, "No native project");
		return (await this.nativeProject(project)).deploymentTick(deploymentId, expire);
	}

	// ── setup ───────────────────────────────────────────────────────────

	private async open(projectId: string): Promise<Tower> {
		if (this.opening) return this.opening;
		if (this.tower && this.meta?.id === projectId) return this.tower;
		const opening = this.initialize(projectId);
		this.opening = opening;
		try {
			return await opening;
		} catch (error) {
			// A later request can retry bootstrap rather than reuse a half-initialized tower.
			this.tower = undefined;
			this.meta = undefined;
			throw error;
		} finally {
			this.opening = undefined;
		}
	}

	private async initialize(projectId: string): Promise<Tower> {
		const meta = PROJECTS.find((p) => p.id === projectId);
		if (!meta) throw new Error(`unknown project ${projectId}`);
		this.ctx.storage.kv.put("projectId", projectId);
		const useArtifacts = !!this.env.ARTIFACTS && this.env.GIT_BACKEND !== "local";
		const host = useArtifacts && this.env.ARTIFACTS ? new ArtifactsHost(this.env.ARTIFACTS, this.env.ARTIFACTS_NAMESPACE) : undefined;
		const git = new ProjectGit(new GitWorkspace(new SqlFs(this.ctx.storage.sql)), meta.repo, host);
		const subs = this.subscriptions();
		const tower = new Tower(
			{
				id: meta.id,
				name: meta.name,
				repo: meta.repo,
				namespace: host ? this.env.ARTIFACTS_NAMESPACE : "local",
				defaultBranch: "main",
				mode: meta.mode,
				gitBackend: host ? "artifacts" : "simulated",
			},
			git,
			this.store(),
			{
				onChange: (state, events) => {
					this.broadcastUpdate(state, events, this.demoStatus());
					this.ctx.waitUntil(this.schedule());
				},
				onRepo: subs ? async (repo) => void (await subs.subscribeRepo(repo)) : undefined,
				onRepoRemoved: host
					? async (repo) => {
							if (!subs) throw new Error("Event subscription cleanup credentials unavailable");
							await subs.unsubscribeRepo(repo);
						}
					: undefined,
				background: (work) => this.ctx.waitUntil(work),
			},
			Date.now,
			meta.firstFlight,
			this.judges(meta),
		);
		tower.restore();
		this.meta = meta;
		this.tower = tower;
		await tower.bootstrap();
		await this.schedule();
		return tower;
	}

	/** The demo uses rule-based judgment only; models never grant permission. */
	private judges(_meta: ProjectMeta): DecisionJudge[] {
		return [new RuleBasedDecisionJudge()];
	}

	private subscriptions(): EventSubscriptions | undefined {
		const { CF_ACCOUNT_ID, EVENTS_QUEUE_ID, CF_EVENTS_API_TOKEN, ARTIFACTS } = this.env;
		if (!ARTIFACTS || !CF_ACCOUNT_ID || !EVENTS_QUEUE_ID || !CF_EVENTS_API_TOKEN) return undefined;
		return new EventSubscriptions({
			accountId: CF_ACCOUNT_ID,
			queueId: EVENTS_QUEUE_ID,
			apiToken: CF_EVENTS_API_TOKEN,
			namespace: this.env.ARTIFACTS_NAMESPACE,
		});
	}

	private store(): TowerStore {
		const kv = this.ctx.storage.kv;
		const sql = this.ctx.storage.sql;
		return {
			get: <T>(key: string) => kv.get(key) as T | undefined,
			put: (key, value) => kv.put(key, value),
			delete: (key) => void kv.delete(key),
			appendEvents: (events: TowerEvent[]) => {
				for (const e of events) {
					sql.exec(
						`INSERT OR REPLACE INTO events (seq, at, type, flight, body) VALUES (?, ?, ?, ?, ?)`,
						e.seq,
						e.at,
						e.type,
						e.flightId ?? null,
						JSON.stringify(e),
					);
				}
			},
		};
	}

	// ── RPC surface (called by the Worker) ──────────────────────────────

	async snapshot(projectId: string): Promise<Snapshot> {
		const tower = await this.open(projectId);
		return {
			state: tower.state,
			demo: this.demoStatus(),
			git: { backend: tower.git.backend, namespace: tower.git.namespace, canonicalRemote: tower.state.project.remote },
			integrationBlockers: this.integrationBlockers(tower.state),
		};
	}

	private integrationBlockers(state: ControllerState): Record<string, string[]> {
		const controller = new Controller(state, Date.now());
		return Object.fromEntries(
			state.flights
				.filter((flight) => !TERMINAL_PHASES.has(flight.phase))
				.map((flight) => [flight.id, controller.landingBlockers(flight.id)]),
		);
	}

	async command(projectId: string, cmd: HumanCommand, by: string): Promise<unknown> {
		const tower = await this.open(projectId);
		switch (cmd.type) {
			case "override":
				tower.mutate((c) => c.applyOverride(cmd.congestionKey, cmd.kind, by, cmd.flightId));
				return { ok: true };
			case "clear-override":
				tower.mutate((c) => c.clearOverride(cmd.congestionKey, by));
				return { ok: true };
			case "dismiss":
				tower.mutate((c) => c.dismissAttention(cmd.attentionId, by));
				return { ok: true };
			case "cancel":
				tower.mutate((c) => c.cancel(cmd.flightId, by));
				await tower.closeFlight(cmd.flightId);
				return { ok: true };
			case "retain":
				tower.retain(cmd.flightId, cmd.keep, by);
				await this.schedule();
				return { ok: true };
			case "reroute":
				return this.reroute(tower, cmd.flightId, by);
			case "land":
				return tower.land(cmd.flightId);
		}
	}

	/**
	 * REROUTE: ask a Flight to plan around contested airspace. Mock agents comply immediately by moving
	 * held writes into their read set; live agents receive the instruction with their next status.
	 */
	private reroute(tower: Tower, flightId: string, by: string) {
		const f = tower.flight(flightId);
		const held = tower.state.traffic.clearances[flightId]?.held ?? [];
		const instruction = tower.mutate((c) => c.requestReroute(flightId, by));
		const labels = held.map((h) => resourceLabel(h.resource, tower.state.index));
		if (f.agent !== "mock") return { ok: true, delivered: "with next status" };
		if (!f.plan) throw new Error("reroute requires a plan");
		const heldIds = new Set(held.map((h) => h.resource));
		const { flightId: _id, planVersion: _v, filedAt: _t, baseline: _b, amendment: _a, ...fields } = f.plan;
		const index = tower.state.index;
		const plan = {
			...fields,
			writeSet: fields.writeSet.filter((w) => !heldIds.has(resolveResource(w, index).id)),
			readSet: [...fields.readSet, ...labels.map((l) => ({ type: "symbol" as const, resource: l, reason: "rerouted: read only" }))],
			assumptions: [...fields.assumptions, `rerouted around ${labels.join(", ")}`],
		};
		tower.mutate((c) => c.submitPlan(flightId, plan, `rerouted around ${labels.join(", ")} by ${by}`));
		tower.mutate((c) => c.ackInstruction(flightId, instruction.id));
		return { ok: true };
	}

	async demo(projectId: string, cmd: DemoCommand): Promise<DemoStatus> {
		return this.withDemoLock(() => this.runDemo(projectId, cmd));
	}

	private withDemoLock<T>(work: () => Promise<T>): Promise<T> {
		const next = this.demoQueue.then(work, work);
		this.demoQueue = next.catch(() => undefined);
		return next;
	}

	private async runDemo(projectId: string, cmd: DemoCommand): Promise<DemoStatus> {
		const tower = await this.open(projectId);
		if (tower.project.mode !== "demo") throw new Error("not a demo project");
		let status = this.demoStatus() ?? initialDemoStatus();
		// Public deployments: a reset recreates Flight repos, so it is rate limited per project.
		if (cmd.op === "reset" || cmd.op === "replay" || (cmd.op === "play" && status.finished)) {
			const last = (this.ctx.storage.kv.get("lastReset") as number | undefined) ?? 0;
			const wait = 45_000 - (Date.now() - last);
			if (wait > 0) throw new Error(`The demo was reset moments ago; try again in ${Math.ceil(wait / 1000)}s`);
			this.ctx.storage.kv.put("lastReset", Date.now());
		}
		switch (cmd.op) {
			case "prepare":
				if (status.next !== 0 || tower.state.flights.length) return status;
				status = await prepareDemo(tower, status, (progress) => this.saveDemo(progress));
				break;
			case "replay":
				this.saveDemo(initialDemoStatus());
				await tower.reset();
				status = { ...initialDemoStatus(), running: true, nextAt: Date.now() + delayFor(initialDemoStatus()) };
				break;
			case "play":
				if (status.finished) {
					await tower.reset();
					status = initialDemoStatus();
				}
				status = { ...status, running: true, error: undefined, nextAt: Date.now() + delayFor(status) };
				break;
			case "pause":
				status = { ...status, running: false, nextAt: undefined };
				break;
			case "step":
				this.saveDemo({ ...status, running: false, nextAt: undefined });
				return this.advance(tower);
			case "reset":
				this.saveDemo({ ...initialDemoStatus(), running: false });
				await tower.reset();
				status = await prepareDemo(tower, initialDemoStatus(), (progress) => this.saveDemo(progress));
				break;
			case "speed":
				status = { ...status, speed: cmd.speed ?? 1 };
				if (status.running) status.nextAt = Date.now() + delayFor(status);
				break;
		}
		this.saveDemo(status);
		await this.schedule();
		this.broadcastUpdate(tower.state, [], status);
		return status;
	}

	private async advance(tower: Tower): Promise<DemoStatus> {
		if (this.stepping) return this.demoStatus() ?? initialDemoStatus();
		this.stepping = true;
		try {
			const before = this.demoStatus() ?? initialDemoStatus();
			this.saveDemo({ ...before, nextAt: undefined });
			const after = await runNextStep(tower, before);
			const latest = this.demoStatus() ?? before;
			const running = latest.running && !after.finished && !after.error;
			const status: DemoStatus = { ...after, running, speed: latest.speed, nextAt: running ? Date.now() + delayFor(after) : undefined };
			this.saveDemo(status);
			this.broadcastUpdate(tower.state, [], status);
			await this.schedule();
			return status;
		} finally {
			this.stepping = false;
		}
	}

	async history(projectId: string, target: string) {
		const tower = await this.open(projectId);
		const flight = target === "canonical" ? undefined : tower.flight(target);
		if (flight && flight.phase !== "landed" && flight.cleanup?.deletedAt !== undefined) throw new ControllerError("Work expired", 410);
		const ref =
			flight?.phase === "landed"
				? (flight.artifact?.head ?? (flight.landedCommit as string))
				: target === "canonical"
					? "refs/heads/main"
					: `refs/heads/flights/${target}`;
		return tower.git.history(ref, 30);
	}

	async changes(projectId: string, flightId: string, path?: string) {
		const tower = await this.open(projectId);
		return tower.git.changes(tower.flight(flightId), tower.state.canonical.head, path);
	}

	async auditLog(projectId: string, limit = 200): Promise<TowerEvent[]> {
		await this.open(projectId);
		return this.ctx.storage.sql
			.exec<{ body: string }>(`SELECT body FROM events ORDER BY seq DESC LIMIT ?`, limit)
			.toArray()
			.map((r) => JSON.parse(r.body) as TowerEvent);
	}

	/** Artifacts repository events from the queue consumer. Idempotent per event. */
	async artifactEvent(projectId: string, evt: ArtifactsEvent): Promise<void> {
		const tower = await this.open(projectId);
		const key = `${evt.type}:${evt.source.repoName}:${evt.payload.after ?? evt.payload.tokenId ?? ""}:${evt.metadata.eventTimestamp}`;
		if (this.ctx.storage.sql.exec(`SELECT 1 FROM seen WHERE key = ?`, key).toArray().length) return;
		this.ctx.storage.sql.exec(`INSERT INTO seen (key, at) VALUES (?, ?)`, key, Date.now());

		const repo = evt.source.repoName;
		const flight = tower.state.flights.find((f) => f.artifact?.repo === repo);
		const short = (s?: string) => (s ? s.slice(0, 7) : "—");
		const kind = evt.type.replace("cf.artifacts.repo.", "");
		tower.mutate((c) => {
			if (kind === "pushed" && evt.payload.ref === "refs/notes/cruce") {
				c.note("artifacts.event", "artifacts", `Artifacts confirmed Cruce notes on ${repo} · ${short(evt.payload.after)}`, flight?.id);
			} else if (kind === "pushed") {
				c.note("artifacts.event", "artifacts", `Artifacts confirmed push to ${repo} · ${short(evt.payload.after)}`, flight?.id, [
					`${evt.payload.ref} ${short(evt.payload.before)} → ${short(evt.payload.after)}`,
					...(evt.payload.commits ?? []).slice(0, 3).map((x) => `${x.id.slice(0, 7)} ${x.message.split("\n")[0]}`),
				]);
				if (flight && !TERMINAL_PHASES.has(flight.phase) && evt.payload.after && evt.payload.ref === "refs/heads/main")
					c.recordPush(flight.id, evt.payload.after, "event");
			} else {
				c.note(
					"artifacts.event",
					"artifacts",
					`Artifacts ${kind} · ${repo}${evt.payload.scope ? ` (${evt.payload.scope})` : ""}`,
					flight?.id,
				);
			}
		});
	}

	// ── realtime ────────────────────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		const projectId = request.headers.get("x-cruce-project") ?? "demo";
		const tower = await this.open(projectId);
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		const snapshot: ServerMessage = {
			type: "snapshot",
			state: tower.state,
			demo: this.demoStatus(),
			git: { backend: tower.git.backend, namespace: tower.git.namespace, canonicalRemote: tower.state.project.remote },
			integrationBlockers: this.integrationBlockers(tower.state),
		};
		pair[1].send(JSON.stringify(snapshot));
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (message === "ping") ws.send("pong");
	}

	async webSocketClose(ws: WebSocket, code: number) {
		// Reserved codes (1005/1006) cannot be echoed back; the socket is already gone in that case.
		try {
			ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "closing");
		} catch {
			// already closed
		}
	}

	private broadcast(msg: ServerMessage) {
		const data = JSON.stringify(msg);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(data);
			} catch {
				// socket already gone; the client reconnects and receives a fresh snapshot
			}
		}
	}

	private broadcastUpdate(state: ControllerState, events: TowerEvent[], demo: DemoStatus | null) {
		this.broadcast({ type: "update", state, events, demo, integrationBlockers: this.integrationBlockers(state) });
	}

	// ── time ────────────────────────────────────────────────────────────

	private demoStatus(): DemoStatus | null {
		if (this.meta?.mode !== "demo") return null;
		return (this.ctx.storage.kv.get("demo") as DemoStatus | undefined) ?? initialDemoStatus();
	}

	private saveDemo(status: DemoStatus) {
		this.ctx.storage.kv.put("demo", status);
	}

	private schedule(): Promise<void> {
		const next = this.alarmQueue.then(() => this.updateAlarm());
		this.alarmQueue = next.catch(() => undefined);
		return next;
	}

	private async updateAlarm() {
		const demo = this.demoStatus();
		const candidates: number[] = [];
		const semanticAt = this.projectRuntime?.coordination.nextAlarm();
		if (this.projectRuntime?.host && this.projectRuntime.coordination.state().workstreams.some((w) => w.state === "active"))
			candidates.push(Date.now() + LIVE_TICK_MS);
		if (semanticAt !== undefined) candidates.push(Math.max(Date.now() + 1000, semanticAt));
		if (demo?.running && demo.nextAt) candidates.push(demo.nextAt);
		const cleanupAt = this.tower?.cleanup.nextAt();
		if (cleanupAt !== undefined) candidates.push(Math.max(Date.now() + 1_000, cleanupAt));
		if (candidates.length) {
			const previous = await this.ctx.storage.getAlarm();
			const next = Math.min(...candidates);
			if (previous !== next) await this.ctx.storage.setAlarm(next);
		} else await this.ctx.storage.deleteAlarm();
	}

	async alarm() {
		const project = this.ctx.storage.kv.get("native-project") as ProjectConnection | undefined;
		if (project) {
			const runtime = await this.nativeProject(project);
			await runtime.verifySource();
			await runtime.coordination.runJev();
			await this.schedule();
			return;
		}
		const projectId = (this.ctx.storage.kv.get("projectId") as string | undefined) ?? "demo";
		const tower = await this.open(projectId);
		const demo = this.demoStatus();
		if (demo?.running && demo.nextAt && demo.nextAt <= Date.now() + 50) {
			await this.withDemoLock(async () => {
				const current = this.demoStatus();
				if (current?.running && current.nextAt && current.nextAt <= Date.now() + 50) await this.advance(tower);
				else await this.schedule();
			});
			await tower.cleanup.run();
			await this.schedule();
			return;
		}
		await tower.cleanup.run();
		await this.schedule();
	}
}

export type { ControllerState };
