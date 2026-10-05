import { humanMaintain, writeAccess } from "../core/capabilities.ts";
import { DomainError, requireValue, stable } from "../core/errors.ts";
import { initialRepository, RepositoryController } from "../core/platform.ts";
import { buildIndex } from "../intelligence/structural-index.ts";
import type { Artifact, Command, Repository, RepositoryState, ResourceAction } from "../shared/platform.ts";
import { authorizeMachine, HUMAN_TOOLS, toolByName } from "../shared/tools.ts";
import { pushDeployment, type RepositoryHost, ResourceBoundary, runSmokeChecks } from "./deployments.ts";
import type { GitWorkspace } from "./git/workspace.ts";
import { hash, Serial, type Store } from "./store.ts";
import type { ConnectionGrant, WorkspaceRuntime } from "./workspace-runtime.ts";

type WorkspacePort = {
	[K in "authority" | "repository" | "reserve" | "settle" | "resourceConfiguration"]: (
		...args: Parameters<WorkspaceRuntime[K]>
	) => ReturnType<WorkspaceRuntime[K]> | Promise<ReturnType<WorkspaceRuntime[K]>>;
};
export class RepositoryRuntime {
	private serial = new Serial();
	constructor(
		readonly store: Store,
		readonly git: GitWorkspace,
		readonly workspace: WorkspacePort,
		readonly env: { CRUCE_SECRET?: string },
		readonly now = Date.now,
		readonly orchestrate: (id: string) => Promise<void> = async () => {},
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
		const config = await this.workspace.resourceConfiguration();
		const local: Store = {
			get: <T>() => config.account as T,
			put: () => {
				throw new Error("Credentials are owned by the workspace");
			},
			delete: () => {
				throw new Error("Credentials are owned by the workspace");
			},
		};
		return new ResourceBoundary(local, this.env, { namespace: config.namespace });
	}
	private async gate(grant: ConnectionGrant, cmd: Command, action: ResourceAction, run: (host: RepositoryHost) => Promise<unknown>) {
		const r = await this.workspace.reserve(
			grant,
			requireValue(cmd.repositoryId, "Repository required"),
			requireValue(cmd.idempotencyKey, "Operation identity required"),
			stable(cmd),
			action,
			cmd.sessionId,
		);
		try {
			const result = await run(await (await this.resources()).host());
			await this.workspace.settle(r.id, "complete");
			return result;
		} catch (error) {
			await this.workspace.settle(r.id, "uncertain");
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
	command(cmd: Command, grant: ConnectionGrant): Promise<unknown> {
		return this.serial.run(async () => {
			const repoId = requireValue(cmd.repositoryId, "Repository required"),
				a = await this.workspace.authority(grant, repoId);
			authorizeMachine(a, cmd);
			const state = structuredClone(this.state());
			state.repository = await this.workspace.repository(grant, repoId);
			const op = cmd.idempotencyKey ? await hash(`${a.actor.id}:${cmd.idempotencyKey}`) : "read";
			let sequence = 0;
			const c = new RepositoryController(state, this.now(), () => `${op.slice(0, 24)}-${sequence++}`);
			const mutation = HUMAN_TOOLS.has(cmd.tool) || toolByName(cmd.tool)?.mutation || cmd.tool === "provision_repository";
			if (mutation && !cmd.idempotencyKey) throw new DomainError(400, "Mutation requires an idempotency key");
			if (a.actor.kind === "human" && a.actor.connectionId) {
				const bound = this.store.get<string>(`human-session:${a.actor.connectionId}`);
				if (bound && cmd.tool === "start_session" && !state.receipts[op])
					throw new DomainError(409, "Terminal authorization is bound to an existing session");
				if (bound && cmd.sessionId && bound !== cmd.sessionId) throw new DomainError(403, "Terminal session scope denied");
			}
			const fingerprint = stable(cmd),
				receipt = state.receipts[op];
			if (mutation && receipt) {
				if (receipt.fingerprint !== fingerprint) throw new DomainError(409, "Operation identity reused");
				return receipt.result;
			}
			await this.git.ensureInit();
			let result: unknown;
			const repo = state.repository;
			if (cmd.tool === "provision_repository") {
				humanMaintain(a);
				if (repo.source.kind !== "artifacts") throw new DomainError(400, "Local repositories do not need provisioning");
				result = await this.gate(grant, cmd, "repository.create", async (host) => {
					const name = requireValue(repo.source.storageName, "Source storage missing"),
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
					state.sourceHead = head;
					c.event(a.actor, "repository_created", `Created ${repo.name}`, [repo.id, head]);
					return { revision: head, remote: info.remote };
				});
			} else if (cmd.tool === "export_revision") {
				const revision = requireValue(cmd.revision, "Revision required");
				await this.known(c, revision);
				const pack = await this.git.exportPack(revision);
				result = { revision, pack: btoa(Array.from(pack, (b) => String.fromCharCode(b)).join("")) };
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
			} else if (cmd.tool === "get_context") {
				const s = c.session(cmd.sessionId);
				let available = false;
				try {
					await this.known(c, s.baseRevision);
					available = !!(await this.git.log(s.baseRevision, 1)).length;
				} catch (e) {
					if (!(e instanceof DomainError)) throw e;
				}
				result = {
					revision: s.baseRevision,
					available,
					files: available
						? await this.git.readFiles(s.baseRevision, (p) => p === "AGENTS.md" || p.endsWith("/AGENTS.md") || p === "README.md")
						: {},
					structure: available ? buildIndex(await this.git.readFiles(s.baseRevision), s.baseRevision) : null,
					repositoryPolicy: repo.policy,
					workspacePolicy: (await this.workspace.resourceConfiguration()).policy,
					note: available ? undefined : "Instructions unavailable until committed source is published",
				};
			} else if (cmd.tool === "read_artifact") {
				const artifact = c.artifact(cmd.artifactId);
				result = {
					artifact,
					content: artifact.storage.path
						? (await this.git.readFiles(artifact.storage.revision, (p) => p === artifact.storage.path))[artifact.storage.path]
						: undefined,
				};
			} else if (cmd.tool === "attach_session") {
				result = c.command(cmd, a);
				const s = c.session(cmd.sessionId);
				if (repo.source.kind === "artifacts" && s.mode === "write" && !s.execution?.storageName) {
					await this.gate(grant, cmd, "session.fork", async (host) => {
						if (!host.fork) throw new DomainError(503, "Repository forks unavailable");
						const baseline = `repo-${repo.id}-base-${s.baseRevision}`,
							snapshot = await host.ensure(baseline, `Cruce baseline ${repo.id} ${s.baseRevision}`, repo.defaultBranch);
						if (!(await this.git.log(s.baseRevision, 1)).length) throw new DomainError(409, "Refresh hosted source before attaching");
						await this.git.setRef("refs/cruce/baseline", s.baseRevision);
						await host.withToken(baseline, "write", (token) =>
							this.git.push({
								url: snapshot.remote,
								token,
								localRef: "refs/cruce/baseline",
								remoteRef: `refs/heads/${repo.defaultBranch}`,
							}),
						);
						const name = `repo-${repo.id}-session-${s.id}`;
						await host.fork(baseline, name, `Cruce session ${s.id}`);
						s.execution!.storageName = name;
					});
				}
			} else if (cmd.tool === "publish_revision" || cmd.tool === "publish_artifact") {
				const s = c.owned(a, cmd.sessionId),
					revision = requireValue(cmd.revision, "Revision required");
				if (!s.execution) throw new DomainError(409, "Attach an execution context first");
				result = await this.gate(grant, cmd, cmd.tool === "publish_revision" ? "revision.publish" : "artifact.publish", async (host) => {
					const artifactId = `${op.slice(0, 24)}-artifact`;
					let storage: Artifact["storage"], contentHash: string;
					if (cmd.tool === "publish_revision") {
						const bytes = Uint8Array.from(atob(requireValue(cmd.pack, "Git pack required")), (ch) => ch.charCodeAt(0));
						await this.git.importPack(bytes);
						if (
							!(await this.git.log(revision, 1)).length ||
							(await this.git.mergeBase(s.publishedRevision ?? s.baseRevision, revision)) !== (s.publishedRevision ?? s.baseRevision)
						)
							throw new DomainError(409, "Published commits must descend from the session baseline and previous publication");
						const diff = await this.git.reviewChanges(s.baseRevision, revision);
						if (
							a.repositoryRole !== "maintain" &&
							diff.files.some((f) => repo.policy.protectedPaths.some((p) => f.path === p || f.path.startsWith(`${p}/`)))
						)
							throw new DomainError(403, "Protected paths require a repository maintainer");
						const storageName = s.execution?.storageName ?? `repo-${repo.id}-session-${s.id}`;
						const info = await host.ensure(storageName, `Cruce session ${s.id}`, repo.defaultBranch);
						const ref = `refs/heads/artifact-${artifactId}`;
						await this.git.setRef(ref, revision);
						await host.withToken(storageName, "write", (token) =>
							this.git.push({ url: info.remote, token, localRef: ref, remoteRef: ref }),
						);
						storage = { repository: storageName, revision, ref };
						contentHash = await hash(cmd.pack!);
						s.publishedRevision = revision;
						s.headRevision = revision;
					} else {
						if (
							revision !== s.baseRevision &&
							!state.artifacts.some((a) => a.kind === "source" && a.sessionId === s.id && a.revision === revision)
						)
							throw new DomainError(409, "Evidence must name the base or a published session revision");
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
						storage = { repository: name, path, revision: oid, ref: `refs/heads/artifact-${artifactId}` };
						contentHash = await hash(content);
					}
					return c.addArtifact({
						id: artifactId,
						workspaceId: repo.workspaceId,
						repositoryId: repo.id,
						sessionId: s.id,
						actor: a.actor,
						revision,
						kind: cmd.tool === "publish_revision" ? "source" : "evidence",
						title: cmd.title ?? s.title,
						contentHash,
						trust: "reported",
						storage,
						at: this.now(),
					});
				});
			} else if (cmd.tool === "promote_proposal") {
				humanMaintain(a);
				if (repo.source.kind !== "artifacts") throw new DomainError(409, "Merge and push with normal Git, then report the observed ref");
				const p = c.proposal(cmd.proposalId),
					ready = c.readiness(p);
				if (!ready.ready) throw new DomainError(409, ready.reasons.join("; "));
				result = await this.gate(grant, cmd, "revision.publish", async (host) => {
					const name = requireValue(repo.source.storageName, "Source repository unavailable"),
						info = await host.info(name);
					const { result: head } = await host.withToken(name, "read", (token) =>
						this.git.fetch({ url: info.remote, token, remoteBranch: repo.defaultBranch, localRef: "refs/cruce/promotion-current" }),
					);
					if (head !== p.base && head !== p.revision) throw new DomainError(409, "Source advanced; refresh and propose a new revision");
					if (head !== p.revision) {
						await this.git.setRef("refs/cruce/promotion-next", p.revision);
						await host.withToken(name, "write", (token) =>
							this.git.push({
								url: info.remote,
								token,
								localRef: "refs/cruce/promotion-next",
								remoteRef: `refs/heads/${repo.defaultBranch}`,
							}),
						);
					}
					state.sourceHead = p.revision;
					p.state = "promoted";
					const promotion = {
						id: `${op.slice(0, 24)}-promotion`,
						proposalId: p.id,
						from: p.base,
						to: p.revision,
						actor: a.actor,
						at: this.now(),
						state: "complete" as const,
					};
					state.promotions.push(promotion);
					c.event(a.actor, "source_promoted", p.title, [p.id, p.revision]);
					return promotion;
				});
			} else if (cmd.tool === "request_preview" || cmd.tool === "deploy_artifact") {
				if (cmd.tool === "deploy_artifact") humanMaintain(a);
				else writeAccess(a);
				const environment = state.environments.find((e) => e.id === cmd.environmentId);
				if (!environment || (cmd.tool === "request_preview" && environment.kind !== "preview"))
					throw new DomainError(400, "Choose an appropriate configured environment");
				const pendingKey = `deployment:${op}`;
				const existing = this.store.get<string>(pendingKey);
				const d = existing ? c.deployment(existing) : c.prepareDeployment(cmd, a);
				if (d.state === "superseded") throw new DomainError(409, "A newer deployment superseded this operation");
				result = await this.gate(
					grant,
					{ ...cmd, sessionId: d.sessionId },
					environment.kind === "production" ? "production.deploy" : "preview.deploy",
					async (host) => {
						if (!existing) {
							this.store.put(pendingKey, d.id);
							this.save(c);
						}
						await host.ensure(environment.deployRepository, `Cruce deployments ${repo.id}`);
						await pushDeployment(this.git, host, environment.deployRepository, d.revision, d.branch);
						d.state = "building";
						d.updatedAt = this.now();
						this.save(c);
						await this.orchestrate(d.id);
						return d;
					},
				);
			} else result = c.command(cmd, a);
			if (mutation) {
				if (cmd.tool === "start_session" && a.actor.kind === "human" && a.actor.connectionId)
					this.store.put(`human-session:${a.actor.connectionId}`, (result as { id: string }).id);
				state.receipts[op] = { fingerprint, result };
				this.save(c);
			}
			return result;
		});
	}
	exportSource(revision: string, grant: ConnectionGrant) {
		return this.serial.run(async () => {
			const state = this.state();
			await this.workspace.authority(grant, state.repository.id);
			await this.known(new RepositoryController(state, this.now(), () => "read"), revision);
			return this.git.exportPack(revision);
		});
	}
	tick(id: string, expire = false) {
		return this.serial.run(async () => {
			const c = new RepositoryController(this.state(), this.now(), () => crypto.randomUUID()),
				d = c.deployment(id);
			if (!["queued", "building"].includes(d.state)) return d.state;
			if (expire) {
				d.state = "failed";
				d.error = "Build did not finish within the observation window";
				this.save(c);
				return d.state;
			}
			const env = c.state.environments.find((e) => e.id === d.environmentId)!;
			const builds = await (await this.resources()).builds();
			const tag = env.scriptTag ?? (await builds.scriptTag(env.workerName));
			if (!tag) return d.state;
			env.scriptTag = tag;
			const build = await builds.buildFor(tag, d.revision, d.branch);
			if (build) d.buildId = build.build_uuid;
			if (build?.status === "stopped") {
				d.state = build.build_outcome === "success" ? "deployed" : "failed";
				d.url = build.preview_url ?? undefined;
				if (d.state === "deployed") d.runtimeVersion = await builds.runtimeVersion(env.workerName, build.build_uuid);
				if (d.state === "failed") d.error = `Build outcome: ${build.build_outcome ?? "unknown"}`;
				if (d.state === "deployed" && d.url && env.smokeChecks.length) {
					const results = await runSmokeChecks(d.url, env.smokeChecks);
					d.smoke = { ok: results.every((r) => r.ok), at: this.now() };
					c.event(
						{ id: "cruce-runtime", name: "Cruce", kind: "system", userId: "" },
						"smoke_verified",
						d.smoke.ok ? "Runtime smoke checks passed" : "Runtime smoke checks failed",
						[d.id, d.artifactId],
					);
				}
				c.event(d.actor, `deployment_${d.state}`, `${env.name} ${d.state}`, [d.id, d.artifactId]);
			}
			d.updatedAt = this.now();
			this.save(c);
			return d.state;
		});
	}
}
