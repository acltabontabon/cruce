import { archiveLayout, bundleIds, finishedWork, withBundles, withoutBundles } from "../core/archive.ts";
import { attentionView } from "../core/attention.ts";
import { humanMaintain, writeAccess } from "../core/capabilities.ts";
import { DomainError, requireValue, stable } from "../core/errors.ts";
import { initialRepository, RepositoryController } from "../core/platform.ts";
import { PUBLIC_ERRORS } from "../core/public-errors.ts";
import { assertRepositoryCapacity, assertStateBytes } from "../core/state-limits.ts";
import { gitRemotePath, parseGitRoute } from "../shared/git-access.ts";
import { STATE_LIMITS } from "../shared/limits.ts";
import type {
	ActivityEvent,
	ArchiveBundle,
	Artifact,
	Command,
	Repository,
	RepositoryState,
	ResourceAction,
	RetentionInspection,
	Workspace,
	WorkspaceUpdateDetails,
} from "../shared/platform.ts";
import { authorizeMachine, HUMAN_TOOLS, toolByName } from "../shared/tools.ts";
import { boundedBody, bufferedGitRequest, type RepositoryHost, ResourceBoundary, type StorageEnv } from "./artifacts.ts";
import { commandContext, correlate, diagnose, diagnoseError, withDiagnostics } from "./diagnostics.ts";
import { GitUpdateRejected, type GitWorkspace } from "./git/workspace.ts";
import type { ConnectionGrant, NamespaceRuntime } from "./namespace-runtime.ts";
import { Observation, type ObservationRoute, type PushSignal } from "./observation.ts";
import { ProviderIdentity, ProviderIdentityError } from "./provider-identity.ts";
import { readReconciliation } from "./reconciliation.ts";
import { RepositoryLifecycleRuntime } from "./repository-lifecycle.ts";
import { SourceInspection } from "./source-inspection.ts";
import { hash, jsonBytes, memoryStore, Serial, type Store } from "./store.ts";

interface CleanupOperation {
	command: Command;
	grant: ConnectionGrant;
	fingerprint: string;
	reservationId?: string;
	phase: "authorized" | "deleting" | "confirmed";
	state: "pending" | "blocked" | "complete";
	attempts: number;
	nextAttempt?: number;
	reason?: string;
}
type RecoveryPort = {
	schedule: (at: number) => Promise<void>;
	authorize: (grant: ConnectionGrant) => Promise<ConnectionGrant>;
};
/** Latest heartbeat or report for one workspace; rewritten in place so presence never accumulates records. */
interface ObservationSlot {
	op: string;
	fingerprint: string;
	templateId: string;
	lastActivity: number;
	lastReportAt?: number;
}
interface ObservationResult {
	templateId: string;
	template: Omit<Workspace, "lastActivity" | "lastReportAt">;
}
interface ResourceOperation {
	fingerprint: string;
	action: ResourceAction;
	reservationId: string;
	settled: boolean;
}
interface PublicationIntent {
	fingerprint: string;
	artifact: Artifact;
	phase: "prepared" | "attempted" | "confirmed";
	previousPublication?: string;
	changes?: Workspace["changes"];
	commits?: string[];
	counted?: boolean;
}
type NamespacePort = {
	[K in
		| "authority"
		| "repository"
		| "reserve"
		| "settle"
		| "abandon"
		| "releaseReservation"
		| "resourceConfiguration"
		| "lifecycle"
		| "lifecycleReservations"]: (
		...args: Parameters<NamespaceRuntime[K]>
	) => Awaited<ReturnType<NamespaceRuntime[K]>> | Promise<Awaited<ReturnType<NamespaceRuntime[K]>>>;
};
export class RepositoryRuntime {
	private serial = new Serial();
	private maintenanceNeeded = false;
	constructor(
		readonly store: Store,
		readonly git: GitWorkspace,
		readonly namespace: NamespacePort,
		readonly env: StorageEnv,
		readonly now = Date.now,
		readonly recovery?: RecoveryPort,
		readonly observationRoute?: (subscription: string, route: ObservationRoute) => Promise<void>,
	) {}
	private lifecycle() {
		return new RepositoryLifecycleRuntime(
			this.store,
			{
				authority: (grant, id) => this.namespace.authority(grant, id),
				lifecycle: (grant, id, lifecycle) => this.namespace.lifecycle(grant, id, lifecycle),
				lifecycleReservations: async (grant, id, operationId) => this.namespace.lifecycleReservations(grant, id, operationId),
				releaseReservation: async (grant, id, reservationId) => this.namespace.releaseReservation(grant, id, reservationId),
				reserve: async (grant, id, key, fingerprint, action, storageRequired) =>
					this.namespace.reserve(grant, id, key, fingerprint, action, undefined, storageRequired),
				settle: (id, state) => this.namespace.settle(id, state),
				host: async () => (await this.resources()).host(),
				storage: async () => (await this.resources()).storage(),
				schedule: async (at) => {
					if (!this.recovery) throw new DomainError(503, "Repository lifecycle unavailable");
					await this.recovery.schedule(at);
				},
				resetCache: () => this.git.resetCache(),
			},
			this.now,
		);
	}
	recoverDeletion() {
		return this.serial.run(() => this.lifecycle().recover(this.state().repository));
	}
	private retiring() {
		return Boolean(this.store.get("repository-deletion"));
	}
	private observation() {
		return new Observation(this.store, this.env, this.git, this.now, {
			authority: async (grant) => this.namespace.authority(grant, this.state().repository.id),
			reserve: async (grant, id, fingerprint) =>
				this.namespace.reserve(grant, this.state().repository.id, id, fingerprint, "observation.read"),
			settle: async (id) => this.namespace.settle(id, "complete"),
			host: async () => (await this.resources()).host(),
			schedule: async (at) => {
				if (this.recovery) await this.recovery.schedule(at);
			},
			route: async (subscription, route) => {
				if (!this.observationRoute) throw new DomainError(503, "Observation installation is not configured");
				await this.observationRoute(subscription, route);
			},
			canonical: (observation) => {
				const state = this.state();
				if (state.observedCanonical && state.observedCanonical.generation >= observation.generation) return;
				state.observedCanonical = observation;
				this.save(new RepositoryController(state, this.now(), () => "observation"));
			},
		});
	}
	ingestObservation(messageId: string, signal: PushSignal, route: ObservationRoute, failed = false) {
		return this.serial.run(() => {
			if (this.retiring() || this.state().repository.lifecycle?.state === "archived") return;
			return this.observation().ingest(this.state(), messageId, signal, route, failed);
		});
	}
	recoverObservation() {
		return this.serial.run(() => {
			if (this.retiring() || this.state().repository.lifecycle?.state === "archived") return;
			return this.observation().recover(this.state());
		});
	}

	initialize(repository: Repository) {
		const state = this.store.get<RepositoryState>("repository");
		if (state) {
			if (state.repository.id !== repository.id || state.repository.namespaceId !== repository.namespaceId)
				throw new DomainError(403, "Repository mismatch");
			return;
		}
		this.store.put("repository", initialRepository(repository));
	}
	state() {
		return requireValue(this.store.get<RepositoryState>("repository"), "Repository not initialized");
	}
	save(c: RepositoryController, extra: { key: string; value: unknown }[] = []) {
		archiveLayout(c.state);
		const latest = this.store.get<number>("activity-version") ?? 0;
		const activity = c.state.activity.filter((event) => Number(event.id.slice(6)) > latest);
		const entries: { key: string; value: unknown }[] = [
			...extra,
			...activity.map((event) => ({ key: `activity:${event.id.slice(6).padStart(16, "0")}`, value: event })),
		];
		for (const [id, receipt] of Object.entries(c.state.receipts)) entries.push({ key: `receipt:${id}`, value: receipt });
		let state: RepositoryState = { ...c.state, receipts: {}, activity: c.state.activity.slice(-STATE_LIMITS.recentActivity) };
		const deletes: string[] = [];
		const archive = this.archive(state, new Set(entries.map((e) => e.key)));
		if (archive) {
			entries.push(...archive.entries);
			deletes.push(...archive.deletes);
			state = withoutBundles(state, archive.bundles);
		}
		assertRepositoryCapacity(state);
		entries.push({ key: "repository", value: state }, { key: "activity-version", value: c.state.version });
		this.store.batch(entries, deletes);
		Object.assign(c.state, {
			receipts: {},
			activity: state.activity,
			archiveCount: state.archiveCount,
			workspaces: state.workspaces,
			artifacts: state.artifacts,
			proposals: state.proposals,
			verifications: state.verifications,
			promotions: state.promotions,
		});
	}
	/**
	 * Finished work moves to immutable archive records in the same transaction as the transition that
	 * finished it. Archival waits while a publication may still settle, never uses the recovery
	 * reserve, and is retried by a later save when storage is full rather than blocking the transition.
	 */
	private archive(state: RepositoryState, written: Set<string>) {
		if (this.store.get<number>("pending-publication-count")) return;
		const bundles = finishedWork(state, this.now());
		if (!bundles.length) return;
		const entries: { key: string; value: unknown }[] = [];
		const add = (key: string, value: unknown) => {
			if (written.has(key) || entries.some((e) => e.key === key) || this.store.get(key) !== undefined) return;
			entries.push({ key, value });
		};
		const deletes: string[] = [];
		for (const bundle of bundles) {
			const key = `archive:${String(Number.MAX_SAFE_INTEGER - bundle.sequence).padStart(16, "0")}`;
			entries.push({ key, value: bundle });
			for (const id of bundleIds(bundle)) add(`archived:${id}`, key);
			for (const artifact of bundle.artifacts) {
				if (artifact.kind === "source") add(`archived-revision:${artifact.revision}`, key);
				// Provider identity evidence otherwise derived from hot records stays recorded.
				if (artifact.storage.providerId) add(`provider-repository:${artifact.storage.repository}`, artifact.storage.providerId);
			}
			if (bundle.workspace.fork) add(`provider-repository:${bundle.workspace.fork.name}`, bundle.workspace.fork.id);
			for (const tool of ["heartbeat", "report_change"])
				for (const prefix of ["observation", "observation-result"]) {
					const observation = `${prefix}:${bundle.workspace.id}:${tool}`;
					if (!written.has(observation) && this.store.get(observation) !== undefined) deletes.push(observation);
				}
		}
		try {
			this.store.admit(jsonBytes(entries) + 4096, entries.length);
		} catch (error) {
			if (error instanceof DomainError && error.status === 409) return;
			throw error;
		}
		return { bundles, entries, deletes };
	}
	private archived(id?: string) {
		const key = id && (this.store.get<string>(`archived:${id}`) ?? this.store.get<string>(`archived-revision:${id}`));
		return key ? this.store.get<ArchiveBundle>(key) : undefined;
	}
	private async resources() {
		const config = await this.namespace.resourceConfiguration();
		const local: Store = {
			...memoryStore(),
			get: <T>(key: string) =>
				(key === "storage-binding" ? config.binding : key === "resource-account" && config.legacyAccount ? true : undefined) as
					| T
					| undefined,
			put: () => {
				throw new Error("Storage identity is owned by the namespace");
			},
			delete: () => {
				throw new Error("Storage identity is owned by the namespace");
			},
		};
		return new ResourceBoundary(local, this.env, { namespace: config.namespace }, fetch, new ProviderIdentity(this.store));
	}
	private async gate(
		grant: ConnectionGrant,
		cmd: Command,
		action: ResourceAction,
		run: (host: RepositoryHost) => Promise<unknown>,
		journal?: { prepare: (reservationId: string) => void; commit: (result: unknown) => void; settled: () => void },
	) {
		const r = await this.namespace.reserve(
			grant,
			requireValue(cmd.repositoryId, "Repository required"),
			requireValue(cmd.idempotencyKey, "Operation identity required"),
			stable(cmd),
			action,
			cmd.workspaceId,
		);
		await correlate({ reservationId: r.id, ...commandContext(cmd, grant.actor.id) });
		diagnose("resource_reserved", { action, phase: r.state });
		this.maintenanceNeeded = true;
		// Whether any provider call that can change cloud state started; reads and read tokens change nothing.
		let effects = false;
		try {
			journal?.prepare(r.id);
			const host = await (await this.resources()).host();
			const result = await run(
				new Proxy(host, {
					get: (target, key, receiver) => {
						const value = Reflect.get(target, key, receiver);
						if (typeof value !== "function") return value;
						return (...args: unknown[]) => {
							if (!["info", "verifyFork", "withSource"].includes(String(key)) && !(key === "withToken" && args[1] === "read"))
								effects = true;
							return value.apply(target, args);
						};
					},
				}),
			);
			journal?.commit(result);
			const phase = action === "workspace.cleanup" && (result as { state?: string }).state === "deleting" ? "uncertain" : "complete";
			await this.namespace.settle(r.id, phase);
			diagnose("resource_settled", { action, phase });
			journal?.settled();
			return result;
		} catch (error) {
			// A refusal before any provider effect performed nothing; leaving it uncertain would block retirement forever.
			const phase = !effects && error instanceof DomainError ? "released" : "uncertain";
			if (phase === "released") await this.namespace.abandon(r.id);
			else await this.namespace.settle(r.id, "uncertain");
			diagnose("resource_settled", { action, phase });
			throw error;
		}
	}
	private durableGate(
		c: RepositoryController,
		grant: ConnectionGrant,
		cmd: Command,
		op: string,
		fingerprint: string,
		action: ResourceAction,
		run: (host: RepositoryHost) => Promise<unknown>,
	) {
		let operation: ResourceOperation;
		return this.gate(grant, cmd, action, run, {
			prepare: (reservationId) => {
				operation = { fingerprint, action, reservationId, settled: false };
				const old = this.store.get<ResourceOperation>(`resource-operation:${op}`);
				if (old && old.fingerprint !== fingerprint) throw new DomainError(409, "Operation identity reused");
				this.store.put(`resource-operation:${op}`, operation);
			},
			commit: (result) => {
				c.state.receipts[op] = { fingerprint, result };
				const extra = [{ key: `resource-operation:${op}`, value: operation } as { key: string; value: unknown }];
				if (this.store.get<PublicationIntent>(`publication-intent:${op}`)?.counted)
					extra.push({
						key: "pending-publication-count",
						value: Math.max(0, (this.store.get<number>("pending-publication-count") ?? 0) - 1),
					});
				this.save(c, extra);
			},
			settled: () => this.store.put(`resource-operation:${op}`, { ...operation, settled: true }),
		});
	}
	private async known(c: RepositoryController, revision: string) {
		const tips = [
			...new Set([
				...(c.state.sourceHead ? [c.state.sourceHead] : []),
				...c.state.artifacts.filter((a) => a.kind === "source").map((a) => a.revision),
			]),
		];
		if (!(await this.git.hasCompleteSource(revision)))
			throw new DomainError(404, "Source cache unavailable; explicitly recover retained source");
		if (tips.includes(revision) || this.store.get(`archived-revision:${revision}`)) return;
		if ((await this.git.log(revision, 1)).length) {
			for (const tip of tips) if ((await this.git.mergeBase(revision, tip)) === revision) return;
		}
		throw new DomainError(404, "Source unavailable; publish committed source first");
	}
	/** Standard Git transport; authorization is repeated for both advertisement and RPC. */
	gitRequest(request: Request, grant: ConnectionGrant): Promise<Response> {
		return this.serial.run(async () => {
			const route = requireValue(parseGitRoute(new URL(request.url)), "Unsupported Git route");
			return withDiagnostics(
				{
					...route,
					tool:
						route.endpoint === "git-receive-pack" || new URL(request.url).searchParams.get("service") === "git-receive-pack"
							? "git_receive_pack"
							: "git_upload_pack",
				},
				async () => {
					const started = Date.now();
					diagnose("operation_started");
					try {
						const response = await this.gitTransport(request, grant, route);
						diagnose("operation_completed", { durationMs: Date.now() - started, status: response.status });
						return response;
					} catch (error) {
						diagnoseError("operation_failed", error, { durationMs: Date.now() - started });
						throw error;
					}
				},
			);
		});
	}
	private async gitTransport(
		request: Request,
		grant: ConnectionGrant,
		route: NonNullable<ReturnType<typeof parseGitRoute>>,
	): Promise<Response> {
		const state = structuredClone(this.state());
		if (route.repositoryId !== state.repository.id || route.namespaceId !== state.repository.namespaceId)
			throw new DomainError(403, "Repository identity mismatch");
		const a = await this.namespace.authority(grant, route.repositoryId);
		if (a.actor.kind === "agent" && !a.scopes?.includes("cruce:read")) throw new DomainError(403, "Git read scope required");
		if (!state.sourceHead) throw new DomainError(409, "Canonical repository unavailable");
		const service = route.endpoint === "info/refs" ? new URL(request.url).searchParams.get("service") : route.endpoint;
		if (
			!["git-upload-pack", "git-receive-pack"].includes(service ?? "") ||
			(route.endpoint === "info/refs" ? request.method !== "GET" : request.method !== "POST")
		)
			throw new DomainError(400, "Unsupported Git request");
		const write = service === "git-receive-pack";
		const currentRepository = await this.namespace.repository(grant, route.repositoryId);
		if (
			this.retiring() ||
			currentRepository.lifecycle?.state === "deleted" ||
			(write &&
				(this.store.get("repository-transition") ||
					currentRepository.lifecycle?.state === "archived" ||
					state.repository.lifecycle?.state === "archived"))
		)
			throw new DomainError(409, "Repository is read-only");
		if (a.actor.kind === "human" && a.actor.connectionId && route.workspaceId) {
			const bound = this.store.get<string>(`human-workspace:${a.actor.connectionId}`);
			if (bound && bound !== route.workspaceId) throw new DomainError(403, "Terminal Git scope denied");
		}
		const c = new RepositoryController(state, this.now(), () => "git");
		let name = requireValue(state.repository.storageName, "Canonical storage missing");
		let providerId = state.canonical?.id;
		if (route.workspaceId) {
			const workspace = c.workspace(route.workspaceId);
			if (workspace.fork?.state !== "ready") throw new DomainError(409, "Fork unavailable");
			name = workspace.fork.name;
			providerId = workspace.fork.id;
			if (write) {
				c.owned(a, workspace.id);
				if (a.actor.kind === "agent" && (!a.scopes?.includes("revision:publish") || !a.scopes?.includes("workspace:write")))
					throw new DomainError(403, "Git write scopes required");
			}
		} else if (write) throw new DomainError(403, "Canonical writes require reviewed human promotion");
		const bytes = request.method === "POST" ? await boundedBody(request) : undefined;
		const forward = () => bufferedGitRequest(request, bytes);
		if (write) {
			// A push is content addressed for retry accounting, but always replays Git so
			// the remote checks current refs. No success response is cached.
			const digest = bytes
				? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("")
				: "advertise";
			const cmd: Command = {
				tool: "git_receive_pack",
				namespaceId: route.namespaceId,
				repositoryId: route.repositoryId,
				workspaceId: route.workspaceId,
				idempotencyKey: `git-${route.workspaceId}-${digest}`,
			};
			return (await this.gate(grant, cmd, "revision.publish", (host) => host.gitRequest(name, forward(), providerId))) as Response;
		}
		return (await (await this.resources()).host()).gitRequest(name, forward(), providerId);
	}

	command(cmd: Command, grant: ConnectionGrant): Promise<unknown> {
		return this.serial.run(() =>
			withDiagnostics(commandContext(cmd, grant.actor.id), async () => {
				this.maintenanceNeeded = false;
				const started = Date.now();
				diagnose("operation_started");
				try {
					let result: unknown;
					try {
						result = await this.execute(cmd, grant);
					} finally {
						if (this.maintenanceNeeded) this.git.maintainCache();
						else this.git.clearCache();
					}
					if (cmd.tool === "start_workspace") await correlate({ workspaceId: (result as { id: string }).id });
					if (cmd.tool === "create_proposal") await correlate({ proposalId: (result as { id: string }).id });
					diagnose("operation_completed", { durationMs: Date.now() - started });
					return result;
				} catch (error) {
					diagnoseError("operation_failed", error, { durationMs: Date.now() - started });
					throw error;
				}
			}),
		);
	}
	private async execute(cmd: Command, grant: ConnectionGrant): Promise<unknown> {
		const repoId = requireValue(cmd.repositoryId, "Repository required"),
			a = await this.namespace.authority(grant, repoId);
		authorizeMachine(a, cmd);
		const repository = await this.namespace.repository(grant, repoId);
		if (cmd.tool === "retry_repository_setup" && !cmd.idempotencyKey) throw new DomainError(400, "Mutation requires an idempotency key");
		const stored = this.store.get<RepositoryState>("repository");
		if (
			cmd.namespaceId !== repository.namespaceId ||
			(stored && (stored.repository.id !== repoId || stored.repository.namespaceId !== repository.namespaceId))
		)
			throw new DomainError(403, "Repository identity mismatch");
		// An interrupted registration can still be inspected and retried from the console.
		// This empty projection is not persisted until explicit canonical setup.
		const state = archiveLayout(stored ? structuredClone(stored) : initialRepository(repository));
		state.repository = { ...repository, lifecycle: stored?.repository.lifecycle ?? repository.lifecycle };
		if (["archive_repository", "restore_repository", "delete_repository", "release_resource_operation"].includes(cmd.tool))
			return this.lifecycle().command(repository, cmd, grant);
		if (state.repository.lifecycle?.state === "deleted") throw new DomainError(410, "Repository has been deleted");
		const lifecycleMutation = HUMAN_TOOLS.has(cmd.tool) || toolByName(cmd.tool)?.mutation || cmd.tool === "provision_repository";
		if (
			lifecycleMutation &&
			(this.retiring() || this.store.get("repository-transition") || state.repository.lifecycle?.state === "archived") &&
			!(state.repository.lifecycle?.state === "archived" && ["inspect_source", "recover_source"].includes(cmd.tool))
		)
			throw new DomainError(409, "Repository is read-only");
		if (this.retiring() && !["get_repository", "get_activity"].includes(cmd.tool)) throw new DomainError(409, "Repository is read-only");
		if (cmd.tool === "retry_repository_setup") {
			// Replay the original provisioning intent so a failed creation reuses its operation identity
			// and charged reservation. Repositories created before intent was recorded use a stable key.
			humanMaintain(a);
			const original = this.store.get<Command>("provision-command");
			const originalOp = original?.idempotencyKey ? await hash(`${a.actor.id}:${original.idempotencyKey}`) : undefined;
			const operation = originalOp && this.store.get<ResourceOperation>(`resource-operation:${originalOp}`);
			if (state.canonical && (!operation || operation.settled)) throw new DomainError(409, "Canonical repository is already set up");
			cmd = this.store.get<Command>("provision-command") ?? {
				tool: "provision_repository",
				namespaceId: state.repository.namespaceId,
				repositoryId: repoId,
				idempotencyKey: `provision-${repoId}`,
			};
		}
		const op = cmd.idempotencyKey ? await hash(`${a.actor.id}:${cmd.idempotencyKey}`) : "read";
		// Namespace deletion freezes repositories it has not reached yet; only a promotion already under way may recover.
		if (
			a.namespaceDeleting &&
			lifecycleMutation &&
			!(cmd.tool === "promote_proposal" && state.promotions.some((p) => p.operation?.id === op))
		)
			throw new DomainError(409, "Namespace is being deleted");
		await correlate(commandContext(cmd, a.actor.id));
		const proposal = state.proposals.find((p) => p.id === cmd.proposalId);
		const artifact = state.artifacts.find((item) => item.id === (cmd.artifactId ?? proposal?.artifactId));
		if (artifact) await correlate({ workspaceId: artifact.workspaceId, revision: artifact.revision });
		const mutation = HUMAN_TOOLS.has(cmd.tool) || toolByName(cmd.tool)?.mutation || cmd.tool === "provision_repository";
		// Reads naming finished work see its archived records; this view is never saved. Source
		// inspection reserves but never saves repository state.
		const sourceRead = cmd.tool === "inspect_source" || cmd.tool === "recover_source";
		if (!mutation || sourceRead)
			withBundles(
				state,
				[cmd.workspaceId, cmd.artifactId, cmd.proposalId, cmd.subjectId, cmd.revision, cmd.baseRevision]
					.map((id) => this.archived(id))
					.filter((bundle) => !!bundle),
			);
		let sequence = 0;
		const c = new RepositoryController(state, this.now(), () => `${op.slice(0, 24)}-${sequence++}`);
		if (mutation && !cmd.idempotencyKey) throw new DomainError(400, "Mutation requires an idempotency key");
		if (mutation && !["inspect_source", "recover_source", "inspect_retention"].includes(cmd.tool)) writeAccess(a);
		if (cmd.tool === "review_proposal" && cmd.outcome === "approve" && a.actor.kind === "human") humanMaintain(a);
		if (cmd.humanAttested || HUMAN_TOOLS.has(cmd.tool)) humanMaintain(a);
		if (mutation && !stored) {
			if (cmd.tool !== "provision_repository") throw new DomainError(409, "Set up the canonical repository first");
			humanMaintain(a);
			this.initialize(repository);
		}
		if (a.actor.kind === "human" && a.actor.connectionId) {
			const bound = this.store.get<string>(`human-workspace:${a.actor.connectionId}`);
			if (bound && cmd.tool === "start_workspace" && !(this.store.get(`receipt:${op}`) ?? state.receipts[op]))
				throw new DomainError(409, "Terminal authorization is bound to an existing workspace");
			if (bound && cmd.workspaceId && bound !== cmd.workspaceId) throw new DomainError(403, "Terminal workspace scope denied");
		}
		const rawFingerprint = stable(cmd),
			fingerprint = await hash(rawFingerprint),
			receipt = this.store.get<RepositoryState["receipts"][string]>(`receipt:${op}`) ?? state.receipts[op];
		if (mutation) {
			const inspectionIntent = this.store.get<string>(`source-intent:${op}`);
			if (
				(receipt && receipt.fingerprint !== fingerprint && receipt.fingerprint !== rawFingerprint) ||
				(inspectionIntent && inspectionIntent !== fingerprint && inspectionIntent !== rawFingerprint)
			)
				throw new DomainError(409, "Operation identity reused");
		}
		const observing = cmd.tool === "heartbeat" || cmd.tool === "report_change";
		const archivedTarget =
			mutation && !sourceRead && [cmd.workspaceId, cmd.proposalId, cmd.artifactId].find((id) => id && this.store.get(`archived:${id}`));
		if (archivedTarget) {
			// Finished work is immutable. Retries of the operation that finished it return its receipt.
			if (receipt && !observing) {
				diagnose("operation_replayed");
				return receipt.result;
			}
			throw new DomainError(409, archivedTarget === cmd.proposalId ? "Change is not open" : "Workspace has ended");
		}
		if (cmd.tool === "promote_proposal") {
			humanMaintain(a);
			if (!state.promotions.some((p) => p.operation?.id === op)) {
				assertStateBytes(cmd, 32 * 1024);
				assertStateBytes({ ...state, receipts: {} }, STATE_LIMITS.admissionBytes);
				if (state.promotions.length >= STATE_LIMITS.promotions)
					throw new DomainError(409, "Repository record capacity reached; inspect retained records before adding work");
				this.store.admit();
			}
			if (receipt && receipt.fingerprint !== fingerprint && receipt.fingerprint !== rawFingerprint)
				throw new DomainError(409, "Operation identity reused");
			return this.promote(c, cmd, grant, op, fingerprint);
		}
		// Presence and reports are latest-wins observations. Each workspace keeps one replaceable slot per
		// tool: the latest operation replays exactly; an older or unknown one is a new observation.
		const slotKey = `observation:${cmd.workspaceId}:${cmd.tool}`;
		if (observing) {
			if (!cmd.workspaceId) throw new DomainError(404, "Workspace unavailable");
			const other = cmd.tool === "heartbeat" ? "report_change" : "heartbeat";
			if (this.store.get<ObservationSlot>(`observation:${cmd.workspaceId}:${other}`)?.op === op)
				throw new DomainError(409, "Operation identity reused");
			const slot = this.store.get<ObservationSlot>(slotKey);
			if (slot?.op === op) {
				if (slot.fingerprint !== fingerprint) throw new DomainError(409, "Operation identity reused");
				const stored = this.store.get<ObservationResult>(`observation-result:${cmd.workspaceId}:${cmd.tool}`);
				if (!stored || stored.templateId !== slot.templateId || (await hash(stable(stored.template))) !== slot.templateId)
					throw new DomainError(409, "Retained operation result unavailable; restore its recorded state before retrying");
				diagnose("operation_replayed");
				return { ...stored.template, lastActivity: slot.lastActivity, lastReportAt: slot.lastReportAt };
			}
		}
		if (
			mutation &&
			receipt &&
			!observing &&
			cmd.tool !== "inspect_source" &&
			cmd.tool !== "recover_source" &&
			cmd.tool !== "cleanup_workspace"
		) {
			if (receipt.fingerprint !== fingerprint && receipt.fingerprint !== rawFingerprint)
				throw new DomainError(409, "Operation identity reused");
			const operation = this.store.get<ResourceOperation>(`resource-operation:${op}`);
			if (operation) await correlate({ reservationId: operation.reservationId });
			diagnose("operation_replayed");
			if (operation) {
				// Recheck policy even for settled replay; repair settlement without provider I/O.
				await this.namespace.reserve(grant, repoId, cmd.idempotencyKey!, stable(cmd), operation.action, cmd.workspaceId);
				if (!operation.settled) {
					await this.namespace.settle(operation.reservationId, "complete");
					this.store.put(`resource-operation:${op}`, { ...operation, settled: true });
				}
			}
			return receipt.result;
		}
		const publicationRecovery = !!this.store.get<PublicationIntent>(`publication-intent:${op}`);
		if (mutation && !receipt && !observing && cmd.tool !== "cleanup_workspace" && !publicationRecovery) this.store.admit();
		if (mutation && !["cleanup_workspace", "end_workspace", "detach_workspace", "heartbeat", "report_change"].includes(cmd.tool)) {
			const recovery = publicationRecovery || (cmd.tool === "promote_proposal" && state.promotions.some((p) => p.operation?.id === op));
			if (!recovery) {
				assertStateBytes({ ...state, receipts: {} }, STATE_LIMITS.admissionBytes);
			}
			const additions: Record<string, keyof typeof STATE_LIMITS> = {
				start_workspace: "workspaces",
				publish_revision: "artifacts",
				publish_artifact: "artifacts",
				create_proposal: "proposals",
				record_verification: "verifications",
			};
			const field = additions[cmd.tool] as "workspaces" | "artifacts" | "proposals" | "verifications" | undefined;
			const pending =
				field === "artifacts" ? (this.store.get<number>("pending-publication-count") ?? 0) - (publicationRecovery ? 1 : 0) : 0;
			if (field && state[field].length + pending >= STATE_LIMITS[field])
				throw new DomainError(409, "Repository record capacity reached; inspect retained records before adding work");
		}
		let result: unknown;
		let resourceSaved = false;
		const repo = state.repository;
		if (cmd.tool === "configure_observation") {
			result = await this.observation().configure(state, grant, requireValue(cmd.enabled, "Observation enabled flag required"), op);
		} else if (cmd.tool === "get_reconciliation") {
			return readReconciliation(c, this.observation().status(state), this.git);
		} else if (cmd.tool === "inspect_source" || cmd.tool === "recover_source") {
			return this.gate(grant, cmd, "source.read", async (host) => {
				if (!this.store.get(`source-intent:${op}`)) this.store.put(`source-intent:${op}`, fingerprint);
				const source = new SourceInspection(host, state);
				return cmd.tool === "inspect_source"
					? source.inspect(cmd, this.git)
					: source.recover(this.git, requireValue(cmd.revision ?? state.sourceHead, "Choose a published revision"));
			});
		} else if (cmd.tool === "provision_repository") {
			humanMaintain(a);
			if (!this.store.get("provision-command")) this.store.put("provision-command", cmd);
			resourceSaved = true;
			result = await this.durableGate(c, grant, cmd, op, fingerprint, "repository.create", async (host) => {
				await this.git.ensureInit();
				const name = requireValue(repo.storageName, "Source storage missing"),
					info = await host.ensure(name, `Cruce repository ${repo.id}`, repo.defaultBranch);
				const fetched = await host.withToken(name, "read", (token) =>
					this.git.fetch({ url: info.remote, token, remoteBranch: repo.defaultBranch, localRef: "refs/cruce/source" }),
				);
				let head = fetched.result;
				if (!head) {
					const previous = this.store.get<string>("initial-revision");
					const author = this.store.get<import("./git/workspace.ts").GitAuthor>("initial-author") ?? {
						name: a.actor.name,
						email: "cruce@localhost",
						timestamp: Math.floor(repo.createdAt / 1000),
					};
					this.store.put("initial-author", author);
					head =
						previous && (await this.git.hasCompleteSource(previous))
							? previous
							: await this.git.commit({
									ref: "refs/cruce/source",
									parent: null,
									files: { "README.md": `# ${repo.name}\n` },
									message: "Initialize repository",
									author,
								});
					if (previous && previous !== head) throw new DomainError(409, "Repository setup retry differs from its recorded commit");
					this.store.put("initial-revision", head);
					await host.withToken(name, "write", (token) =>
						this.git.push({ url: info.remote, token, localRef: "refs/cruce/source", remoteRef: `refs/heads/${repo.defaultBranch}` }),
					);
				}
				state.canonical = { name: info.name, id: info.id, remote: info.remote };
				state.sourceHead = head;
				c.event(a.actor, "repository_created", `Created ${repo.name}`, [repo.id, head]);
				return { revision: head, remote: info.remote };
			});
		} else if (cmd.tool === "get_workspace_updates") {
			const s = c.workspace(cmd.workspaceId),
				updates = c.workspaceUpdates(s);
			const reconciliation = await readReconciliation(c, this.observation().status(state), this.git);
			const relation = reconciliation.workspaces.find((w) => w.workspaceId === s.id);
			const canonical = relation?.canonicalRevision;
			let available = false;
			let comparison: WorkspaceUpdateDetails["comparison"] = "unavailable";
			let files: import("../shared/platform.ts").WorkspaceChange[] = [];
			try {
				requireValue(canonical, "Upstream unavailable");
				if (!(await this.git.hasCompleteSource(canonical!)))
					throw new DomainError(404, "Source cache unavailable; explicitly recover retained source");
				await this.known(c, updates.baselineRevision);
				files = (await this.git.reviewChanges(updates.baselineRevision, canonical!)).files.map(({ path, status, binary }) => ({
					path,
					status,
					binary,
				}));
				available = true;
			} catch (error) {
				if (!(error instanceof DomainError)) throw error;
			}
			comparison = relation?.relation && relation.relation !== "unknown" ? relation.relation : "unavailable";
			available = available && comparison !== "unavailable";
			const touched = new Set(s.changes.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]));
			result = {
				...updates,
				status: comparison === "unavailable" ? "unknown" : comparison === "current" ? "current" : "available",
				trust: reconciliation.observation.canonical ? "observed" : "accepted",
				basis: relation?.basis ?? "baseline",
				comparedRevision: relation?.revision,
				revision: relation?.canonicalRevision,
				available,
				comparison,
				changes: files,
				overlappingPaths: files.map((f) => f.path).filter((p) => touched.has(p)),
				overlapTrust: "reported",
			} satisfies WorkspaceUpdateDetails;
		} else if (cmd.tool === "get_git_access") {
			if (!state.sourceHead) throw new DomainError(409, "Canonical Git repository is not ready");
			const workspace = cmd.workspaceId ? c.workspace(cmd.workspaceId) : undefined;
			result = {
				canonical: gitRemotePath(repo.namespaceId, repo.id),
				fork: workspace?.fork?.state === "ready" ? gitRemotePath(repo.namespaceId, repo.id, workspace.id) : undefined,
				defaultBranch: repo.defaultBranch,
				baseRevision: workspace?.baseRevision,
				canonicalWrite: false,
			};
		} else if (cmd.tool === "get_source" || cmd.tool === "get_history") {
			const revision = requireValue(cmd.revision ?? state.sourceHead, "Choose a published revision");
			await this.known(c, revision);
			result =
				cmd.tool === "get_history"
					? await this.git.log(revision)
					: { revision, files: await this.git.readFiles(revision, (p) => !cmd.path || p === cmd.path) };
		} else if (cmd.tool === "get_diff") {
			const base = requireValue(cmd.baseRevision, "Base required"),
				head = requireValue(cmd.revision, "Head required");
			await this.known(c, base);
			await this.known(c, head);
			result = await this.git.reviewChanges(base, head, cmd.path);
		} else if (cmd.tool === "read_artifact") {
			const artifact = c.artifact(cmd.artifactId);
			// Evidence commits are outside source ancestry; only their cached completeness is checked.
			if (artifact.storage.path && !(await this.git.hasCompleteSource(artifact.storage.revision)))
				throw new DomainError(404, "Artifact cache unavailable; inspect the retained artifact source");
			result = {
				artifact,
				content: artifact.storage.path
					? (await this.git.readFiles(artifact.storage.revision, (p) => p === artifact.storage.path))[artifact.storage.path]
					: undefined,
			};
		} else if (cmd.tool === "attach_workspace") {
			result = c.command(cmd, a);
			const s = c.workspace(cmd.workspaceId);
			if (!s.fork) {
				resourceSaved = true;
				result = await this.durableGate(c, grant, cmd, op, fingerprint, "workspace.fork", async (host) => {
					await this.git.ensureInit();
					if (!(await this.git.hasCompleteSource(s.baseRevision)))
						await new SourceInspection(host, state).recover(this.git, s.baseRevision);
					await this.known(c, s.baseRevision);
					const canonical = requireValue(repo.storageName, "Canonical storage missing");
					const name = `repo-${repo.id}-workspace-${s.id}`;
					const fork = await host.fork(canonical, name, `Cruce workspace ${s.id}`);
					// The provider forks refs at request time, not at a requested SHA. Pin the
					// exact base without rewriting inherited branches or canonical history.
					await this.git.setRef("refs/cruce/baseline", s.baseRevision);
					await host.withToken(name, "write", (token) =>
						this.git.push({ url: fork.remote, token, localRef: "refs/cruce/baseline", remoteRef: "refs/heads/cruce-base" }),
					);
					s.fork = { name, id: fork.id, remote: fork.remote, state: "ready" };
					return s;
				});
			}
		} else if (cmd.tool === "get_activity") {
			const after = cmd.cursor ? `activity:${cmd.cursor}` : "activity:";
			const indexed = this.store.scan<ActivityEvent>("activity:", after, STATE_LIMITS.pageSize + 1);
			const legacy = state.activity
				.map((value) => ({ key: `activity:${value.id.slice(6).padStart(16, "0")}`, value }))
				.filter(({ key }) => key > after);
			const rows = [...new Map([...legacy, ...indexed].map((row) => [row.key, row])).values()]
				.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
				.slice(0, STATE_LIMITS.pageSize + 1);
			return {
				items: rows.slice(0, STATE_LIMITS.pageSize).map(({ value }) => value),
				cursor: rows.length > STATE_LIMITS.pageSize ? rows[STATE_LIMITS.pageSize - 1].key.slice("activity:".length) : undefined,
			};
		} else if (cmd.tool === "get_archive") {
			// A subject that is not archived (still live, or unknown) reads as null.
			if (cmd.subjectId) return this.archived(cmd.subjectId) ?? null;
			const page = STATE_LIMITS.archivePage;
			const rows = this.store.scan<ArchiveBundle>("archive:", cmd.cursor ? `archive:${cmd.cursor}` : "archive:", page + 1);
			return {
				items: rows.slice(0, page).map(({ value }) => value),
				cursor: rows.length > page ? rows[page - 1].key.slice("archive:".length) : undefined,
				total: state.archiveCount,
			};
		} else if (cmd.tool === "get_retention") {
			const workspace = c.workspace(cmd.workspaceId);
			const operation = workspace.cleanup && {
				...workspace.cleanup,
				command: workspace.cleanup.actorId === a.actor.id ? workspace.cleanup.command : undefined,
			};
			return { lifecycle: c.forkCleanup(workspace), inspection: workspace.retention, operation };
		} else if (cmd.tool === "inspect_retention") {
			const workspace = c.workspace(cmd.workspaceId);
			result = await this.gate(grant, cmd, "source.read", (host) => this.inspectRetention(c, workspace, host));
		} else if (cmd.tool === "cleanup_workspace") {
			return this.cleanup(c, cmd, grant, op, fingerprint);
		} else if (cmd.tool === "publish_revision" || cmd.tool === "publish_artifact") {
			resourceSaved = true;
			result = await this.publish(c, cmd, grant, op, fingerprint);
		} else {
			result = c.command(cmd, a);
			if (cmd.tool === "get_workspace") {
				const workspace = result as Workspace;
				result = {
					...workspace,
					observedRef: this.observation().status(state).workspaces[workspace.id],
					observedRefs: this.store.get(`observation-inventory:${workspace.id}`),
				};
			}
			if (cmd.tool === "get_repository") {
				const snapshot = result as import("../shared/platform.ts").RepositorySnapshot;
				snapshot.lifecycle = await this.lifecycle().view(state.repository, grant, a);
				if (snapshot.lifecycle.state !== "active" || this.store.get("repository-transition")) {
					snapshot.permissions.write = false;
					snapshot.permissions.maintain = false;
					snapshot.permissions.approve = false;
					snapshot.canonicalSetup.retry = false;
				}
				snapshot.reconciliation = await readReconciliation(c, this.observation().status(state), this.git);
				// Reconciliation adds published ancestry, so attention is derived again from the completed snapshot.
				snapshot.attention = attentionView(snapshot, a.actor.userId);
				const setup = this.store.get<Command>("provision-command");
				if (
					setup?.idempotencyKey &&
					snapshot.canonical &&
					a.actor.kind === "human" &&
					!a.actor.connectionId &&
					a.repositoryRole === "maintain"
				) {
					const setupOp = await hash(`${a.actor.id}:${setup.idempotencyKey}`);
					const operation = this.store.get<ResourceOperation>(`resource-operation:${setupOp}`);
					if (operation && !operation.settled) snapshot.canonicalSetup = { required: false, retry: true, settlementPending: true };
				}
				(result as import("../shared/platform.ts").RepositorySnapshot).capacity = {
					...this.store.usage(),
					stateBytes: jsonBytes(state),
					limits: STATE_LIMITS,
				};
			}
		}
		if (mutation && !resourceSaved) {
			if (cmd.tool === "start_workspace" && a.actor.kind === "human" && a.actor.connectionId)
				this.store.put(`human-workspace:${a.actor.connectionId}`, (result as { id: string }).id);
			const extra: { key: string; value: unknown }[] = [];
			if (observing) {
				const { lastActivity, lastReportAt, ...template } = result as Workspace;
				const templateId = await hash(stable(template));
				const resultKey = `observation-result:${cmd.workspaceId}:${cmd.tool}`;
				const previous = this.store.get<ObservationResult>(resultKey);
				const slot: ObservationSlot = { op, fingerprint, templateId, lastActivity, lastReportAt };
				const records = (this.store.get(slotKey) ? 0 : 1) + (previous ? 0 : 1);
				const changed = previous?.templateId !== templateId;
				const growth = changed ? jsonBytes({ templateId, template }) - (previous ? jsonBytes(previous) : 0) : 0;
				// Steady presence rewrites fixed keys; only real growth must fit outside the recovery reserve.
				if (records > 0 || growth > 0) this.store.admit(Math.max(growth, 0) + jsonBytes(slot) + 1024, records);
				extra.push({ key: slotKey, value: slot });
				if (changed) extra.push({ key: resultKey, value: { templateId, template } satisfies ObservationResult });
			} else state.receipts[op] = { fingerprint, result };
			this.save(c, extra);
		}
		if (mutation) {
			await this.observation().sync(state);
			if (this.observation().status(state).enabled) await this.recovery?.schedule(this.now() + 1000);
		}
		return result;
	}
	private async publicationTip(host: RepositoryHost, artifact: Artifact) {
		const storage = artifact.storage;
		const info = await host.info(storage.repository);
		if (info.id !== storage.providerId) throw new ProviderIdentityError("Retained source provider identity changed; publication refused");
		if (host.withSource) {
			const tips = await host.withSource(storage.repository, storage.providerId, (source) => source.log({ ref: storage.ref, limit: 1 }));
			return tips[0]?.hash;
		}
		return (
			await host.withToken(
				storage.repository,
				"read",
				async (token) => (await this.git.remoteRefs({ url: info.remote, token })).find((ref) => ref.ref === storage.ref)?.oid,
			)
		).result;
	}
	private async publish(c: RepositoryController, cmd: Command, grant: ConnectionGrant, op: string, fingerprint: string) {
		const action = cmd.tool === "publish_revision" ? "revision.publish" : "artifact.publish";
		return this.durableGate(c, grant, cmd, op, fingerprint, action, async (host) => {
			const state = c.state,
				repo = state.repository;
			const a = await this.namespace.authority(grant, repo.id);
			writeAccess(a);
			const s = c.workspace(cmd.workspaceId);
			if (s.ownerId !== a.actor.userId) throw new DomainError(403, "Workspace belongs to another user");
			const key = `publication-intent:${op}`;
			let intent = this.store.get<PublicationIntent>(key);
			if (intent && intent.fingerprint !== fingerprint) throw new DomainError(409, "Operation identity reused");
			if (!intent) c.owned(a, s.id);
			const revision = requireValue(cmd.revision, "Revision required");
			// A live recorded fork must retain its identity even when a checkpoint is reused.
			if (cmd.tool === "publish_revision" && s.fork?.state === "ready") {
				if ((await host.info(s.fork.name)).id !== s.fork.id) throw new DomainError(409, "Fork identity changed; publication refused");
			}
			const artifactId = `${op.slice(0, 24)}-artifact`;
			const provenanceKey = `publication-provenance:${op}`;
			const provenance = this.store.get<{ actor: typeof a.actor; at: number; title: string }>(provenanceKey) ?? {
				actor: a.actor,
				at: this.now(),
				title: cmd.title ?? s.title,
			};
			if (!this.store.get(provenanceKey)) this.store.put(provenanceKey, provenance);
			if (!intent) {
				await this.git.ensureInit();
				let storage: Artifact["storage"], contentHash: string, baseRevision: string | undefined;
				let changes: Workspace["changes"] | undefined, commits: string[] | undefined;
				if (cmd.tool === "publish_revision") {
					const fork = requireValue(s.fork, "Attach a hosted fork first");
					if (fork.state !== "ready") throw new DomainError(409, "Fork unavailable");
					const forkInfo = await host.info(fork.name);
					if (forkInfo.id !== fork.id) throw new DomainError(409, "Fork identity changed; publication refused");
					const storageName = `repo-${repo.id}-artifacts`;
					const retainedId = new ProviderIdentity(this.store).expected(storageName);
					if (retainedId && (await host.info(storageName)).id !== retainedId)
						throw new ProviderIdentityError("Retained source provider identity changed; publication refused");
					const pushed = (
						await host.withToken(fork.name, "read", async (token) => {
							const head = await this.git.fetch({
								url: forkInfo.remote,
								token,
								remoteBranch: requireValue(cmd.ref, "Pushed fork branch required"),
								localRef: `refs/cruce/checkpoint/${s.id}`,
							});
							if (head === revision && !(await this.git.hasCompleteSource(revision)))
								await this.git.recover({ url: forkInfo.remote, token, ref: cmd.ref!, expected: revision });
							return head;
						})
					).result;
					if (pushed !== revision) throw new DomainError(409, "Fork ref moved; publish its exact current revision");
					const source = new SourceInspection(host, state);
					for (const needed of new Set(
						[s.baseRevision, s.publishedRevision, s.integratedRevision, state.sourceHead, cmd.baseRevision].filter((r): r is string => !!r),
					))
						if (!(await this.git.hasCompleteSource(needed))) await source.recover(this.git, needed);
					if (!(await this.git.hasCompleteSource(revision))) throw new DomainError(409, "Pushed source graph is incomplete");
					if ((await this.git.mergeBase(s.publishedRevision ?? s.baseRevision, revision)) !== (s.publishedRevision ?? s.baseRevision))
						throw new DomainError(409, "Published commits must descend from the workspace baseline and previous publication");
					const upstream = c.upstream();
					// Review against upstream only once it carries the baseline; a baseline ahead of canonical stays the base.
					baseRevision =
						this.store.get<string>(`publication-base:${op}`) ??
						cmd.baseRevision ??
						(upstream &&
						(await this.git.mergeBase(upstream, revision)) === upstream &&
						(await this.git.mergeBase(s.baseRevision, upstream)) === s.baseRevision
							? upstream
							: (s.integratedRevision ?? s.baseRevision));
					if (
						baseRevision !== s.baseRevision &&
						baseRevision !== s.integratedRevision &&
						baseRevision !== upstream &&
						!this.store.get(`publication-base:${op}`)
					)
						throw new DomainError(409, "Review base must name the workspace baseline or observed upstream revision");
					if (
						(await this.git.mergeBase(s.baseRevision, baseRevision)) !== s.baseRevision ||
						(await this.git.mergeBase(baseRevision, revision)) !== baseRevision
					)
						throw new DomainError(409, "Integrate the review base with Git before publishing");
					const diff = await this.git.reviewChanges(baseRevision, revision);
					changes = diff.files.map(({ path, status, binary }) => ({ path, status, binary }));
					if (
						a.repositoryRole !== "maintain" &&
						changes.some((f) => repo.policy.protectedPaths.some((p) => f.path === p || f.path.startsWith(`${p}/`)))
					)
						throw new DomainError(403, "Protected paths require a repository maintainer");
					this.store.put(`publication-base:${op}`, baseRevision);
					this.store.put(`publication-revision:${op}`, revision);
					contentHash = Array.from(
						new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(await this.git.exportPack(revision)))),
						(b) => b.toString(16).padStart(2, "0"),
					).join("");
					commits = [];
					for (const commit of await this.git.log(revision, 1000)) {
						if (commit.oid === baseRevision) break;
						commits.push(commit.oid);
					}
					const info = await host.ensure(storageName, `Cruce source artifacts ${repo.id}`, repo.defaultBranch);
					storage = { repository: storageName, providerId: info.id, revision, ref: `refs/heads/artifact-${artifactId}` };
				} else {
					if (
						revision !== s.baseRevision &&
						!state.artifacts.some((a) => a.kind === "source" && a.workspaceId === s.id && a.revision === revision)
					)
						throw new DomainError(409, "Evidence must name the base or a published workspace revision");
					const content = requireValue(cmd.content, "Artifact content required"),
						path = `artifacts/${artifactId}.txt`,
						name = `repo-${repo.id}-evidence`;
					const authorKey = `artifact-author:${op}`;
					const author = this.store.get<import("./git/workspace.ts").GitAuthor>(authorKey) ?? {
						name: provenance.actor.name,
						email: "cruce@localhost",
						timestamp: Math.floor(provenance.at / 1000),
					};
					this.store.put(authorKey, author);
					const oid = await this.git.commit({
						ref: `refs/cruce/evidence/${artifactId}`,
						parent: null,
						files: { [path]: content },
						message: `Evidence for ${revision}`,
						author,
					});
					const previous = this.store.get<string>(`artifact-commit:${op}`);
					if (previous && previous !== oid) throw new DomainError(409, "Evidence retry differs from its recorded commit");
					this.store.put(`artifact-commit:${op}`, oid);
					const info = await host.ensure(name, `Cruce evidence ${repo.id}`);
					storage = { repository: name, providerId: info.id, path, revision: oid, ref: `refs/heads/artifact-${artifactId}` };
					contentHash = await hash(content);
				}
				intent = {
					fingerprint,
					artifact: {
						id: artifactId,
						namespaceId: repo.namespaceId,
						repositoryId: repo.id,
						workspaceId: s.id,
						...provenance,
						revision,
						baseRevision,
						kind: cmd.tool === "publish_revision" ? "source" : "evidence",
						contentHash,
						trust: "reported",
						storage,
					},
					phase: "prepared",
					previousPublication: s.publishedRevision,
					changes,
					commits,
					counted: true,
				};
				this.store.batch([
					{ key, value: intent },
					{ key: "pending-publication-count", value: (this.store.get<number>("pending-publication-count") ?? 0) + 1 },
				]);
			}
			const storage = intent.artifact.storage;
			if (intent.phase === "confirmed" && (await host.info(storage.repository)).id !== storage.providerId)
				throw new ProviderIdentityError("Retained source provider identity changed; publication refused");
			if (intent.phase === "attempted") {
				const tip = await this.publicationTip(host, intent.artifact);
				if (tip && tip !== storage.revision) throw new DomainError(409, "Retained publication ref differs from its exact revision");
				if (tip === storage.revision) intent.phase = "confirmed";
				else intent.phase = "prepared";
				this.store.put(key, intent);
			}
			if (intent.phase === "prepared") {
				const currentAuthority = await this.namespace.authority(grant, repo.id);
				c.owned(currentAuthority, s.id);
				const currentRepo = await this.namespace.repository(grant, repo.id);
				if (
					currentAuthority.repositoryRole !== "maintain" &&
					intent.changes?.some((f) => currentRepo.policy.protectedPaths.some((p) => f.path === p || f.path.startsWith(`${p}/`)))
				)
					throw new DomainError(403, "Protected paths require a repository maintainer");
				if (!(await this.git.hasCompleteSource(storage.revision))) {
					if (intent.artifact.kind === "evidence") {
						const author = requireValue(
							this.store.get<import("./git/workspace.ts").GitAuthor>(`artifact-author:${op}`),
							"Evidence retry differs from its recorded commit",
						);
						const oid = await this.git.commit({
							ref: `refs/cruce/evidence/${artifactId}`,
							parent: null,
							files: { [storage.path!]: requireValue(cmd.content, "Artifact content required") },
							message: `Evidence for ${revision}`,
							author,
						});
						if (oid !== storage.revision) throw new DomainError(409, "Evidence retry differs from its recorded commit");
					} else {
						const fork = requireValue(s.fork, "Attach a hosted fork first"),
							info = await host.info(fork.name);
						if (info.id !== fork.id) throw new DomainError(409, "Fork identity changed; publication refused");
						await host.withToken(fork.name, "read", (token) =>
							this.git.recover({ url: info.remote, token, ref: requireValue(cmd.ref, "Pushed fork branch required"), expected: revision }),
						);
					}
				}
				const info = await host.info(storage.repository);
				if (info.id !== storage.providerId)
					throw new ProviderIdentityError("Retained source provider identity changed; publication refused");
				await this.namespace.reserve(grant, repo.id, cmd.idempotencyKey!, stable(cmd), action, cmd.workspaceId);
				await this.git.setRef(storage.ref!, storage.revision);
				intent.phase = "attempted";
				this.store.put(key, intent);
				await host.withToken(storage.repository, "write", (token) =>
					this.git.push({ url: info.remote, token, localRef: storage.ref!, remoteRef: storage.ref! }),
				);
				intent.phase = "confirmed";
				this.store.put(key, intent);
			}
			if (intent.artifact.kind === "source" && s.publishedRevision === intent.previousPublication) {
				s.publishedRevision = intent.artifact.revision;
				s.headRevision = intent.artifact.revision;
				s.integratedRevision = intent.artifact.baseRevision;
				s.changes = intent.changes ?? [];
				s.commits = intent.commits ?? [];
			}
			return c.addArtifact(intent.artifact);
		});
	}
	private async inspectRetention(c: RepositoryController, workspace: Workspace, host: RepositoryHost): Promise<RetentionInspection> {
		const fork = workspace.fork;
		if (!fork) throw new DomainError(409, "No retained fork");
		if (fork.state !== "ready") throw new DomainError(409, "Fork unavailable");
		const info = await host.info(fork.name);
		if (info.id !== fork.id) throw new ProviderIdentityError("Fork identity changed; cleanup refused");
		const { result: refs } = await host.withToken(fork.name, "read", (token) => this.git.remoteRefs({ url: info.remote, token }));
		const valid =
			refs.length <= STATE_LIMITS.cleanupRefs &&
			refs.every((ref) => new TextEncoder().encode(ref.ref).length <= 256 && /^[a-f0-9]{40}$/.test(ref.oid));
		const inspection: RetentionInspection = { checkedAt: this.now(), forkId: fork.id, complete: valid, refs: [], blockers: [] };
		if (!inspection.complete) inspection.blockers.push("Fork ref inventory exceeds the cleanup limit");
		const source = new SourceInspection(host, c.state);
		for (const ref of valid ? refs : []) {
			if (ref.ref.endsWith("^{}")) continue;
			let retained = false;
			let reason: "unretained" | "unavailable" | undefined;
			try {
				if (host.withSource) await source.locate(ref.oid);
				else await this.known(c, ref.oid);
				retained = true;
			} catch (error) {
				if (!(error instanceof DomainError) || ![404, 409, 413].includes(error.status)) throw error;
				reason = error.status === 404 && !error.message.includes("cache unavailable") ? "unretained" : "unavailable";
			}
			inspection.refs.push({ ref: ref.ref, revision: ref.oid, retained, reason });
		}
		if (inspection.refs.some((ref) => ref.reason === "unavailable"))
			inspection.blockers.push("Retention proof unavailable; recover or inspect source before cleanup");
		if (inspection.refs.some((ref) => ref.reason === "unretained"))
			inspection.blockers.push("Unretained fork refs; publish their commits before cleanup");
		workspace.retention = inspection;
		this.save(c);
		return inspection;
	}
	private cleanupAuthority(c: RepositoryController, cmd: Command, a: import("../shared/platform.ts").Authority) {
		const workspace = c.workspace(cmd.workspaceId);
		authorizeMachine(a, cmd);
		writeAccess(a);
		if (a.actor.kind === "agent" && workspace.ownerId !== a.actor.userId) throw new DomainError(403, "Workspace belongs to another user");
		// A human owner may delete their own workspace's fork; anyone else's needs Maintain.
		if (a.actor.kind === "human" && workspace.ownerId !== a.actor.userId) humanMaintain(a);
		const readiness = c.forkCleanup(workspace);
		if (workspace.fork?.state !== "deleted" && !readiness.ready) throw new DomainError(409, readiness.reasons[0]);
		return workspace;
	}
	private async scheduleCleanup(at: number) {
		if (this.recovery) await this.recovery.schedule(at);
	}
	private cleanupView(op: string, operation: CleanupOperation): NonNullable<Workspace["cleanup"]> {
		const { state, phase, attempts, nextAttempt, reason } = operation;
		return { operationId: op, actorId: operation.grant.actor.id, command: operation.command, state, phase, attempts, nextAttempt, reason };
	}
	private async cleanup(c: RepositoryController, cmd: Command, grant: ConnectionGrant, op: string, fingerprint: string) {
		const workspace = this.cleanupAuthority(c, cmd, await this.namespace.authority(grant, c.state.repository.id));
		assertStateBytes(cmd, 8192);
		const key = `cleanup:${workspace.id}`;
		let operation = this.store.get<CleanupOperation>(key);
		if (operation) {
			if (workspace.cleanup?.operationId !== op || (operation.fingerprint !== fingerprint && operation.fingerprint !== stable(cmd)))
				throw new DomainError(409, "Resume the existing authorized cleanup operation");
			// A current authenticated retry can renew a connection's continuation proof.
			operation.grant = grant;
		} else {
			if (workspace.fork?.state === "deleted") throw new DomainError(409, "No retained fork");
			operation = {
				command: cmd,
				grant,
				fingerprint,
				phase: workspace.fork?.state === "deleting" ? "deleting" : "authorized",
				state: "pending",
				attempts: 0,
			};
			this.store.admit(jsonBytes(operation) + 128 * 1024, 6);
		}
		if (operation.state === "complete") return { workspaceId: workspace.id, state: "deleted" };
		operation.state = "pending";
		operation.reason = undefined;
		operation.attempts++;
		operation.nextAttempt = this.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(operation.attempts - 1, 7));
		// Arm the wakeup before accepting the durable intent. A crash after this save
		// has a wakeup; a crash before it has neither deletion authority nor effects.
		await this.scheduleCleanup(operation.nextAttempt);
		workspace.cleanup = this.cleanupView(op, operation);
		this.save(c, [{ key, value: operation }]);
		let reservation: Awaited<ReturnType<NamespacePort["reserve"]>> | undefined;
		try {
			reservation = await this.namespace.reserve(
				grant,
				c.state.repository.id,
				cmd.idempotencyKey!,
				stable(cmd),
				"workspace.cleanup",
				workspace.id,
			);
			operation.reservationId = reservation.id;
			await correlate({ reservationId: reservation.id });
			diagnose("resource_reserved", { action: "workspace.cleanup", phase: reservation.state });
			if (operation.phase !== "confirmed") {
				const host = await (await this.resources()).host();
				if (operation.phase === "authorized") {
					const inspection = await this.inspectRetention(c, workspace, host);
					if (!inspection.complete || inspection.blockers.length) throw new DomainError(409, inspection.blockers[0]);
					this.cleanupAuthority(c, cmd, await this.namespace.authority(grant, c.state.repository.id));
					// Recheck narrowed resource policy immediately before the irreversible request.
					await this.namespace.reserve(grant, c.state.repository.id, cmd.idempotencyKey!, stable(cmd), "workspace.cleanup", workspace.id);
					operation.phase = "deleting";
					workspace.fork!.state = "deleting";
					workspace.cleanup = this.cleanupView(op, operation);
					c.event(grant.actor, "fork_deleting", `Fork deletion authorized for ${workspace.title}`, [workspace.id]);
					this.save(c, [{ key, value: operation }]);
				}
				const currentGrant = grant.continuation && this.recovery ? await this.recovery.authorize(grant) : grant;
				this.cleanupAuthority(c, cmd, await this.namespace.authority(currentGrant, c.state.repository.id));
				await this.namespace.reserve(
					currentGrant,
					c.state.repository.id,
					cmd.idempotencyKey!,
					stable(cmd),
					"workspace.cleanup",
					workspace.id,
				);
				if (!(await host.remove(workspace.fork!.name, workspace.fork!.id))) {
					await this.namespace.settle(reservation.id, "uncertain");
					return { workspaceId: workspace.id, state: "deleting" };
				}
				operation.phase = "confirmed";
				workspace.fork!.state = "deleted";
				c.event(grant.actor, "fork_deleted", `Removed fork for ${workspace.title}`, [workspace.id]);
				workspace.cleanup = this.cleanupView(op, operation);
				c.state.receipts[op] = { fingerprint, result: { workspaceId: workspace.id, state: "deleted" } };
				this.save(c, [{ key, value: operation }]);
			}
			await this.namespace.settle(reservation.id, "complete");
			diagnose("resource_settled", { action: "workspace.cleanup", phase: "complete" });
			operation.state = "complete";
			operation.nextAttempt = undefined;
			workspace.cleanup = this.cleanupView(op, operation);
			this.save(c, [{ key, value: operation }]);
			return { workspaceId: workspace.id, state: "deleted" };
		} catch (error) {
			// Reload after failed persistence so an uncommitted confirmation cannot
			// overwrite the durable phase or cause deletion to be marked complete.
			const durable = this.state(),
				saved = this.store.get<CleanupOperation>(key)!;
			const current = durable.workspaces.find((w) => w.id === workspace.id)!;
			const blocked = error instanceof DomainError && [400, 401, 403, 409, 413].includes(error.status);
			saved.state = blocked ? "blocked" : "pending";
			saved.reason = blocked
				? "Cleanup blocked; inspect retention, authority and storage identity before retrying"
				: "Cleanup interrupted; recovery will retry the authorized operation";
			if (blocked) saved.nextAttempt = undefined;
			current.cleanup = this.cleanupView(op, saved);
			this.save(new RepositoryController(durable, this.now(), () => "cleanup-recovery"), [{ key, value: saved }]);
			if (reservation) await this.namespace.settle(reservation.id, saved.phase === "confirmed" ? "complete" : "uncertain");
			throw error;
		}
	}
	/** Bounded recovery of submitted deletion intents only. Expiry creates no intent. */
	recoverCleanup() {
		return this.serial.run(async () => {
			const state = this.store.get<RepositoryState>("repository");
			if (!state || this.retiring() || state.repository.lifecycle?.state === "archived") return;
			const due = state.workspaces
				.filter((w) => w.cleanup?.state === "pending" && (w.cleanup.nextAttempt ?? 0) <= this.now())
				.slice(0, STATE_LIMITS.recoveryBatch);
			for (const workspace of due) {
				const key = `cleanup:${workspace.id}`,
					operation = this.store.get<CleanupOperation>(key);
				if (!operation || !this.recovery) continue;
				try {
					const grant = await this.recovery.authorize(operation.grant);
					await withDiagnostics(commandContext(operation.command, grant.actor.id), () => this.execute(operation.command, grant));
				} catch (error) {
					const c = new RepositoryController(this.state(), this.now(), () => "cleanup-recovery"),
						saved = this.store.get<CleanupOperation>(key)!;
					if (error instanceof DomainError && [401, 403, 409, 413].includes(error.status)) {
						saved.state = "blocked";
						saved.nextAttempt = undefined;
						saved.reason = "Cleanup recovery needs current authorization or retention proof";
					} else if ((saved.nextAttempt ?? 0) <= this.now()) saved.nextAttempt = this.now() + 3_600_000;
					c.workspace(workspace.id).cleanup = this.cleanupView(workspace.cleanup!.operationId, saved);
					this.save(c, [{ key, value: saved }]);
				} finally {
					this.git.clearCache();
				}
			}
			const pending = this.state().workspaces.flatMap((w) =>
				w.cleanup?.state === "pending" && w.cleanup.nextAttempt !== undefined ? [w.cleanup.nextAttempt] : [],
			);
			if (pending.length) await this.scheduleCleanup(Math.max(this.now() + 1000, Math.min(...pending)));
		});
	}
	/** Journal before I/O; a retry reconciles an attempted update and never sends it twice. */
	private async promote(c: RepositoryController, cmd: Command, grant: ConnectionGrant, op: string, fingerprint: string) {
		const state = c.state,
			repo = state.repository;
		let promotion = state.promotions.find((p) => p.operation?.id === op);
		await correlate({ promotionId: promotion?.id ?? `${op.slice(0, 24)}-promotion` });
		if (
			promotion &&
			((promotion.operation!.fingerprint !== fingerprint && promotion.operation!.fingerprint !== stable(cmd)) ||
				promotion.proposalId !== cmd.proposalId)
		)
			throw new DomainError(409, "Operation identity reused");
		const p = c.proposal(cmd.proposalId);
		await correlate({ workspaceId: p.workspaceId, revision: p.revision });
		if (promotion?.state === "failed") throw new DomainError(409, "Promotion failed; reconcile source and obtain fresh review");
		if (promotion?.state !== "complete") {
			if (state.promotions.some((other) => other !== promotion && ["prepared", "uncertain"].includes(other.state)))
				throw new DomainError(409, "Reconcile the pending promotion before another canonical update");
			const ready = c.readiness(p, promotion);
			if (!ready.ready)
				throw new DomainError(
					409,
					ready.reasons.find((reason) => PUBLIC_ERRORS[409].includes(reason)) ??
						"Promotion is blocked; inspect the change readiness checklist",
				);
		}
		const reservation = await this.namespace.reserve(grant, repo.id, cmd.idempotencyKey!, stable(cmd), "revision.publish", cmd.workspaceId);
		await correlate({ reservationId: reservation.id });
		diagnose("resource_reserved", { action: "revision.publish", phase: reservation.state });
		this.maintenanceNeeded = true;
		// Completion and the receipt are durable before settlement. Lost settlement is retried
		// under current authority without fetching or pushing canonical again.
		if (promotion?.state === "complete") {
			diagnose("operation_replayed", { phase: "complete" });
			await this.namespace.settle(reservation.id, "complete");
			diagnose("resource_settled", { action: "revision.publish", phase: "complete" });
			promotion.operation!.settled = true;
			this.save(c);
			return promotion;
		}
		if (!promotion) {
			promotion = {
				id: `${op.slice(0, 24)}-promotion`,
				proposalId: p.id,
				from: p.base,
				to: p.revision,
				actor: grant.actor,
				at: this.now(),
				state: "prepared",
				operation: { id: op, fingerprint, reservationId: reservation.id, phase: "prepared", command: cmd },
			};
			state.promotions.push(promotion);
			p.state = "promoting";
		}
		const operation = promotion.operation!;
		let unexpectedMovement = false;
		try {
			this.save(c);
			diagnose("promotion_phase", { phase: operation.phase });
			await this.git.ensureInit();
			const artifact = c.artifact(p.artifactId);
			if (artifact.kind !== "source" || artifact.revision !== p.revision || artifact.baseRevision !== p.base)
				throw new DomainError(409, "Exact reviewed source unavailable");
			const host = await (await this.resources()).host();
			const retained = await host.info(artifact.storage.repository);
			if (!artifact.storage.providerId || retained.id !== artifact.storage.providerId)
				throw new ProviderIdentityError("Retained source provider identity changed; promotion refused");
			if (!(await this.git.hasCompleteSource(p.revision))) await new SourceInspection(host, state).recover(this.git, p.revision);
			// Validate full retained source, even on retries; local refs cannot prove success.
			await this.git.exportPack(p.revision);
			if ((await this.git.mergeBase(p.base, p.revision)) !== p.base || p.base === p.revision)
				throw new DomainError(409, "Promotion requires a non-forced forward update");
			const name = requireValue(repo.storageName, "Source repository unavailable"),
				info = await host.info(name);
			if (!state.canonical || info.id !== state.canonical.id)
				throw new ProviderIdentityError("Canonical provider identity changed; promotion refused");
			const remoteRef = `refs/heads/${repo.defaultBranch}`;
			const remoteHead = async () =>
				(
					await host.withToken(
						name,
						"read",
						async (token) => (await this.git.remoteRefs({ url: info.remote, token })).find((ref) => ref.ref === remoteRef)?.oid,
					)
				).result;
			if (operation.phase === "prepared") {
				if ((await remoteHead()) !== promotion.from)
					throw new DomainError(409, "Canonical moved; reconcile source and obtain fresh review");
				const localRef = `refs/cruce/promotion/${op}`;
				await this.git.setRef(localRef, promotion.to);
				await host.withToken(name, "write", async (token) => {
					await this.git.push({
						url: info.remote,
						token,
						localRef,
						remoteRef,
						expected: {
							old: promotion!.from,
							next: promotion!.to,
							beforeUpdate: async () => {
								humanMaintain(await this.namespace.authority(grant, repo.id));
								operation.phase = "attempted";
								this.save(c);
								diagnose("promotion_phase", { phase: "attempted" });
							},
						},
					});
					// Record the acknowledged update before token cleanup can fail.
					operation.phase = "confirmed";
					this.save(c);
					diagnose("promotion_phase", { phase: "confirmed" });
				});
			}
			// Independent provider observation, including interrupted-response reconciliation.
			// Only the exact candidate can satisfy this attempted operation, never descendants.
			if ((await remoteHead()) !== promotion.to) {
				unexpectedMovement = true;
				throw new DomainError(409, "Promotion outcome differs from the exact candidate; reconcile source and obtain fresh review");
			}
			humanMaintain(await this.namespace.authority(grant, repo.id));
			operation.phase = "confirmed";
			promotion.state = "complete";
			state.sourceHead = promotion.to;
			if (state.observedCanonical)
				state.observedCanonical = {
					...state.observedCanonical,
					revision: promotion.to,
					deleted: false,
					checkedAt: this.now(),
					generation: state.observedCanonical.generation + 1,
				};
			p.state = "promoted";
			c.event(promotion.actor, "source_promoted", p.title, [p.id, p.revision, promotion.id]);
			state.receipts[op] = { fingerprint, result: promotion };
			this.save(c);
			diagnose("promotion_phase", { phase: "complete" });
		} catch (error) {
			// Reload: a failed persistence call must not leave an in-memory completion
			// capable of overwriting the durable journal on error handling.
			const durable = this.state();
			const pending = durable.promotions.find((item) => item.id === promotion!.id);
			if (pending && pending.state !== "complete") {
				pending.state =
					unexpectedMovement ||
					error instanceof GitUpdateRejected ||
					(error instanceof DomainError && !(error instanceof ProviderIdentityError) && error.status === 409)
						? "failed"
						: "uncertain";
				if (pending.state === "failed") durable.proposals.find((item) => item.id === p.id)!.state = "rejected";
				this.save(new RepositoryController(durable, this.now(), () => "recovery"));
				diagnose("promotion_phase", { phase: pending.state });
			}
			await this.namespace.settle(reservation.id, "uncertain");
			diagnose("resource_settled", { action: "revision.publish", phase: "uncertain" });
			throw error;
		}
		await this.namespace.settle(reservation.id, "complete");
		diagnose("resource_settled", { action: "revision.publish", phase: "complete" });
		operation.settled = true;
		this.save(c);
		return promotion;
	}

	exportSource(revision: string, grant: ConnectionGrant) {
		return this.serial.run(() =>
			withDiagnostics({ tool: "export_source", revision }, async () => {
				try {
					const state = this.state();
					await correlate({ namespaceId: state.repository.namespaceId, repositoryId: state.repository.id });
					diagnose("operation_started");
					await this.namespace.authority(grant, state.repository.id);
					if (this.retiring()) throw new DomainError(409, "Repository is read-only");
					await this.known(new RepositoryController(state, this.now(), () => "read"), revision);
					const pack = await this.git.exportPack(revision);
					diagnose("operation_completed");
					return pack;
				} catch (error) {
					diagnoseError("operation_failed", error);
					throw error;
				} finally {
					this.git.clearCache();
				}
			}),
		);
	}
}
