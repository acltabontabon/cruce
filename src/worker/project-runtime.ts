import { COST_LABELS, type CostClass, RESOURCE_LABELS } from "../core/capabilities.ts";
import { detectDeploymentProfile, environmentOf, explainRollback, liveDeployment, previewBranch } from "../core/deployment.ts";
import { initialPlatform, migratePlatform, PlatformController } from "../core/platform.ts";
import { evaluatePublish } from "../core/publish-gate.ts";
import { CoordinationError, decide, stable as stableCommand, WorkstreamController } from "../core/workstreams.ts";
import type { JevBinding } from "../intelligence/jev.ts";
import { buildIndex } from "../intelligence/structural-index.ts";
import { CommandInput, type ManagedWorkspaceRecord, type Principal, type ProjectConnection } from "../shared/coordination.ts";
import {
	type Actor,
	type Deployment,
	type DeploymentProfile,
	type Environment,
	type Mission,
	PLATFORM_READ_TOOLS,
	type PlatformCommand,
	type PlatformState,
	type Proposal,
	type SourceRepository,
	type Workspace,
} from "../shared/platform.ts";
import type { ArtifactsHost } from "./artifacts-host.ts";
import { CoordinationRuntime } from "./coordination-runtime.ts";
import { pushDeployment, type ResourceBoundary, runSmokeChecks } from "./deployments.ts";
import type { GitWorkspace } from "./git/workspace.ts";
import { CloudflareArtifactWorkspace } from "./managed-workspace.ts";
import type { TowerStore } from "./tower.ts";

const SOURCE = "refs/cruce/accepted",
	EVIDENCE = "refs/cruce/evidence";
const description = (id: string) => `Cruce project ${id}`;
/** Projects created before the Project vocabulary carry the earlier description. */
export const ownsProjectRepository = (text: string | null | undefined, id: string) =>
	text === description(id) || text === `Cruce system ${id}`;

export interface RuntimeOptions {
	namespace?: string;
	resources?: ResourceBoundary;
	/** Starts durable orchestration (a Workflow) for a deployment; absent offline. */
	orchestrate?: (deploymentId: string) => Promise<void>;
	send?: typeof fetch;
}

/**
 * Native project authority. Git provides the mechanics; the project's canonical repository lives in
 * Cloudflare Artifacts; Cruce adds missions, evidence, proposals, verification, policy,
 * environments and lineage around exact revisions. No external Git provider is consulted.
 */
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
		readonly options: RuntimeOptions = {},
	) {
		this.coordination = new CoordinationRuntime(
			store,
			git,
			background,
			now,
			ai,
			host ? new CloudflareArtifactWorkspace(host, git, project.artifactRepository, now) : undefined,
		);
		this.coordination.inferenceAllowed = () => this.state().policy.resources.rules["ai.inference"] === "allow";
	}
	private serialize<T>(run: () => T | Promise<T>) {
		const next = this.queue.then(run);
		this.queue = next.catch(() => {});
		return next;
	}
	state() {
		return migratePlatform(this.store.get<PlatformState>("platform") ?? initialPlatform());
	}
	private save(state: PlatformState) {
		this.store.put("platform", state);
	}
	private author() {
		return { name: "Cruce", email: "system@cruce.invalid", timestamp: Math.floor(this.now() / 1000) };
	}
	provisioned() {
		return !!this.store.get("coordination");
	}
	private canonical() {
		const head = this.coordination.state().project.canonicalHead;
		if (!head) throw new CoordinationError(503, "Canonical revision unavailable");
		return head;
	}
	source(): SourceRepository {
		return {
			backend: this.host ? "cloudflare_artifacts" : "offline_fixture",
			namespace: this.host?.namespace ?? "offline",
			name: this.project.artifactRepository,
			remote: this.store.get<string>("source-remote"),
			defaultBranch: "main",
			acceptedRef: "refs/heads/main",
			canonicalRevision: this.canonical(),
		};
	}

	/**
	 * Open the project. Reading never consumes resources: an unprovisioned project stays unprovisioned
	 * until a human maintainer provisions its canonical repository.
	 */
	async initialize() {
		await this.git.ensureInit();
		if (this.provisioned()) return this.open();
		if (!this.host) return this.adopt(await this.fixture());
		// Earlier versions created the repository on first use; adopt it read-only when it exists.
		const existing = await this.host.find(this.project.artifactRepository);
		if (!existing) return;
		if (!ownsProjectRepository(existing.description, this.project.id))
			throw new CoordinationError(409, "Project artifact ownership mismatch");
		if ((await this.host.log(existing.name, "main", 1)).length) {
			const { result } = await this.host.withToken(existing.name, "read", (token) =>
				this.git.fetch({ url: existing.remote, token, localRef: SOURCE }),
			);
			if (result) {
				this.store.put("source-remote", existing.remote);
				return this.adopt(result);
			}
		}
	}
	/** Create the canonical Artifacts repository with an initial revision. A resource action reserved for humans. */
	async provision(actor: Actor) {
		return this.serialize(async () => {
			if (actor.kind !== "human" || !actor.maintainer) throw new CoordinationError(403, "Human maintainer provisions project source");
			await this.git.ensureInit();
			if (this.provisioned()) return this.source();
			if (!this.host) {
				await this.adopt(await this.fixture());
				return this.source();
			}
			const repo = await this.host.ensure(this.project.artifactRepository, description(this.project.id));
			const info = await this.host.info(repo.name);
			if (!ownsProjectRepository(info.description, this.project.id))
				throw new CoordinationError(409, "Project artifact ownership mismatch");
			let head: string | null;
			if ((await this.host.log(repo.name, "main", 1)).length)
				head = (await this.host.withToken(repo.name, "read", (token) => this.git.fetch({ url: repo.remote, token, localRef: SOURCE })))
					.result;
			else {
				head =
					(await this.git.resolve(SOURCE)) ??
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
			if (!head) throw new CoordinationError(503, "Source revision unavailable");
			this.store.put("source-remote", repo.remote);
			await this.adopt(head);
			return this.source();
		});
	}
	private async fixture() {
		return (
			(await this.git.resolve(SOURCE)) ??
			(await this.git.commit({
				ref: SOURCE,
				parent: null,
				files: { "README.md": `# ${this.project.name}\n` },
				message: "Offline source fixture",
				author: this.author(),
			}))
		);
	}
	private async adopt(head: string) {
		await this.git.setRef(SOURCE, head);
		await this.coordination.initialize(this.project, head, await this.git.readFiles(head));
		if (!this.store.get("platform")) this.save(initialPlatform());
		this.store.put("source-health", { state: "verified", observedHead: head, verifiedHead: head, at: this.now() });
	}
	private async open() {
		const accepted = this.canonical();
		const observed = await this.git.resolve(SOURCE);
		if (observed !== accepted) await this.git.setRef(SOURCE, accepted);
	}
	authorize(actor: Principal) {
		if (!this.provisioned())
			throw new CoordinationError(409, "Project source is not provisioned; a maintainer must provision its Artifacts repository");
		new WorkstreamController(this.coordination.state(), this.now()).authorize(actor);
	}

	// ── derived views ────────────────────────────────────────────────────

	private workspaces(state: PlatformState): Workspace[] {
		const managed = this.store.get<ManagedWorkspaceRecord[]>("managed") ?? [];
		return managed.map((r) => ({
			id: r.workstreamId,
			missionId: state.missions.find((m) => m.workstreamId === r.workstreamId)?.id,
			repository: r.repository,
			remote: r.remote,
			baseRevision: r.baseline,
			headRevision: r.head,
			state: r.state,
		}));
	}
	async profile(revision: string): Promise<DeploymentProfile> {
		const cached = this.store.get<DeploymentProfile>("deployment-profile");
		if (cached?.revision === revision) return cached;
		const files = await this.git.readFiles(
			revision,
			(p) => !p.includes("/") && /^(wrangler\.(jsonc|json|toml)|cloudflare\.config\.ts)$/.test(p),
		);
		const profile = detectDeploymentProfile(files, revision);
		if (revision === this.canonical()) this.store.put("deployment-profile", profile);
		return profile;
	}
	private environmentsView(state: PlatformState) {
		return state.environments.map((e) => ({ ...e, live: liveDeployment(state, e.id) }));
	}
	private resourceImpact(c: PlatformController, actor: Actor, missionId?: string) {
		const describe = (cost: CostClass, outcome: string, reason: string) => ({ cost, label: COST_LABELS[cost], outcome, reason });
		const preview = c.evaluate("preview.deploy", actor, missionId),
			production = c.evaluate("production.deploy", { ...actor, kind: "agent" }, missionId);
		return {
			local: describe("local", "allow", "Builds, tests and local services run on the developer machine"),
			preview: describe(preview.cost, preview.outcome, preview.reason),
			production: describe(production.cost, "approval", "Production promotion is always a human decision"),
		};
	}
	private connection(actor: Actor) {
		return { kind: actor.kind, scopes: actor.scopes ?? "all (human membership)", maintainer: actor.maintainer === true };
	}
	snapshot(actor: Actor) {
		if (!this.provisioned())
			return { provisioned: false, project: { id: this.project.id, name: this.project.name }, sourceHealth: { state: "unprovisioned" } };
		this.authorize(actor);
		const coordination = this.coordination.snapshot(actor),
			state = this.state(),
			canonical = this.canonical(),
			c = new PlatformController(state, this.now());
		const { replays: _r, ...visible } = state;
		return {
			provisioned: true,
			...visible,
			missions: state.missions.map((m) => {
				const w = coordination.workstreams.find((w) => w.id === m.workstreamId);
				return {
					...m,
					plan: w?.plans.at(-1) ?? m.plan,
					state: w?.state === "integrated" || w?.state === "completed" ? "completed" : m.state,
					decision: w?.decision,
				};
			}),
			project: coordination.project,
			source: this.source(),
			workspaces: this.workspaces(state),
			coordination,
			proposals: state.proposals.map((p) => ({ ...p, readiness: c.readiness(p.id, canonical) })),
			environments: this.environmentsView(state),
			deploymentProfile: this.store.get<DeploymentProfile>("deployment-profile"),
			account: this.options.resources?.account(),
			resourceImpact: this.resourceImpact(c, actor),
			canonical: { revision: canonical, ...c.explainRevision(canonical) },
			sourceBackend: this.host ? "cloudflare_artifacts" : "offline_fixture",
			sourceHealth: this.store.get("source-health"),
			permissions: { contribute: actor.canWrite !== false, govern: actor.kind === "human" && actor.maintainer === true },
		};
	}
	verifySource() {
		return this.serialize(async () => {
			if (!this.host || !this.provisioned()) return;
			const accepted = this.canonical();
			try {
				const repo = await this.host.info(this.project.artifactRepository);
				if (!ownsProjectRepository(repo.description, this.project.id)) throw new CoordinationError(409, "Source ownership mismatch");
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

	// ── reads ────────────────────────────────────────────────────────────

	private activeMission(c: PlatformController, actor: Actor, id?: string): Mission {
		if (id) return c.mission(id);
		const own = c.state.missions.filter((m) => m.state === "active" && m.agent?.developerId === actor.developerId);
		if (own.length === 1) return own[0];
		throw new CoordinationError(
			400,
			own.length ? "Several active missions; pass missionId" : "No active mission; pass missionId or start a mission",
		);
	}
	private missionView(c: PlatformController, m: Mission, canonical: string) {
		const workspace = this.workspaces(c.state).find((w) => w.id === m.workstreamId);
		return {
			mission: m,
			workspace,
			experiments: c.state.missions.filter(
				(o) => o.id !== m.id && (o.experimentOf ?? o.id) === (m.experimentOf ?? m.id) && (o.experimentOf || m.experimentOf),
			),
			artifacts: c.state.artifacts.filter((a) => a.missionId === m.id),
			proposals: c.state.proposals.filter((p) => p.missionId === m.id).map((p) => ({ ...p, readiness: c.readiness(p.id, canonical) })),
		};
	}
	private async read(cmd: PlatformCommand, actor: Actor, c: PlatformController) {
		const canonical = this.canonical();
		if (cmd.tool === "get_project") {
			const pending = c.state.resourceRequests.filter((r) => r.state === "pending");
			return {
				project: { id: this.project.id, name: this.project.name },
				source: this.source(),
				canonical: { revision: canonical, ...c.explainRevision(canonical) },
				deploymentProfile: await this.profile(canonical),
				environments: this.environmentsView(c.state),
				account: this.options.resources?.account(),
				activeMissions: c.state.missions
					.filter((m) => m.state === "active")
					.map((m) => ({ id: m.id, title: m.title, headRevision: m.headRevision })),
				attention: {
					proposals: c.state.proposals
						.filter((p) => p.state === "proposed" && c.readiness(p.id, canonical).outcome !== "READY")
						.map((p) => p.id),
					resourceRequests: pending.map((r) => ({ id: r.id, action: r.action, reason: r.reason })),
				},
				connection: this.connection(actor),
			};
		}
		if (cmd.tool === "get_context") {
			const m = this.activeMission(c, actor, cmd.missionId),
				view = this.missionView(c, m, canonical);
			const decision = m.workstreamId ? decide(this.coordination.state(), m.workstreamId, this.now()) : undefined;
			return {
				...view,
				canonicalRevision: canonical,
				source: this.source(),
				policy: {
					requiredEvidence: c.state.policy.requiredEvidence,
					approvals: c.state.policy.approvals,
					agentPromotion: false,
					resources: c.state.policy.resources,
				},
				verificationRequirements: c.state.policy.requiredEvidence.map((kind) => ({
					kind,
					trusted: "Runtime-verified or human-attested evidence on the exact proposed revision",
				})),
				coordination: decision,
				environments: this.environmentsView(c.state),
				deploymentProfile: await this.profile(canonical),
				resourceImpact: this.resourceImpact(c, actor, m.id),
				connection: this.connection(actor),
				nextAction: !m.workstreamId
					? "start_mission to pin a base revision and create the isolated workspace"
					: (decision?.nextAction ?? "Work locally, publish_revision, publish_artifact, create_proposal"),
			};
		}
		if (cmd.tool === "get_mission") return this.missionView(c, c.mission(cmd.missionId), canonical);
		if (cmd.tool === "get_canonical_revision") {
			const history = await this.git.log(SOURCE, 10);
			return { revision: canonical, source: this.source(), history: history.map((h) => ({ ...h, lineage: c.explainRevision(h.oid) })) };
		}
		if (cmd.tool === "read_artifact") {
			const artifact = c.state.artifacts.find((a) => a.id === cmd.artifactId);
			if (!artifact) throw new CoordinationError(404, "Artifact unavailable");
			if (!artifact.storage.path)
				return {
					artifact,
					paths: Object.keys(await this.git.readFiles(artifact.revision)),
					nextAction: "Use get_source or get_diff for source content",
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
			if (cmd.proposalId) {
				const p = c.proposal(cmd.proposalId);
				return { proposalId: p.id, revision: p.revision, base: p.base, ...(await this.git.reviewChanges(p.base, p.revision, cmd.path)) };
			}
			if (!cmd.base || !cmd.revision) throw new CoordinationError(400, "Proposal or base and revision required");
			return { revision: cmd.revision, base: cmd.base, ...(await this.git.reviewChanges(cmd.base, cmd.revision, cmd.path)) };
		}
		if (cmd.tool === "get_history") {
			const revisions = await this.git.log(SOURCE, 25);
			return { revisions: revisions.map((r) => ({ ...r, lineage: c.explainRevision(r.oid) })), timeline: c.state.timeline.slice(-100) };
		}
		if (cmd.tool === "get_proposal") {
			const p = c.proposal(cmd.proposalId),
				source = c.state.artifacts.find((a) => a.id === p.artifactId);
			const changes = await this.git.reviewChanges(p.base, p.revision);
			return {
				proposal: p,
				mission: c.state.missions.find((m) => m.id === p.missionId),
				readiness: c.readiness(p.id, canonical),
				commits: source?.source?.commits ?? [],
				changes: { files: changes.files, additions: changes.additions, deletions: changes.deletions, statsComplete: changes.statsComplete },
				evidence: c.state.artifacts.filter((a) => a.revision === p.revision && a.kind !== "source"),
				verificationRequests: c.state.verificationRequests.filter((r) => r.proposalId === p.id),
				verifications: c.state.verifications.filter((v) => v.proposalId === p.id),
				reviews: c.state.reviews.filter((r) => r.proposalId === p.id),
				deployments: c.state.deployments.filter((d) => d.proposalId === p.id),
				resourceRequests: c.state.resourceRequests.filter((r) => r.proposalId === p.id),
				resourceImpact: this.resourceImpact(c, actor, p.missionId),
			};
		}
		if (cmd.tool === "plan_rollback") {
			if (actor.kind !== "human" || !actor.maintainer || !cmd.revision)
				throw new CoordinationError(403, "Human maintainer and target revision required");
			const production = environmentOf(c.state, "production"),
				live = production ? liveDeployment(c.state, production.id) : undefined,
				current = live?.revision ?? canonical,
				ancestry = (await this.git.log(SOURCE, 200)).map((h) => h.oid);
			let explanation: ReturnType<typeof explainRollback>;
			try {
				explanation = explainRollback(c.state, current, cmd.revision, ancestry);
			} catch (error) {
				throw new CoordinationError(409, (error as Error).message);
			}
			return {
				current,
				target: cmd.revision,
				environment: production?.id,
				...explanation,
				target_lineage: c.explainRevision(cmd.revision),
				nextAction: production
					? "deploy_revision redeploys the earlier verified revision to production; accepted source history is never rewritten"
					: "No production environment; create a rollback mission that restores this revision through a new proposal",
			};
		}
		return c.execute(cmd, actor, canonical);
	}

	// ── commands ─────────────────────────────────────────────────────────

	command(cmd: PlatformCommand, actor: Actor) {
		return this.serialize(async () => {
			this.authorize(actor);
			if (cmd.projectId !== this.project.id) throw new CoordinationError(403, "Project authority mismatch");
			const c = new PlatformController(this.state(), this.now()),
				canonical = this.canonical();
			if (PLATFORM_READ_TOOLS.has(cmd.tool)) return this.read(cmd, actor, c);
			if (!cmd.idempotencyKey) throw new CoordinationError(400, "Idempotency key required");
			if (actor.canWrite === false) throw new CoordinationError(403, "Contribution permission required");
			const replayKey = `${actor.developerId}:${actor.kind}:${cmd.idempotencyKey}`,
				prior = c.state.replays[replayKey];
			if (prior) {
				if (prior.request !== stableCommand(cmd)) throw new CoordinationError(409, "Idempotency key reused with different inputs");
				return prior.result;
			}
			const ledgerKey = `native-io:${replayKey}`,
				pending = this.store.get<{ request: string; revision?: string; ticketId?: string; deploymentId?: string }>(ledgerKey);
			if (pending && pending.request !== stableCommand(cmd))
				throw new CoordinationError(409, "Idempotency key reused with different inputs");
			const io = async (run: () => Promise<unknown>) => {
				const output = await run();
				c.state.replays[replayKey] = { request: stableCommand(cmd), result: output };
				this.save(c.state);
				return output;
			};
			if (cmd.tool === "promote_proposal") return io(() => this.promote(cmd, actor, c));
			if (cmd.tool === "request_preview") return io(() => this.requestPreview(cmd, actor, c));
			if (cmd.tool === "configure_environment") return io(() => this.configureEnvironment(cmd, actor, c));
			if (cmd.tool === "deploy_revision") return io(() => this.deployRevision(cmd, actor, c, ledgerKey));
			if (cmd.tool === "decide_resource_request") {
				return io(async () => {
					const request = c.decideResourceRequest(cmd, actor);
					if (request.state !== "approved" || request.action !== "preview.deploy" || !request.proposalId) return request;
					const p = c.proposal(request.proposalId);
					const deployment = await this.startPreview(c, p, actor, request.id);
					request.state = "executed";
					request.deploymentId = deployment.id;
					return { request, deployment };
				});
			}
			if (cmd.tool === "complete_mission") {
				return io(async () => {
					const m = c.mission(cmd.missionId);
					const result = c.execute(cmd, actor, canonical);
					delete c.state.replays[replayKey];
					const w = m.workstreamId ? this.coordination.state().workstreams.find((w) => w.id === m.workstreamId) : undefined;
					if (w?.state === "active" && w.owner === actor.developerId)
						await this.coordination.command(
							CommandInput.parse({
								tool: "complete_workstream",
								projectId: cmd.projectId,
								idempotencyKey: `mission-complete:${cmd.idempotencyKey}`,
								workstreamId: w.id,
								sessionId: m.agent?.sessionId,
								expectedVersion: w.version,
								expectedPlanVersion: w.plans.at(-1)?.version,
							}),
							actor,
						);
					return result;
				});
			}
			const result = await c.replay(cmd, actor, () => {
				// I/O commands are replayed by the application after durable storage succeeds.
				if (["start_mission", "publish_artifact", "publish_revision"].includes(cmd.tool)) return undefined;
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
			if (cmd.tool === "start_mission") output = await this.startMission(cmd, actor, c, m, canonical);
			else if (cmd.tool === "publish_revision") output = await this.publishRevision(cmd, actor, c, m, ledgerKey, pending);
			else if (cmd.tool === "publish_artifact") output = await this.publishArtifact(cmd, actor, c, m, ledgerKey);
			else throw new CoordinationError(400, "Unsupported native command");
			c.state.replays[replayKey] = { request: stableCommand(cmd), result: output };
			this.save(c.state);
			return output;
		});
	}

	private async startMission(cmd: PlatformCommand, actor: Actor, c: PlatformController, m: Mission, canonical: string) {
		if (!cmd.workspace || !cmd.agent) throw new CoordinationError(400, "Agent identity and execution context required");
		const work = m.workstreamId ? this.coordination.state().workstreams.find((w) => w.id === m.workstreamId) : undefined;
		const base = work?.plans[0].baseline ?? (cmd.workspace.base && cmd.workspace.base !== canonical ? cmd.workspace.base : canonical);
		// A mission starts from a concrete accepted revision, never from an arbitrary local state.
		if (!work && base !== canonical && (await this.git.mergeBase(base, canonical).catch(() => null)) !== base)
			throw new CoordinationError(
				409,
				`Workspace base ${base.slice(0, 12)} is not an accepted revision; refresh_source and start from ${canonical.slice(0, 12)}`,
			);
		if (!work && this.host) {
			const request = c.gate("workspace.create", actor, { missionId: m.id, revision: base });
			if (request)
				return { mission: m, resourceRequest: request, nextAction: "A human must approve workspace creation before the mission starts" };
		}
		const d = (await this.coordination.command(
			CommandInput.parse({
				tool: work ? "attach_workstream" : "register_workstream",
				projectId: cmd.projectId,
				idempotencyKey: `mission:${cmd.idempotencyKey}`,
				workstreamId: work?.id,
				expectedVersion: work?.version,
				expectedPlanVersion: work?.plans.at(-1)?.version,
				workspace: { ...cmd.workspace, base },
				agent: cmd.agent,
				plan: m.plan,
			}),
			actor,
		)) as { workstreamId: string; sessionId: string };
		m.workstreamId = d.workstreamId;
		m.baseRevision = base;
		m.headRevision ??= base;
		m.agent = { developerId: actor.developerId, tool: cmd.agent.tool, instance: cmd.agent.instance, sessionId: d.sessionId };
		m.state = "active";
		m.version++;
		if (this.host) await this.coordination.provision(actor, d.workstreamId);
		c.event(actor.developerId, "execution", [m.id, d.workstreamId], `${cmd.agent.tool}: ${m.specialization} from ${base.slice(0, 12)}`);
		return {
			mission: m,
			workspace: this.workspaces(c.state).find((w) => w.id === d.workstreamId) ?? {
				id: d.workstreamId,
				baseRevision: base,
				headRevision: base,
			},
			coordination: d,
			nextAction: "Work locally with your normal tools. Commit with Git, then publish_revision with base set to the workspace head.",
		};
	}

	private async publishRevision(
		cmd: PlatformCommand,
		actor: Actor,
		c: PlatformController,
		m: Mission,
		ledgerKey: string,
		pending: { request: string; revision?: string } | undefined,
	) {
		if (!m.workstreamId || !cmd.base || (!cmd.files && !cmd.pack))
			throw new CoordinationError(400, "Started mission, exact base and a Git pack (or files) required");
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
		if (!record || !this.host) throw new CoordinationError(503, "Managed Artifacts workspace required for revision publication");
		if (record.head !== cmd.base && record.head !== pending?.revision)
			throw new CoordinationError(409, "Workspace source changed; refresh the exact revision");
		if (!pending?.revision) {
			const request = c.gate("revision.publish", actor, { missionId: m.id, revision: cmd.revision });
			if (request) return { resourceRequest: request, nextAction: "A human must approve this publication" };
		}
		const baseline = w.plans.at(-1)!.baseline;
		let revision: string, pack: Uint8Array;
		if (cmd.pack) {
			if (!cmd.revision) throw new CoordinationError(400, "Exact revision required with a Git pack");
			pack = Uint8Array.from(atob(cmd.pack), (ch) => ch.charCodeAt(0));
			if (!pending?.revision)
				await this.git.importPack(pack).catch((error) => {
					throw new CoordinationError(400, `Git pack rejected: ${(error as Error).message}`);
				});
			revision = cmd.revision;
			const [commit] = await this.git.log(revision, 1);
			if (commit?.oid !== revision) throw new CoordinationError(400, "Revision is not contained in the Git pack");
			if ((await this.git.mergeBase(cmd.base, revision)) !== cmd.base)
				throw new CoordinationError(409, "Revision must descend from the workspace head");
			// Agent commits are real history: Cruce never rewrites them. Reconciliation happens locally.
			if ((await this.git.mergeBase(baseline, revision)) !== baseline)
				throw new CoordinationError(409, `Merge accepted revision ${baseline} locally, preserving your work, then publish again`);
		} else {
			revision =
				pending?.revision ??
				(await this.git.commit({
					ref: `refs/cruce/candidate/${w.id}`,
					parent: cmd.base,
					files: cmd.files!,
					message: cmd.message ?? cmd.summary ?? m.title,
					author: this.author(),
				}));
			if (!pending?.revision && (await this.git.mergeBase(baseline, revision)) !== baseline) {
				await this.git.setRef(`refs/cruce/candidate/${w.id}`, revision);
				const refresh = await this.git.merge({
					ours: `refs/cruce/candidate/${w.id}`,
					theirs: baseline,
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
			pack = await this.git.exportPack(revision, cmd.base);
		}
		this.store.put(ledgerKey, { request: stableCommand(cmd), revision });
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
		const accepted = m.baseRevision ?? w.plans[0].baseline;
		const commits = (await this.git.log(revision, 100)).filter((e) => e.oid !== accepted);
		const own: { oid: string; message: string }[] = [];
		for (const e of commits)
			if ((await this.git.mergeBase(e.oid, accepted)) !== e.oid) own.push({ oid: e.oid, message: e.message.split("\n")[0] });
		const [head] = await this.git.log(revision, 1);
		const a = c.artifact({
			kind: "source",
			missionId: m.id,
			title: cmd.title ?? m.title,
			summary: cmd.summary ?? head?.message.split("\n")[0] ?? m.title,
			revision,
			parentRevision: head?.parents[0] ?? baseline,
			contentHash: revision,
			storage: { repository: record.repository, revision },
			producer: { actor: actor.developerId, kind: actor.kind, sessionId: writer.id, tool: writer.tool, model: cmd.model },
			execution: { location: cmd.execution, detail: cmd.executionDetail ?? writer.tool },
			related: cmd.related,
			trust: "verified",
			source: { base: baseline, commits: own, files: (await this.git.changes(baseline, revision)).files.length },
		});
		m.headRevision = revision;
		return { artifact: a, revision, workspace: { repository: record.repository, headRevision: revision }, coordination: d };
	}

	private async publishArtifact(cmd: PlatformCommand, actor: Actor, c: PlatformController, m: Mission, ledgerKey: string) {
		if (!cmd.kind || cmd.kind === "source" || cmd.content === undefined || !cmd.revision)
			throw new CoordinationError(400, "Typed output, content and the exact source revision it describes required");
		if (cmd.related.some((id) => !c.state.artifacts.some((a) => a.id === id)))
			throw new CoordinationError(400, "Related artifact unavailable");
		await this.git
			.readFiles(cmd.revision, () => false)
			.catch(() => {
				throw new CoordinationError(400, "Unknown revision; publish the revision before its evidence");
			});
		if (!this.store.get(ledgerKey)) {
			const request = c.gate("artifact.publish", actor, { missionId: m.id, revision: cmd.revision });
			if (request) return { resourceRequest: request, nextAction: "A human must approve evidence storage" };
		}
		const hash = await sha256(cmd.content);
		const storage = await this.storeEvidence(
			ledgerKey,
			cmd.content,
			{ missionId: m.id, revision: cmd.revision, producer: actor.developerId, model: cmd.model, kind: cmd.kind, hash },
			stableCommand(cmd),
		);
		return c.artifact({
			kind: cmd.kind,
			missionId: m.id,
			title: cmd.title ?? cmd.kind,
			summary: cmd.summary ?? "",
			revision: cmd.revision,
			parentRevision: cmd.revision,
			contentHash: hash,
			storage,
			producer: { actor: actor.developerId, kind: actor.kind, sessionId: cmd.sessionId, model: cmd.model },
			execution: { location: cmd.execution, detail: cmd.executionDetail ?? "unspecified" },
			related: cmd.related,
			trust: actor.kind === "runtime" ? "verified" : "reported",
		});
	}

	private async storeEvidence(ledgerKey: string, content: string, metadata: unknown, request: string) {
		if (!this.host) throw new CoordinationError(503, "Cloudflare Artifacts evidence storage unavailable");
		const name = `${this.project.artifactRepository}--evidence`,
			repo = await this.host.ensure(name, `Cruce evidence ${this.project.id}`),
			path = `artifacts/${await sha256(ledgerKey)}.json`;
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
		const ticket = await this.coordination.withAuthority(async (state) => {
			const p = c.proposal(cmd.proposalId),
				m = c.mission(p.missionId),
				canonical = state.project.canonicalHead!;
			const ticket = c.preparePromotion(cmd, actor, canonical, this.project.artifactRepository);
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
		if (!ticket.deploy) return ticket;
		const production = environmentOf(c.state, "production");
		if (!production) return { promotion: ticket, deployment: undefined, nextAction: "No production environment is configured" };
		const existing = c.state.deployments.find((d) => d.promotionId === ticket.id);
		return {
			promotion: ticket,
			deployment:
				existing ?? (await this.deploy(c, production, ticket.to, actor, { proposalId: ticket.proposalId, promotionId: ticket.id })),
		};
	}

	// ── environments and deployments ─────────────────────────────────────

	private async configureEnvironment(cmd: PlatformCommand, actor: Actor, c: PlatformController) {
		if (actor.kind !== "human" || !actor.maintainer) throw new CoordinationError(403, "Human maintainer configures environments");
		const input = cmd.environment;
		if (!input) throw new CoordinationError(400, "Environment configuration required");
		const smokeChecks = (input.smokePaths?.length ? input.smokePaths : ["/"]).map((path) => ({ path, expectStatus: 200 }));
		if (input.kind === "external") {
			if (!input.description?.trim()) throw new CoordinationError(400, "Describe where this application is deployed");
			const target = { type: "external" as const, description: input.description };
			return [c.addEnvironment({ name: "Production", kind: "production", target, smokeChecks, createdBy: actor.developerId }, actor)];
		}
		const resources = this.options.resources,
			account = resources?.account();
		if (!resources || account?.credential !== "stored")
			throw new CoordinationError(409, "Connect a Cloudflare account with a Workers Builds token first");
		const profile = await this.profile(this.canonical());
		const workerName = input.workerName ?? (profile.kind === "cloudflare_worker" ? profile.workerName : undefined);
		if (!workerName) throw new CoordinationError(400, "Worker name required; no Wrangler or cf configuration names one");
		const host = await resources.host(),
			deployRepository = `${this.project.artifactRepository}--deploy`;
		const repo = await host.ensure(deployRepository, `Cruce deployments ${this.project.id}`);
		const target = {
			type: "cloudflare_worker" as const,
			workerName,
			accountId: account.accountId,
			deployRepository,
			deployRemote: repo.remote,
		};
		return [
			c.addEnvironment({ name: "Worker Preview", kind: "preview", target, smokeChecks, createdBy: actor.developerId }, actor),
			c.addEnvironment({ name: "Production", kind: "production", target, smokeChecks, createdBy: actor.developerId }, actor),
		].map((e) => ({
			...e,
			nextAction: `Connect Workers Builds for Worker "${workerName}" to Artifacts repository ${deployRepository} (production branch main; enable preview builds). Cruce pushes exact revisions; it never edits Worker settings.`,
		}));
	}

	private async requestPreview(cmd: PlatformCommand, actor: Actor, c: PlatformController) {
		const p = c.proposal(cmd.proposalId);
		if (p.state !== "proposed") throw new CoordinationError(409, `Proposal is ${p.state.replace("_", " ")}`);
		const preview = environmentOf(c.state, "preview");
		if (preview?.target.type !== "cloudflare_worker")
			throw new CoordinationError(409, "No Worker preview environment is configured for this project");
		const profile = await this.profile(p.revision);
		if (profile.kind !== "cloudflare_worker")
			throw new CoordinationError(409, "Proposed revision has no Worker configuration (wrangler.jsonc/json/toml or cloudflare.config.ts)");
		const open = c.state.deployments.find(
			(d) => d.proposalId === p.id && d.revision === p.revision && d.environmentId === preview.id && d.state !== "failed",
		);
		if (open) return { deployment: open, nextAction: "A preview of this exact revision already exists" };
		const request = c.gate("preview.deploy", actor, {
			missionId: p.missionId,
			proposalId: p.id,
			environmentId: preview.id,
			revision: p.revision,
		});
		if (request)
			return {
				resourceRequest: request,
				cost: COST_LABELS[request.cost],
				nextAction: `${RESOURCE_LABELS[request.action]} may consume Cloudflare resources. Policy: human approval required.`,
			};
		return { deployment: await this.startPreview(c, p, actor), cost: COST_LABELS.metered };
	}
	private startPreview(c: PlatformController, p: Proposal, actor: Actor, requestId?: string) {
		const preview = environmentOf(c.state, "preview");
		if (!preview) throw new CoordinationError(409, "No Worker preview environment");
		return this.deploy(c, preview, p.revision, actor, { proposalId: p.id, requestId, branch: previewBranch(p) });
	}
	private async deployRevision(cmd: PlatformCommand, actor: Actor, c: PlatformController, ledgerKey: string) {
		if (actor.kind !== "human" || !actor.maintainer || !cmd.revision)
			throw new CoordinationError(403, "Human maintainer and accepted revision required");
		const production = c.environment(cmd.environmentId ?? environmentOf(c.state, "production")?.id);
		if (production.kind !== "production") throw new CoordinationError(400, "Previews are requested per proposal");
		const canonical = this.canonical();
		if ((await this.git.mergeBase(cmd.revision, canonical)) !== cmd.revision)
			throw new CoordinationError(409, "Only accepted revisions can be deployed to production");
		const done = this.store.get<{ deploymentId?: string }>(ledgerKey)?.deploymentId;
		if (done) return c.deployment(done);
		const live = liveDeployment(c.state, production.id);
		const deployment = await this.deploy(c, production, cmd.revision, actor, {
			rollbackOf: live && live.revision !== cmd.revision ? live.revision : undefined,
		});
		this.store.put(ledgerKey, { request: stableCommand(cmd), deploymentId: deployment.id });
		return deployment;
	}
	private async deploy(
		c: PlatformController,
		env: Environment,
		revision: string,
		actor: Actor,
		link: { proposalId?: string; promotionId?: string; requestId?: string; branch?: string; rollbackOf?: string },
	): Promise<Deployment> {
		if (env.target.type !== "cloudflare_worker")
			throw new CoordinationError(
				409,
				`${env.name} is deployed outside Cloudflare (${env.target.description}); record its evidence instead`,
			);
		if (env.kind === "production") c.gate("production.deploy", actor, { proposalId: link.proposalId, environmentId: env.id, revision });
		const resources = this.options.resources;
		if (!resources) throw new CoordinationError(503, "Connected Cloudflare account unavailable");
		const branch = link.branch ?? "main";
		const deployment = c.recordDeployment(
			{ environmentId: env.id, revision, branch, previous: liveDeployment(c.state, env.id)?.revision, ...link, actor: actor.developerId },
			actor,
		);
		this.save(c.state); // The deployment record exists before any infrastructure is touched.
		try {
			await pushDeployment(this.git, await resources.host(), env.target.deployRepository, revision, branch);
			c.updateDeployment(deployment.id, { state: "building" });
		} catch (error) {
			c.updateDeployment(deployment.id, { state: "failed", error: (error as Error).message.slice(0, 300) });
			this.save(c.state);
			return deployment;
		}
		this.save(c.state);
		if (this.options.orchestrate) this.background(this.options.orchestrate(deployment.id));
		return deployment;
	}
	/** One observation step for a deployment: build status, then Cruce's own smoke checks. Idempotent. */
	deploymentTick(deploymentId: string, expire = false) {
		return this.serialize(async () => {
			const c = new PlatformController(this.state(), this.now()),
				d = c.deployment(deploymentId),
				env = c.environment(d.environmentId);
			if (d.state !== "building" && d.state !== "queued") return d.state;
			if (expire) {
				c.updateDeployment(d.id, { state: "failed", error: "Build did not finish within the observation window" });
				this.save(c.state);
				return "failed";
			}
			if (env.target.type !== "cloudflare_worker" || !this.options.resources) return d.state;
			const builds = await this.options.resources.builds();
			const tag = env.target.scriptTag ?? (await builds.scriptTag(env.target.workerName));
			if (!tag) return d.state; // Worker not created yet (first build still pending).
			if (!env.target.scriptTag) {
				env.target.scriptTag = tag;
				for (const other of c.state.environments)
					if (other.target.type === "cloudflare_worker" && other.target.workerName === env.target.workerName) other.target.scriptTag = tag;
			}
			const build = await builds.buildFor(tag, d.revision, d.branch ?? "main");
			if (build?.status !== "stopped") {
				if (build) c.updateDeployment(d.id, { buildId: build.build_uuid });
				this.save(c.state);
				return d.state;
			}
			if (build.build_outcome !== "success") {
				c.updateDeployment(d.id, {
					state: "failed",
					buildId: build.build_uuid,
					error: `Workers Builds outcome: ${build.build_outcome ?? "unknown"}`,
				});
				this.save(c.state);
				return "failed";
			}
			// Never invent a URL: production routes are configured on the Worker, outside Cruce.
			const url = build.preview_url ?? undefined;
			c.updateDeployment(d.id, { state: "deployed", buildId: build.build_uuid, url });
			this.save(c.state);
			if (url && d.proposalId) await this.smoke(c, c.deployment(d.id), env, url);
			return "deployed";
		});
	}
	private async smoke(c: PlatformController, d: Deployment, env: Environment, url: string) {
		const results = await runSmokeChecks(url, env.smokeChecks, this.options.send ?? fetch, this.now);
		const passed = results.every((r) => r.ok);
		const p = c.proposal(d.proposalId);
		const m = c.mission(p.missionId);
		const runtime: Actor = {
			developerId: "cruce-runtime",
			tenantId: this.project.tenantId,
			projectIds: [this.project.id],
			kind: "runtime",
		};
		const content = JSON.stringify({ deployment: d.id, environment: env.name, revision: d.revision, url, results }, null, 2);
		const ledgerKey = `deployment-evidence:${d.id}`;
		const storage = this.host
			? await this.storeEvidence(ledgerKey, content, { deployment: d.id, revision: d.revision, kind: "preview_report" }, ledgerKey)
			: { repository: "offline", revision: d.revision };
		const artifact = c.artifact({
			kind: "preview_report",
			missionId: m.id,
			title: `${env.name} smoke checks`,
			summary: `${results.filter((r) => r.ok).length}/${results.length} checks passed at ${url}`,
			revision: d.revision,
			parentRevision: d.revision,
			contentHash: await sha256(content),
			storage,
			producer: { actor: runtime.developerId, kind: "runtime", tool: "cruce" },
			execution: {
				location: "cloudflare",
				detail: `${env.name} (${env.target.type === "cloudflare_worker" ? env.target.workerName : "external"})`,
			},
			related: [],
			trust: "verified",
		});
		c.runtimeVerification(d, "preview", passed ? "pass" : "fail", `${env.name}: ${artifact.summary}`, [artifact.id]);
		this.save(c.state);
	}
}

const evaluateTouched = (changes: Parameters<typeof evaluatePublish>[1], index: Parameters<typeof evaluatePublish>[2]) =>
	evaluatePublish([], changes, index, { allowNewTests: false }).touched;
async function sha256(text: string) {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
