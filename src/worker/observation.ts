import { humanMaintain } from "../core/capabilities.ts";
import { DomainError, stable } from "../core/errors.ts";
import type { Authority, ObservationStatus, RefObservation, RepositoryState, ResourceReservation } from "../shared/platform.ts";
import type { RepositoryHost, StorageEnv } from "./artifacts.ts";
import type { GitWorkspace } from "./git/workspace.ts";
import type { ConnectionGrant } from "./namespace-runtime.ts";
import { ObservationSubscriptions, type SubscriptionPort } from "./observation-subscriptions.ts";
import { hash, type Store } from "./store.ts";

export const OBSERVATION_INTERVAL = 15 * 60_000;
export interface ObservationRoute {
	repositoryId: string;
	namespaceId: string;
	targetId: string;
	generation: number;
}
export interface PushSignal {
	type: "cf.artifacts.repo.pushed";
	source: { type: "artifacts.repo"; namespace: string; repoName: string };
	metadata: { accountId: string; eventSubscriptionId: string; eventSchemaVersion: number };
}
/** Payload source content is deliberately discarded: an event only invalidates a recorded ref. */
export function pushSignal(body: unknown): PushSignal | undefined {
	if (!body || typeof body !== "object") return;
	const b = body as Partial<PushSignal>;
	if (b.type !== "cf.artifacts.repo.pushed" || b.source?.type !== "artifacts.repo" || b.metadata?.eventSchemaVersion !== 1) return;
	if (
		![b.source.namespace, b.source.repoName, b.metadata.accountId, b.metadata.eventSubscriptionId].every(
			(v) => typeof v === "string" && v.length > 0 && v.length <= 256,
		)
	)
		return;
	return {
		type: b.type,
		source: { type: b.source.type, namespace: b.source.namespace, repoName: b.source.repoName },
		metadata: { accountId: b.metadata.accountId, eventSubscriptionId: b.metadata.eventSubscriptionId, eventSchemaVersion: 1 },
	};
}
interface Configuration {
	enabled: boolean;
	generation: number;
	grant: ConnectionGrant;
	cleanupGrant?: ConnectionGrant;
	accountId: string;
	storageNamespace: string;
	queueId: string;
}
interface Target {
	id: string;
	name: string;
	physical: string;
	providerId: string;
	parentId?: string;
	workspaceId?: string;
	ref: string;
	subscription?: string;
	subscriptionName: string;
	generation: number;
	removed?: boolean;
	dirty: boolean;
	nextAttempt: number;
	attempts: number;
	reason?: string;
	backfillReason?: string;
	last?: RefObservation;
	cancelledReservation?: string;
	operation?: { id: string; fingerprint: string; reservationId?: string; confirmed?: boolean; removing: boolean };
}
export interface ObservationPort {
	authority(grant: ConnectionGrant): Promise<Authority>;
	reserve(grant: ConnectionGrant, id: string, fingerprint: string): Promise<ResourceReservation>;
	settle(id: string): Promise<unknown>;
	host(): Promise<RepositoryHost>;
	schedule(at: number): Promise<void>;
	route(subscription: string, route: ObservationRoute): Promise<void>;
	canonical(observation: RefObservation): void;
	subscriptions?(authorize: () => Promise<void>): SubscriptionPort;
}
/** Called only under RepositoryRuntime serialization. Reads never construct state or call a provider. */
export class Observation {
	constructor(
		readonly store: Store,
		readonly env: StorageEnv,
		readonly git: GitWorkspace,
		readonly now: () => number,
		readonly port: ObservationPort,
	) {}
	private targets() {
		const rows: { key: string; value: Target }[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 3; page++) {
			const batch = this.store.scan<Target>("observation-target:", cursor, 100);
			rows.push(...batch);
			if (batch.length < 100) break;
			cursor = batch.at(-1)!.key;
		}
		return rows.map((x) => x.value);
	}
	status(state: RepositoryState): ObservationStatus {
		const config = this.store.get<Configuration>("observation-config"),
			allTargets = this.targets(),
			targets = allTargets.filter((t) => !t.removed || t.operation);
		const enabled = config?.enabled ?? false;
		const checkedTargets = enabled ? targets : allTargets;
		const overdue = targets.some((t) => this.now() - (t.last?.checkedAt ?? t.nextAttempt) > OBSERVATION_INTERVAL);
		const reason = targets.find((t) => t.reason || t.backfillReason);
		const pending = targets.filter((t) => t.dirty || !t.last || t.operation).length;
		return {
			enabled,
			generation: config?.generation ?? 0,
			state: !enabled ? "disabled" : reason || overdue ? "degraded" : pending || !targets.length ? "pending" : "healthy",
			reason: reason?.reason ?? reason?.backfillReason ?? (overdue ? "Observation checks are overdue" : undefined),
			pending,
			lastCheckedAt:
				checkedTargets.length && checkedTargets.every((t) => t.last)
					? Math.min(...checkedTargets.map((t) => t.last!.checkedAt))
					: undefined,
			canonical: state.observedCanonical,
			workspaces: Object.fromEntries(allTargets.filter((t) => t.workspaceId && t.last).map((t) => [t.workspaceId!, t.last!])),
			estimatedDailyOperations: 96 * (1 + state.workspaces.filter((w) => w.fork?.state === "ready").length),
		};
	}
	async configure(state: RepositoryState, grant: ConnectionGrant, enabled: boolean, operationId?: string) {
		humanMaintain(await this.port.authority(grant));
		const previous = this.store.get<Configuration>("observation-config");
		if ((operationId && this.store.get(`observation-configuration:${operationId}`)) || (enabled && previous?.enabled)) {
			await this.sync(state);
			await this.port.schedule(this.now() + 1000);
			return this.status(state);
		}
		if (
			enabled &&
			(!this.env.CF_EVENTS_API_TOKEN ||
				!this.env.CRUCE_OBSERVATION_QUEUE_ID ||
				!this.env.CRUCE_OBSERVATION_QUEUE ||
				!this.env.CRUCE_STORAGE_ACCOUNT_ID)
		)
			throw new DomainError(503, "Observation installation is not configured");
		if (enabled && previous && this.targets().some((t) => t.operation || (!previous.enabled && !t.removed)))
			throw new DomainError(409, "Observation recovery must finish before enabling a new configuration");
		const config: Configuration = enabled
			? {
					enabled,
					generation: (previous?.generation ?? 0) + 1,
					grant,
					accountId: this.env.CRUCE_STORAGE_ACCOUNT_ID!,
					storageNamespace: this.env.CRUCE_ARTIFACTS_NAMESPACE!,
					queueId: this.env.CRUCE_OBSERVATION_QUEUE_ID!,
				}
			: { ...previous!, enabled: false, cleanupGrant: grant };
		if (!previous && !enabled) return this.status(state);
		this.store.batch([
			{ key: "observation-config", value: config },
			...(operationId ? [{ key: `observation-configuration:${operationId}`, value: { enabled, generation: config.generation } }] : []),
		]);
		await this.sync(state);
		await this.port.schedule(this.now() + 1000);
		return this.status(state);
	}
	async sync(state: RepositoryState) {
		const config = this.store.get<Configuration>("observation-config");
		if (!config?.enabled) return;
		const wanted = [
			...(state.canonical ? [{ ...state.canonical, id: "canonical", ref: `refs/heads/${state.repository.defaultBranch}` }] : []),
			...state.workspaces
				.filter((w) => w.fork?.state === "ready")
				.map((w) => ({
					...w.fork!,
					id: w.id,
					providerId: w.fork!.id,
					workspaceId: w.id,
					parentId: state.canonical?.id,
					ref: `refs/heads/${w.branch ?? state.repository.defaultBranch}`,
				})),
		];
		for (const item of wanted) {
			const key = item.id;
			const providerId = "providerId" in item ? item.providerId : state.canonical!.id;
			const old = this.store.get<Target>(`observation-target:${key}`);
			if (old && !old.removed && old.generation === config.generation) {
				if (old.providerId !== providerId) throw new DomainError(409, "Observation provider identity changed");
				if (old.ref !== item.ref && !old.operation)
					this.store.put(`observation-target:${key}`, { ...old, ref: item.ref, dirty: true, nextAttempt: this.now() });
				continue;
			}
			const target: Target = {
				id: key,
				name: item.name,
				physical: `ns-${state.repository.namespaceId}-${item.name}`,
				providerId,
				workspaceId: "workspaceId" in item ? item.workspaceId : undefined,
				parentId: "parentId" in item ? item.parentId : undefined,
				ref: item.ref,
				subscriptionName: `cruce-${await hash(`${state.repository.id}:${providerId}:${config.generation}`)}`,
				generation: config.generation,
				last: old?.providerId === providerId ? old.last : undefined,
				dirty: true,
				attempts: 0,
				nextAttempt: this.now(),
			};
			this.store.put(`observation-target:${key}`, target);
		}
	}
	async ingest(state: RepositoryState, messageId: string, signal: PushSignal, route: ObservationRoute, failed = false) {
		const config = this.store.get<Configuration>("observation-config");
		if (!config?.enabled) return;
		if (
			config.accountId !== signal.metadata.accountId ||
			config.storageNamespace !== signal.source.namespace ||
			route.repositoryId !== state.repository.id ||
			route.namespaceId !== state.repository.namespaceId ||
			route.generation !== config.generation
		)
			return;
		const target = this.store.get<Target>(`observation-target:${route.targetId}`);
		if (
			!target ||
			target.removed ||
			target.subscription !== signal.metadata.eventSubscriptionId ||
			target.physical !== signal.source.repoName
		)
			return;
		const key = `observation-message:${await hash(`${signal.metadata.eventSubscriptionId}:${messageId}`)}`;
		if (!this.store.get(key)) {
			target.dirty = true;
			target.nextAttempt = Math.min(target.nextAttempt, Math.max(this.now() + 1000, (target.last?.checkedAt ?? 0) + 30_000));
			if (failed) target.reason = "Event delivery failed; background reconciliation is pending";
			this.store.batch([
				{ key, value: { at: this.now(), target: target.id } },
				{ key: `observation-target:${target.id}`, value: target },
			]);
		}
		await this.port.schedule(target.nextAttempt);
	}
	async recover(state: RepositoryState) {
		const config = this.store.get<Configuration>("observation-config");
		if (!config) return;
		await this.sync(state);
		const targets = this.targets();
		const wanted = (t: Target) =>
			config.enabled && (!t.workspaceId || state.workspaces.some((w) => w.id === t.workspaceId && w.fork?.state === "ready"));
		const cursor = this.store.get<string>("observation-cursor") ?? "";
		const due = targets
			.filter((t) => (!t.removed || t.operation) && (t.nextAttempt <= this.now() || (!wanted(t) && !t.reason)))
			.sort((a, b) => a.nextAttempt - b.nextAttempt || Number(a.id <= cursor) - Number(b.id <= cursor) || a.id.localeCompare(b.id))
			.slice(0, 4);
		for (const t of due) {
			const key = `observation-target:${t.id}`;
			try {
				if (
					config.accountId !== this.env.CRUCE_STORAGE_ACCOUNT_ID ||
					config.storageNamespace !== this.env.CRUCE_ARTIFACTS_NAMESPACE ||
					config.queueId !== this.env.CRUCE_OBSERVATION_QUEUE_ID
				)
					throw new DomainError(409, "Observation installation identity changed");
				const authorize = async () => {
					const grant = config.enabled ? config.grant : (config.cleanupGrant ?? config.grant);
					humanMaintain(await this.port.authority(grant));
					if (!t.operation) throw new Error("Observation operation missing");
					const r = await this.port.reserve(grant, t.operation.id, t.operation.fingerprint);
					t.operation.reservationId = r.id;
					this.store.put(key, t);
				};
				if (!wanted(t) && t.operation && !t.operation.removing) {
					this.store.put(`observation-cancelled:${t.operation.id}`, t.operation);
					t.cancelledReservation = t.operation.reservationId;
					t.operation = undefined;
					this.store.put(key, t);
				}
				if (!t.operation) {
					const id = `observe-${await hash(`${state.repository.id}:${t.id}:${t.generation}:${this.now()}:${t.last?.checkedAt ?? 0}:${!wanted(t)}`)}`;
					t.operation = {
						id,
						fingerprint: stable({ target: t.id, providerId: t.providerId, ref: t.ref, generation: t.generation, removing: !wanted(t) }),
						removing: !wanted(t),
					};
					this.store.put(key, t);
				}
				await authorize();
				if (!t.operation.confirmed) {
					const subscriptions = this.port.subscriptions?.(authorize) ?? new ObservationSubscriptions(this.env, authorize);
					if (t.operation.removing) {
						await subscriptions.remove(t.subscriptionName, t.physical, t.subscription);
						t.removed = true;
					} else {
						await authorize();
						const host = await this.port.host();
						const info = await host.info(t.name);
						if (info.id !== t.providerId) throw new DomainError(409, "Observation provider identity changed");
						if (t.parentId) {
							if (!host.verifyFork) throw new DomainError(409, "Observation fork parent is unavailable");
							await authorize();
							await host.verifyFork(t.name, t.providerId, t.parentId, state.canonical!.name);
						}
						t.subscription = await subscriptions.ensure(t.subscriptionName, t.physical, t.subscription);
						this.store.put(key, t);
						await this.port.route(t.subscription, {
							repositoryId: state.repository.id,
							namespaceId: state.repository.namespaceId,
							targetId: t.id,
							generation: t.generation,
						});
						await authorize();
						const refs = (await host.withToken(t.name, "read", (token) => this.git.remoteRefs({ url: info.remote, token }))).result;
						if (refs.length > 256 || refs.some((r) => r.ref.length > 256 || !/^[a-f0-9]{40}$/.test(r.oid)))
							throw new DomainError(413, "Observation ref inventory exceeds its limit");
						await authorize(); // Revocation during provider work must not install observations.
						const revision = refs.find((r) => r.ref === t.ref)?.oid;
						t.backfillReason = undefined;
						if (revision) {
							let available = false;
							try {
								await this.git.ancestors(revision);
								available = true;
							} catch {
								/* A ref inspection cannot prove ancestry. */
							}
							if (!available) {
								await authorize();
								try {
									await host.withToken(t.name, "read", (token) =>
										this.git.recover({ url: info.remote, token, ref: t.ref, expected: revision }),
									);
								} catch {
									t.backfillReason = "Current refs checked; ancestry backfill is unavailable or exceeds its bound";
								}
							}
						}
						await authorize();
						const last: RefObservation = {
							providerId: t.providerId,
							ref: t.ref,
							revision,
							deleted: !revision,
							checkedAt: this.now(),
							generation: Math.max(t.last?.generation ?? 0, !t.workspaceId ? (state.observedCanonical?.generation ?? 0) : 0) + 1,
						};
						t.last = last;
						t.operation.confirmed = true;
						t.dirty = false;
						t.reason = undefined;
						this.store.batch([
							{ key: `observation-history:${t.operation.id}`, value: { targetId: t.id, ...last } },
							{ key: `observation-inventory:${t.id}`, value: { checkedAt: last.checkedAt, refs } },
							{ key, value: t },
						]);
					}
					t.operation.confirmed = true;
					t.dirty = false;
					t.reason = undefined;
					this.store.put(key, t);
				}
				if (!t.workspaceId && t.last && !t.operation.removing) this.port.canonical(t.last);
				await this.port.settle(t.operation.reservationId!);
				if (t.cancelledReservation) {
					await this.port.settle(t.cancelledReservation);
					t.cancelledReservation = undefined;
				}
				t.operation = undefined;
				t.attempts = 0;
				t.reason = undefined;
				t.nextAttempt = this.now() + (t.dirty ? 1000 : OBSERVATION_INTERVAL);
				this.store.put(key, t);
			} catch (error) {
				const saved = this.store.get<Target>(key) ?? t;
				saved.attempts++;
				saved.reason =
					error instanceof DomainError && [401, 403].includes(error.status)
						? "Observation needs current maintainer authority, resource policy and budget"
						: error instanceof DomainError && [409, 413].includes(error.status)
							? "Observation needs complete refs and matching installation, subscription and provider identities"
							: "Observation service unavailable; retry is pending";
				saved.nextAttempt = this.now() + Math.min(OBSERVATION_INTERVAL, 30_000 * 2 ** Math.min(saved.attempts - 1, 5));
				this.store.put(key, saved);
			}
			this.store.put("observation-cursor", t.id);
		}
		const remaining = this.targets().filter((t) => !t.removed || t.operation);
		if (remaining.length) await this.port.schedule(Math.max(this.now() + 1000, Math.min(...remaining.map((t) => t.nextAttempt))));
	}
}
