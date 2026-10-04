import { DurableObject } from "cloudflare:workers";
import { resolveResource, resourceLabel } from "../core/airspace.ts";
import type { ControllerState, TowerEvent } from "../core/controller.ts";
import { clearanceBrief } from "../core/controller.ts";
import { TERMINAL_PHASES } from "../core/domain.ts";
import { type DecisionJudge, ModelDecisionJudge, RuleBasedDecisionJudge } from "../intelligence/judge.ts";
import {
	type DemoCommand,
	type HumanCommand,
	PROJECTS,
	type ProjectMeta,
	type ProtocolRequest,
	type ServerMessage,
	type Snapshot,
} from "../shared/api.ts";
import type { FlightSandbox, TaskStatus } from "./agents/flight-sandbox.ts";
import type { FlightParams } from "./agents/flight-workflow.ts";
import { ArtifactsHost } from "./artifacts-host.ts";
import { type DemoStatus, delayFor, initialDemoStatus, runNextStep } from "./demo-director.ts";
import { type ArtifactsEvent, EventSubscriptions } from "./event-subscriptions.ts";
import { SqlFs } from "./git/sql-fs.ts";
import { GitWorkspace } from "./git/workspace.ts";
import { ProjectGit } from "./project-git.ts";
import { handleProtocol } from "./protocol.ts";
import { Tower, type TowerStore } from "./tower.ts";

/**
 * One Durable Object per project: the control tower. It is the single authority for live
 * coordination state (Flights, plans, leases, clearances, congestion, decisions) and the hub for
 * realtime radar clients (WebSocket hibernation).
 */

export interface TowerEnv {
	ARTIFACTS?: Artifacts;
	ARTIFACTS_NAMESPACE: string;
	CF_ACCOUNT_ID?: string;
	EVENTS_QUEUE_ID?: string;
	CF_EVENTS_API_TOKEN?: string;
	GIT_BACKEND?: string;
	FLIGHT_WORKFLOW?: Workflow<FlightParams>;
	FLIGHT_SANDBOX?: DurableObjectNamespace<FlightSandbox>;
	ANTHROPIC_API_KEY?: string;
}

const LIVE_TICK_MS = 30_000;

export class ControlTower extends DurableObject<TowerEnv> {
	private tower?: Tower;
	private meta?: ProjectMeta;
	private stepping = false;

	constructor(ctx: DurableObjectState, env: TowerEnv) {
		super(ctx, env);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, flight TEXT, body TEXT NOT NULL)`,
		);
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
	}

	// ── setup ───────────────────────────────────────────────────────────

	private async open(projectId: string): Promise<Tower> {
		if (this.tower && this.meta?.id === projectId) return this.tower;
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
					this.broadcast({ type: "update", state, events, demo: this.demoStatus() });
					this.wakeLiveFlights(state, events);
				},
				onRepo: subs ? async (repo) => void (await subs.subscribeRepo(repo)) : undefined,
				onRepoRemoved: subs ? async (repo) => subs.unsubscribeRepo(repo) : undefined,
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
		return tower;
	}

	/** Rule-based judgment always; the narrow model judge only on the live project with a key. */
	private judges(meta: ProjectMeta): DecisionJudge[] {
		const judges: DecisionJudge[] = [new RuleBasedDecisionJudge()];
		if (meta.mode === "live" && this.env.ANTHROPIC_API_KEY) judges.push(new ModelDecisionJudge(this.env.ANTHROPIC_API_KEY));
		return judges;
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
			liveAgents: this.liveAgents(),
		};
	}

	private liveAgents(): { available: boolean; reason?: string } {
		if (this.meta?.mode !== "live") return { available: false, reason: "demo project" };
		if (!this.env.FLIGHT_WORKFLOW || !this.env.FLIGHT_SANDBOX)
			return { available: false, reason: "Sandbox runtime not configured in this deployment" };
		if (!this.env.ARTIFACTS) return { available: false, reason: "live Flights need the Artifacts backend" };
		if (!this.env.ANTHROPIC_API_KEY) return { available: false, reason: "no model credentials configured (ANTHROPIC_API_KEY)" };
		return { available: true };
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
			case "reroute":
				return this.reroute(tower, cmd.flightId, by);
			case "land":
				return tower.land(cmd.flightId);
			case "launch":
				return this.launch(tower, cmd);
		}
	}

	/**
	 * REROUTE: ask a Flight to plan around contested airspace. Mock agents comply immediately by moving
	 * held writes into their read set; live agents receive the instruction with their next status.
	 */
	private reroute(tower: Tower, flightId: string, by: string) {
		const f = tower.flight(flightId);
		const held = tower.state.traffic.clearances[flightId]?.held ?? [];
		if (!f.plan || !held.length) return { ok: false, reason: "nothing to reroute around" };
		const labels = held.map((h) => resourceLabel(h.resource, tower.state.index));
		tower.mutate((c) => c.note("agent.instruction", "human", `${by} asked ${flightId} to reroute around ${labels.join(", ")}`, flightId));
		if (f.agent !== "mock") return { ok: true, delivered: "with next status" };
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
		return { ok: true };
	}

	// ── live Flights (real coding agents in Sandboxes) ─────────────────

	private async launch(tower: Tower, cmd: Extract<HumanCommand, { type: "launch" }>) {
		if (cmd.runtime === "external") {
			if (this.meta?.mode !== "live" || !this.env.ARTIFACTS) throw new Error("external Flights run on the live project with Artifacts");
			const flight = tower.mutate((c) => {
				const m = c.createMission({ title: cmd.title, description: cmd.description, priority: cmd.priority, createdBy: "controller" });
				return c.createFlight({ missionId: m.id, agent: "external", agentRuntime: "Claude Code · external runner" });
			});
			await tower.provision(flight.id);
			return { flightId: flight.id, external: true };
		}
		const live = this.liveAgents();
		if (!live.available || !this.env.FLIGHT_WORKFLOW) throw new Error(`live Flights unavailable: ${live.reason}`);
		const flight = tower.mutate((c) => {
			const m = c.createMission({ title: cmd.title, description: cmd.description, priority: cmd.priority, createdBy: "controller" });
			return c.createFlight({ missionId: m.id, agent: "claude-code", agentRuntime: "Claude Code · Cloudflare Sandbox" });
		});
		const instance = await this.env.FLIGHT_WORKFLOW.create({
			id: `${tower.project.id}-${flight.id.toLowerCase()}-${Date.now().toString(36)}`,
			params: { projectId: tower.project.id, flightId: flight.id },
		});
		this.ctx.storage.kv.put(`wf:${flight.id}`, instance.id);
		tower.mutate((c) => c.note("flight.phase", "cruce", `${flight.id} launched · workflow ${instance.id}`, flight.id));
		return { flightId: flight.id, workflow: instance.id };
	}

	/** Tell held / sequenced live Flights that the traffic picture changed. */
	private wakeLiveFlights(state: ControllerState, events: TowerEvent[]) {
		if (this.meta?.mode !== "live" || !this.env.FLIGHT_WORKFLOW || !events.length) return;
		const relevant = events.some((e) =>
			["clearance", "flight.stale", "flight.landed", "override", "congestion.cleared", "flight.failed", "flight.lost"].includes(e.type),
		);
		if (!relevant) return;
		for (const f of state.flights) {
			if (f.agent !== "claude-code" || TERMINAL_PHASES.has(f.phase)) continue;
			const id = this.ctx.storage.kv.get(`wf:${f.id}`) as string | undefined;
			if (!id) continue;
			const wf = this.env.FLIGHT_WORKFLOW;
			this.ctx.waitUntil(
				wf
					.get(id)
					.then((i) => i.sendEvent({ type: "tower-wake", payload: { at: Date.now() } }))
					.catch(() => undefined),
			);
		}
	}

	async liveProvision(projectId: string, flightId: string) {
		const tower = await this.open(projectId);
		if (!tower.flight(flightId).artifact) await tower.provision(flightId);
		const a = tower.flight(flightId).artifact;
		if (!a) throw new Error("provisioning failed");
		return { namespace: a.namespace, repo: a.repo, remote: a.remote, baseCommit: a.baseCommit };
	}

	async liveMission(projectId: string, flightId: string) {
		const tower = await this.open(projectId);
		const f = tower.flight(flightId);
		const m = tower.state.missions.find((x) => x.id === f.missionId);
		return { flightId, title: m?.title ?? f.title, description: m?.description ?? f.title };
	}

	async liveStatus(projectId: string, flightId: string) {
		const tower = await this.open(projectId);
		const f = tower.flight(flightId);
		const c = tower.state.traffic.clearances[flightId];
		const approved = f.publishes.filter((p) => p.approved);
		return {
			phase: f.phase,
			terminal: TERMINAL_PHASES.has(f.phase),
			planVersion: f.plan?.planVersion ?? 0,
			clearance: c?.status ?? "none",
			cleared: c?.cleared.length ?? 0,
			held: c?.held.length ?? 0,
			stale: f.stale ? { byFlight: f.stale.byFlight, reasons: f.stale.reasons } : null,
			published: approved.length > 0,
			publishedPlanVersion: approved.at(-1)?.planVersion ?? 0,
			brief: clearanceBrief(tower.state, flightId),
		};
	}

	async liveRefresh(projectId: string, flightId: string) {
		const tower = await this.open(projectId);
		const ok = await tower.refresh(flightId);
		if (!ok) throw new Error("baseline refresh hit a Git conflict");
		return { head: tower.flight(flightId).baseline };
	}

	async liveActivity(projectId: string, flightId: string, text: string) {
		const tower = await this.open(projectId);
		tower.mutate((c) => c.reportActivity(flightId, text));
	}

	/** The read token the sandbox egress policy injects for clone/fetch of the Flight's own repo. */
	async readToken(projectId: string, flightId: string): Promise<string> {
		const tower = await this.open(projectId);
		const f = tower.flight(flightId);
		if (TERMINAL_PHASES.has(f.phase)) throw new Error(`${flightId} is ${f.phase}`);
		return tower.git.readToken(flightId);
	}

	/** The sandbox finished an agent task; forward it to the Flight's workflow. */
	async agentTaskDone(projectId: string, flightId: string, label: string, status: TaskStatus) {
		const tower = await this.open(projectId);
		tower.mutate((c) =>
			c.note(
				"flight.activity",
				"agent",
				`${flightId} agent task ${label}: ${status.state}`,
				flightId,
				status.state === "failed" ? [status.error.slice(0, 300)] : status.state === "succeeded" ? [status.result.slice(0, 300)] : undefined,
			),
		);
		const id = this.ctx.storage.kv.get(`wf:${flightId}`) as string | undefined;
		if (id && this.env.FLIGHT_WORKFLOW) {
			const instance = await this.env.FLIGHT_WORKFLOW.get(id);
			await instance.sendEvent({ type: `agent-${label}`, payload: { status } });
		}
	}

	async demo(projectId: string, cmd: DemoCommand): Promise<DemoStatus> {
		const tower = await this.open(projectId);
		if (tower.project.mode !== "demo") throw new Error("not a demo project");
		let status = this.demoStatus() ?? initialDemoStatus();
		// Public deployments: a reset recreates Flight repos, so it is rate limited per project.
		if (cmd.op === "reset" || (cmd.op === "play" && status.finished)) {
			const last = (this.ctx.storage.kv.get("lastReset") as number | undefined) ?? 0;
			const wait = 45_000 - (Date.now() - last);
			if (wait > 0) throw new Error(`The demo was reset moments ago; try again in ${Math.ceil(wait / 1000)}s`);
			this.ctx.storage.kv.put("lastReset", Date.now());
		}
		switch (cmd.op) {
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
				status = initialDemoStatus();
				break;
			case "speed":
				status = { ...status, speed: cmd.speed ?? 1 };
				break;
		}
		this.saveDemo(status);
		await this.schedule();
		this.broadcast({ type: "update", state: tower.state, events: [], demo: status });
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
			this.broadcast({ type: "update", state: tower.state, events: [], demo: status });
			await this.schedule();
			return status;
		} finally {
			this.stepping = false;
		}
	}

	async protocol(projectId: string, flightId: string, req: ProtocolRequest): Promise<unknown> {
		const tower = await this.open(projectId);
		return handleProtocol(tower, flightId, req);
	}

	async history(projectId: string, target: string) {
		const tower = await this.open(projectId);
		const ref = target === "canonical" ? "refs/heads/main" : `refs/heads/flights/${target}`;
		return tower.git.history(ref, 30);
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
				if (flight && evt.payload.after && evt.payload.ref === "refs/heads/main") c.recordPush(flight.id, evt.payload.after, "event");
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
			liveAgents: this.liveAgents(),
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

	// ── time ────────────────────────────────────────────────────────────

	private demoStatus(): DemoStatus | null {
		if (this.meta?.mode !== "demo") return null;
		return (this.ctx.storage.kv.get("demo") as DemoStatus | undefined) ?? initialDemoStatus();
	}

	private saveDemo(status: DemoStatus) {
		this.ctx.storage.kv.put("demo", status);
	}

	private async schedule() {
		const demo = this.demoStatus();
		const candidates: number[] = [];
		if (demo?.running && demo.nextAt) candidates.push(demo.nextAt);
		if (this.meta?.mode === "live" && this.tower?.state.flights.some((f) => !TERMINAL_PHASES.has(f.phase)))
			candidates.push(Date.now() + LIVE_TICK_MS);
		if (candidates.length) await this.ctx.storage.setAlarm(Math.min(...candidates));
		else await this.ctx.storage.deleteAlarm();
	}

	async alarm() {
		const projectId = (this.ctx.storage.kv.get("projectId") as string | undefined) ?? "demo";
		const tower = await this.open(projectId);
		const demo = this.demoStatus();
		if (demo?.running && demo.nextAt && demo.nextAt <= Date.now() + 50) {
			await this.advance(tower);
			return;
		}
		if (tower.project.mode === "live") tower.mutate((c) => c.tick());
		await this.schedule();
	}
}

export type { ControllerState };
