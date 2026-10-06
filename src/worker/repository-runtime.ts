import { humanMaintain, writeAccess } from "../core/capabilities.ts";
import { DomainError, requireValue, stable } from "../core/errors.ts";
import { initialRepository, RepositoryController } from "../core/platform.ts";
import { gitRemotePath, parseGitRoute } from "../shared/git-access.ts";
import type { Artifact, Command, Repository, RepositoryState, ResourceAction, WorkspaceUpdateDetails } from "../shared/platform.ts";
import { authorizeMachine, HUMAN_TOOLS, toolByName } from "../shared/tools.ts";
import { boundedBody, type RepositoryHost, ResourceBoundary, type StorageEnv } from "./artifacts.ts";
import { GitUpdateRejected, type GitWorkspace } from "./git/workspace.ts";
import type { ConnectionGrant, NamespaceRuntime } from "./namespace-runtime.ts";
import { ProviderIdentity, ProviderIdentityError } from "./provider-identity.ts";
import { hash, Serial, type Store } from "./store.ts";

type NamespacePort = {
	[K in "authority" | "repository" | "reserve" | "settle" | "resourceConfiguration"]: (
		...args: Parameters<NamespaceRuntime[K]>
	) => ReturnType<NamespaceRuntime[K]> | Promise<ReturnType<NamespaceRuntime[K]>>;
};
export class RepositoryRuntime {
	private serial = new Serial();
	constructor(
		readonly store: Store,
		readonly git: GitWorkspace,
		readonly namespace: NamespacePort,
		readonly env: StorageEnv,
		readonly now = Date.now,
	) {}
	initialize(repository: Repository) {
		const state = this.store.get<RepositoryState>("repository") ?? initialRepository(repository);
		if (state.repository.id !== repository.id) throw new DomainError(403, "Repository mismatch");
		state.repository = repository;
		this.store.put("repository", state);
	}
	state() {
		return requireValue(this.store.get<RepositoryState>("repository"), "Repository not initialized");
	}
	save(c: RepositoryController) {
		this.store.put("repository", c.state);
	}
	private async resources() {
		const config = await this.namespace.resourceConfiguration();
		const local: Store = {
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
	private async gate(grant: ConnectionGrant, cmd: Command, action: ResourceAction, run: (host: RepositoryHost) => Promise<unknown>) {
		const r = await this.namespace.reserve(
			grant,
			requireValue(cmd.repositoryId, "Repository required"),
			requireValue(cmd.idempotencyKey, "Operation identity required"),
			stable(cmd),
			action,
			cmd.workspaceId,
		);
		try {
			const result = await run(await (await this.resources()).host());
			await this.namespace.settle(
				r.id,
				action === "workspace.cleanup" && (result as { state?: string }).state === "deleting" ? "uncertain" : "complete",
			);
			return result;
		} catch (error) {
			await this.namespace.settle(r.id, "uncertain");
			throw error;
		}
	}
	private async known(c: RepositoryController, revision: string) {
		const tips = [
			...new Set([
				...(c.state.sourceHead ? [c.state.sourceHead] : []),
				...c.state.artifacts.filter((a) => a.kind === "source").map((a) => a.revision),
			]),
		];
		if (tips.includes(revision)) return;
		if ((await this.git.log(revision, 1)).length) {
			for (const tip of tips) if ((await this.git.mergeBase(revision, tip)) === revision) return;
		}
		throw new DomainError(404, "Source unavailable; publish committed source first");
	}
	/** Standard Git transport; authorization is repeated for both advertisement and RPC. */
	gitRequest(request: Request, grant: ConnectionGrant): Promise<Response> {
		return this.serial.run(async () => {
			const route = requireValue(parseGitRoute(new URL(request.url)), "Unsupported Git route");
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
			const forward = () => new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
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
		});
	}

	command(cmd: Command, grant: ConnectionGrant): Promise<unknown> {
		return this.serial.run(async () => {
			const repoId = requireValue(cmd.repositoryId, "Repository required"),
				a = await this.namespace.authority(grant, repoId);
			authorizeMachine(a, cmd);
			const state = structuredClone(this.state());
			state.repository = await this.namespace.repository(grant, repoId);
			if (cmd.tool === "retry_repository_setup") {
				// Replay the original provisioning intent so a failed creation reuses its operation identity
				// and charged reservation. Repositories created before intent was recorded use a stable key.
				humanMaintain(a);
				if (state.canonical) throw new DomainError(409, "Canonical repository is already set up");
				cmd = this.store.get<Command>("provision-command") ?? {
					tool: "provision_repository",
					namespaceId: state.repository.namespaceId,
					repositoryId: repoId,
					idempotencyKey: `provision-${repoId}`,
				};
			}
			const op = cmd.idempotencyKey ? await hash(`${a.actor.id}:${cmd.idempotencyKey}`) : "read";
			let sequence = 0;
			const c = new RepositoryController(state, this.now(), () => `${op.slice(0, 24)}-${sequence++}`);
			const mutation = HUMAN_TOOLS.has(cmd.tool) || toolByName(cmd.tool)?.mutation || cmd.tool === "provision_repository";
			if (mutation && !cmd.idempotencyKey) throw new DomainError(400, "Mutation requires an idempotency key");
			if (a.actor.kind === "human" && a.actor.connectionId) {
				const bound = this.store.get<string>(`human-workspace:${a.actor.connectionId}`);
				if (bound && cmd.tool === "start_workspace" && !state.receipts[op])
					throw new DomainError(409, "Terminal authorization is bound to an existing workspace");
				if (bound && cmd.workspaceId && bound !== cmd.workspaceId) throw new DomainError(403, "Terminal workspace scope denied");
			}
			const fingerprint = stable(cmd),
				receipt = state.receipts[op];
			if (cmd.tool === "promote_proposal") {
				humanMaintain(a);
				if (receipt && receipt.fingerprint !== fingerprint) throw new DomainError(409, "Operation identity reused");
				return this.promote(c, cmd, grant, op, fingerprint);
			}
			if (mutation && receipt) {
				if (receipt.fingerprint !== fingerprint) throw new DomainError(409, "Operation identity reused");
				return receipt.result;
			}
			if (mutation) await this.git.ensureInit();
			let result: unknown;
			const repo = state.repository;
			if (cmd.tool === "provision_repository") {
				humanMaintain(a);
				if (!this.store.get("provision-command")) this.store.put("provision-command", cmd);
				result = await this.gate(grant, cmd, "repository.create", async (host) => {
					const name = requireValue(repo.storageName, "Source storage missing"),
						info = await host.ensure(name, `Cruce repository ${repo.id}`, repo.defaultBranch);
					const fetched = await host.withToken(name, "read", (token) =>
						this.git.fetch({ url: info.remote, token, remoteBranch: repo.defaultBranch, localRef: "refs/cruce/source" }),
					);
					let head = fetched.result;
					if (!head) {
						head =
							this.store.get<string>("initial-revision") ??
							(await this.git.commit({
								ref: "refs/cruce/source",
								parent: null,
								files: { "README.md": `# ${repo.name}\n` },
								message: "Initialize repository",
								author: { name: a.actor.name, email: "cruce@localhost", timestamp: Math.floor(repo.createdAt / 1000) },
							}));
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
				let available = false;
				let comparison: WorkspaceUpdateDetails["comparison"] = "unavailable";
				let files: import("../shared/platform.ts").WorkspaceChange[] = [];
				try {
					await this.known(c, requireValue(updates.revision, "Upstream unavailable"));
					available = true;
					await this.known(c, updates.baselineRevision);
					files = (await this.git.reviewChanges(updates.baselineRevision, updates.revision!)).files.map(({ path, status, binary }) => ({
						path,
						status,
						binary,
					}));
					await this.known(c, s.headRevision);
					const common = await this.git.mergeBase(s.headRevision, updates.revision!);
					comparison =
						s.headRevision === updates.revision
							? "current"
							: common === updates.revision
								? "ahead"
								: common === s.headRevision
									? "behind"
									: common
										? "diverged"
										: "unrelated";
				} catch (error) {
					if (!(error instanceof DomainError)) throw error;
				}
				const touched = new Set(s.changes.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]));
				result = {
					...updates,
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
					await this.known(c, s.baseRevision);
					await this.gate(grant, cmd, "workspace.fork", async (host) => {
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
					});
				}
			} else if (cmd.tool === "cleanup_workspace") {
				const workspace = c.workspace(cmd.workspaceId);
				writeAccess(a);
				if (a.actor.kind === "agent" && workspace.ownerId !== a.actor.userId)
					throw new DomainError(403, "Workspace belongs to another user");
				if (a.actor.kind === "human") humanMaintain(a);
				const ready = c.forkCleanup(workspace);
				if (!ready.ready) throw new DomainError(409, ready.reasons.join("; "));
				result = await this.gate(grant, cmd, "workspace.cleanup", async (host) => {
					const fork = workspace.fork!;
					if (fork.state === "ready") {
						const info = await host.info(fork.name);
						if (info.id !== fork.id) throw new DomainError(409, "Fork identity changed; cleanup refused");
						const { result: refs } = await host.withToken(fork.name, "read", (token) => this.git.remoteRefs({ url: info.remote, token }));
						for (const ref of refs) {
							if (ref.ref.endsWith("^{}")) continue;
							// Annotated tags and non-commit refs are conservatively retained until removed explicitly with Git.
							try {
								await this.known(c, ref.oid);
							} catch {
								throw new DomainError(409, `Unretained fork ref ${ref.ref}; publish its commit before cleanup`);
							}
						}
						fork.state = "deleting";
						this.save(c);
					}
					if (await host.remove(fork.name, fork.id)) {
						fork.state = "deleted";
						c.event(a.actor, "fork_deleted", `Removed fork for ${workspace.title}`, [workspace.id]);
					} else c.event(a.actor, "fork_deleting", `Fork deletion requested for ${workspace.title}`, [workspace.id]);
					return { workspaceId: workspace.id, state: fork.state };
				});
			} else if (cmd.tool === "publish_revision" || cmd.tool === "publish_artifact") {
				// Publication reads the pushed fork, so any authorized connection of the owner may publish.
				const s = c.owned(a, cmd.workspaceId),
					revision = requireValue(cmd.revision, "Revision required");
				result = await this.gate(grant, cmd, cmd.tool === "publish_revision" ? "revision.publish" : "artifact.publish", async (host) => {
					const artifactId = `${op.slice(0, 24)}-artifact`;
					let storage: Artifact["storage"], contentHash: string, baseRevision: string | undefined;
					if (cmd.tool === "publish_revision") {
						const fork = requireValue(s.fork, "Attach a hosted fork first");
						if (fork.state !== "ready") throw new DomainError(409, "Fork unavailable");
						const forkInfo = await host.info(fork.name);
						if (forkInfo.id !== fork.id) throw new DomainError(409, "Fork identity changed; publication refused");
						const storageName = `repo-${repo.id}-artifacts`;
						const retainedId = new ProviderIdentity(this.store).expected(storageName);
						if (retainedId && (await host.info(storageName)).id !== retainedId)
							throw new ProviderIdentityError("Retained source provider identity changed; publication refused");
						if (this.store.get<string>(`publication-revision:${op}`) !== revision) {
							const { result: pushed } = await host.withToken(fork.name, "read", (token) =>
								this.git.fetch({
									url: forkInfo.remote,
									token,
									remoteBranch: requireValue(cmd.ref, "Pushed fork branch required"),
									localRef: `refs/cruce/checkpoint/${s.id}`,
								}),
							);
							if (pushed !== revision) throw new DomainError(409, "Fork ref moved; publish its exact current revision");
						}
						if (
							!(await this.git.log(revision, 1)).length ||
							(await this.git.mergeBase(s.publishedRevision ?? s.baseRevision, revision)) !== (s.publishedRevision ?? s.baseRevision)
						)
							throw new DomainError(409, "Published commits must descend from the workspace baseline and previous publication");
						const upstream = c.upstream();
						const pinnedBase = this.store.get<string>(`publication-base:${op}`);
						baseRevision =
							pinnedBase ??
							cmd.baseRevision ??
							(upstream && (await this.git.log(upstream, 1)).length && (await this.git.mergeBase(upstream, revision)) === upstream
								? upstream
								: (s.integratedRevision ?? s.baseRevision));
						if (!pinnedBase && baseRevision !== s.baseRevision && baseRevision !== s.integratedRevision && baseRevision !== upstream)
							throw new DomainError(409, "Review base must name the workspace baseline or observed upstream revision");
						if (!(await this.git.log(baseRevision, 1)).length)
							throw new DomainError(409, "Review base objects unavailable; fetch upstream first");
						if (
							(await this.git.mergeBase(s.baseRevision, baseRevision)) !== s.baseRevision ||
							(await this.git.mergeBase(baseRevision, revision)) !== baseRevision
						)
							throw new DomainError(409, "Integrate the review base with Git before publishing");
						const diff = await this.git.reviewChanges(baseRevision, revision);
						if (
							a.repositoryRole !== "maintain" &&
							diff.files.some((f) => repo.policy.protectedPaths.some((p) => f.path === p || f.path.startsWith(`${p}/`)))
						)
							throw new DomainError(403, "Protected paths require a repository maintainer");
						this.store.put(`publication-base:${op}`, baseRevision);
						this.store.put(`publication-revision:${op}`, revision);
						const info = await host.ensure(storageName, `Cruce source artifacts ${repo.id}`, repo.defaultBranch);
						const ref = `refs/heads/artifact-${artifactId}`;
						await this.git.setRef(ref, revision);
						await host.withToken(storageName, "write", (token) =>
							this.git.push({ url: info.remote, token, localRef: ref, remoteRef: ref }),
						);
						storage = { repository: storageName, providerId: info.id, revision, ref };
						contentHash = Array.from(
							new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(await this.git.exportPack(revision)))),
							(b) => b.toString(16).padStart(2, "0"),
						).join("");
						s.changes = diff.files.map(({ path, status, binary }) => ({ path, status, binary }));
						s.commits = [];
						for (const commit of await this.git.log(revision, 1000)) {
							if (commit.oid === baseRevision) break;
							s.commits.push(commit.oid);
						}
						s.publishedRevision = revision;
						s.headRevision = revision;
						s.integratedRevision = baseRevision;
					} else {
						if (
							revision !== s.baseRevision &&
							!state.artifacts.some((a) => a.kind === "source" && a.workspaceId === s.id && a.revision === revision)
						)
							throw new DomainError(409, "Evidence must name the base or a published workspace revision");
						const content = requireValue(cmd.content, "Artifact content required"),
							path = `artifacts/${artifactId}.txt`,
							name = `repo-${repo.id}-evidence`,
							info = await host.ensure(name, `Cruce evidence ${repo.id}`);
						const key = `artifact-commit:${op}`;
						const oid =
							this.store.get<string>(key) ??
							(await this.git.commit({
								ref: `refs/cruce/evidence/${artifactId}`,
								parent: null,
								files: { [path]: content },
								message: `Evidence for ${revision}`,
								author: { name: a.actor.name, email: "cruce@localhost", timestamp: Math.floor(this.now() / 1000) },
							}));
						this.store.put(key, oid);
						await this.git.setRef(`refs/cruce/evidence/${artifactId}`, oid);
						await host.withToken(name, "write", (token) =>
							this.git.push({
								url: info.remote,
								token,
								localRef: `refs/cruce/evidence/${artifactId}`,
								remoteRef: `refs/heads/artifact-${artifactId}`,
							}),
						);
						storage = { repository: name, providerId: info.id, path, revision: oid, ref: `refs/heads/artifact-${artifactId}` };
						contentHash = await hash(content);
					}
					return c.addArtifact({
						id: artifactId,
						namespaceId: repo.namespaceId,
						repositoryId: repo.id,
						workspaceId: s.id,
						actor: a.actor,
						revision,
						baseRevision,
						kind: cmd.tool === "publish_revision" ? "source" : "evidence",
						title: cmd.title ?? s.title,
						contentHash,
						trust: "reported",
						storage,
						at: this.now(),
					});
				});
			} else result = c.command(cmd, a);
			if (mutation) {
				if (cmd.tool === "start_workspace" && a.actor.kind === "human" && a.actor.connectionId)
					this.store.put(`human-workspace:${a.actor.connectionId}`, (result as { id: string }).id);
				if (cmd.tool !== "cleanup_workspace" || (result as { state: string }).state === "deleted")
					state.receipts[op] = { fingerprint, result };
				this.save(c);
			}
			return result;
		});
	}
	/** Journal before I/O; a retry reconciles an attempted update and never sends it twice. */
	private async promote(c: RepositoryController, cmd: Command, grant: ConnectionGrant, op: string, fingerprint: string) {
		const state = c.state,
			repo = state.repository;
		let promotion = state.promotions.find((p) => p.operation?.id === op);
		if (promotion && (promotion.operation!.fingerprint !== fingerprint || promotion.proposalId !== cmd.proposalId))
			throw new DomainError(409, "Operation identity reused");
		const p = c.proposal(cmd.proposalId);
		if (promotion?.state === "failed") throw new DomainError(409, "Promotion failed; reconcile source and obtain fresh review");
		if (promotion?.state !== "complete") {
			if (state.promotions.some((other) => other !== promotion && ["prepared", "uncertain"].includes(other.state)))
				throw new DomainError(409, "Reconcile the pending promotion before another canonical update");
			const ready = c.readiness(p, promotion);
			if (!ready.ready) throw new DomainError(409, ready.reasons.join("; "));
		}
		const reservation = await this.namespace.reserve(grant, repo.id, cmd.idempotencyKey!, fingerprint, "revision.publish", cmd.workspaceId);
		// Completion and the receipt are durable before settlement. Lost settlement is retried
		// under current authority without fetching or pushing canonical again.
		if (promotion?.state === "complete") {
			await this.namespace.settle(reservation.id, "complete");
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
			await this.git.ensureInit();
			const artifact = c.artifact(p.artifactId);
			if (artifact.kind !== "source" || artifact.revision !== p.revision || artifact.baseRevision !== p.base)
				throw new DomainError(409, "Exact reviewed source unavailable");
			const host = await (await this.resources()).host();
			const retained = await host.info(artifact.storage.repository);
			if (!artifact.storage.providerId || retained.id !== artifact.storage.providerId)
				throw new ProviderIdentityError("Retained source provider identity changed; promotion refused");
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
							},
						},
					});
					// Record the acknowledged update before token cleanup can fail.
					operation.phase = "confirmed";
					this.save(c);
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
			p.state = "promoted";
			c.event(promotion.actor, "source_promoted", p.title, [p.id, p.revision, promotion.id]);
			state.receipts[op] = { fingerprint, result: promotion };
			this.save(c);
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
				this.store.put("repository", durable);
			}
			await this.namespace.settle(reservation.id, "uncertain");
			throw error;
		}
		await this.namespace.settle(reservation.id, "complete");
		operation.settled = true;
		this.save(c);
		return promotion;
	}

	exportSource(revision: string, grant: ConnectionGrant) {
		return this.serial.run(async () => {
			const state = this.state();
			await this.namespace.authority(grant, state.repository.id);
			await this.known(new RepositoryController(state, this.now(), () => "read"), revision);
			return this.git.exportPack(revision);
		});
	}
}
