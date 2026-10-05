import { DurableObject } from "cloudflare:workers";
import type { Command, Repository } from "../shared/platform.ts";
import type { DeploymentParams } from "./deployment-workflow.ts";
import { SqlFs } from "./git/sql-fs.ts";
import { GitWorkspace } from "./git/workspace.ts";
import { RepositoryRuntime } from "./repository-runtime.ts";
import { sqlStore } from "./store.ts";
import type { ConnectionGrant, WorkspaceRuntime } from "./workspace-runtime.ts";

interface Env {
	WORKSPACE: DurableObjectNamespace<WorkspaceRuntime>;
	CRUCE_SECRET?: string;
	DEPLOYMENT_WORKFLOW?: Workflow<DeploymentParams>;
}
export class ControlTower extends DurableObject<Env> {
	private store = sqlStore(this.ctx.storage.sql);
	private runtime?: RepositoryRuntime;
	private open(repository?: Repository) {
		if (repository) this.store.put("metadata", repository);
		const repo = repository ?? this.store.get<Repository>("metadata");
		if (!repo) throw new Error("Repository unavailable");
		if (!this.runtime)
			this.runtime = new RepositoryRuntime(
				this.store,
				new GitWorkspace(new SqlFs(this.ctx.storage.sql), "/repository.git"),
				this.env.WORKSPACE.getByName(repo.workspaceId),
				this.env,
				Date.now,
				async (deploymentId) => {
					if (!this.env.DEPLOYMENT_WORKFLOW) throw new Error("Deployment workflow unavailable");
					await this.env.DEPLOYMENT_WORKFLOW.create({
						id: `${repo.id}-${deploymentId}`,
						params: { repositoryId: repo.id, deploymentId },
					}).catch(async (error) => {
						const existing = await this.env.DEPLOYMENT_WORKFLOW!.get(`${repo.id}-${deploymentId}`);
						if (!existing) throw error;
					});
				},
			);
		this.runtime.initialize(repo);
		return this.runtime;
	}
	command(repository: Repository, cmd: Command, grant: ConnectionGrant) {
		return this.open(repository).command(cmd, grant);
	}
	exportSource(repository: Repository, revision: string, grant: ConnectionGrant) {
		return this.open(repository).exportSource(revision, grant);
	}
	deploymentTick(id: string, expire = false) {
		return this.open().tick(id, expire);
	}
}
