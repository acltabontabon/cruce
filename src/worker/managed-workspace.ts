import { buildIndex } from "../intelligence/structural-index.ts";
import type { ManagedWorkspaceRecord } from "../shared/coordination.ts";
import type { ArtifactsHost } from "./artifacts-host.ts";
import type { GitWorkspace } from "./git/workspace.ts";

export interface ManagedWorkspace {
	provision(workstreamId: string, baseline: string): Promise<ManagedWorkspaceRecord>;
	fetch(record: ManagedWorkspaceRecord): Promise<string>;
	diff(record: ManagedWorkspaceRecord, head: string): ReturnType<GitWorkspace["changes"]>;
	snapshot(record: ManagedWorkspaceRecord): Promise<ManagedWorkspaceRecord>;
	validate(
		record: ManagedWorkspaceRecord,
		head: string,
	): Promise<{
		base: string;
		head: string;
		changes: Awaited<ReturnType<GitWorkspace["changes"]>>["files"];
		index: ReturnType<typeof buildIndex>;
		headIndex: ReturnType<typeof buildIndex>;
		limitations: string[];
	}>;
	publish(record: ManagedWorkspaceRecord, head: string): Promise<ManagedWorkspaceRecord>;
	archive(record: ManagedWorkspaceRecord): Promise<ManagedWorkspaceRecord>;
}
/** First-class managed backend. The upstream mirror is derivative and never receives canonical merges. */
export class CloudflareArtifactWorkspace implements ManagedWorkspace {
	constructor(
		readonly host: ArtifactsHost,
		readonly git: GitWorkspace,
		readonly domainName: string,
		readonly now: () => number = Date.now,
	) {}
	private ref(id: string) {
		return `refs/cruce/workspaces/${id}`;
	}
	async provision(id: string, baseline: string) {
		// Immutable baseline mirrors avoid racing an upstream update while a fork is being created.
		const mirrorName = `${this.domainName}-baseline-${baseline.slice(0, 16)}`;
		const mirror = await this.host.ensure(mirrorName, `Cruce baseline snapshot ${baseline}`);
		await this.git.setRef(this.ref(`baseline-${baseline}`), baseline);
		const info = await this.host.info(mirror.name);
		if (info.description !== `Cruce baseline snapshot ${baseline}`) throw new Error("Managed mirror ownership mismatch");
		if (mirror.created || !(await this.host.log(mirror.name, "main", 1)).length)
			await this.host.withToken(mirror.name, "write", (token) =>
				this.git.push({ url: mirror.remote, token, localRef: this.ref(`baseline-${baseline}`), remoteRef: "refs/heads/main" }),
			);
		const fork = await this.host.fork(
			mirror.name,
			`${this.domainName}--${id.toLowerCase()}`,
			`Cruce workstream ${id} baseline ${baseline}`,
		);
		await this.git.setRef(this.ref(id), baseline);
		return {
			workstreamId: id,
			backend: "cloudflare_artifacts" as const,
			repository: fork.name,
			remote: fork.remote,
			baseline,
			head: baseline,
			state: "active" as const,
			createdAt: this.now(),
			owned: true,
		};
	}
	async fetch(r: ManagedWorkspaceRecord) {
		const { result } = await this.host.withToken(r.repository, "read", (token) =>
			this.git.fetch({ url: r.remote, token, localRef: this.ref(r.workstreamId) }),
		);
		if (!result) throw new Error("Managed workspace head unavailable");
		return result;
	}
	diff(r: ManagedWorkspaceRecord, head: string) {
		return this.git.changes(r.baseline, head);
	}
	async snapshot(r: ManagedWorkspaceRecord) {
		return { ...r, head: await this.fetch(r) };
	}
	async validate(r: ManagedWorkspaceRecord, head: string) {
		if ((await this.git.mergeBase(r.baseline, head)) !== r.baseline)
			throw new Error("Managed publication must preserve its original baseline history");
		const changes = (await this.diff(r, head)).files,
			index = buildIndex(await this.git.readFiles(r.baseline), r.baseline),
			headIndex = buildIndex(await this.git.readFiles(head), head);
		return {
			base: r.baseline,
			head,
			changes,
			index,
			headIndex,
			limitations: [...index.files, ...headIndex.files]
				.filter((f) => f.limitation && changes.some((c) => c.path === f.path))
				.map((f) => `${f.path}: ${f.limitation}`),
		};
	}
	private async owned(r: ManagedWorkspaceRecord) {
		if (!r.owned || r.repository !== `${this.domainName}--${r.workstreamId.toLowerCase()}`)
			throw new Error("Cleanup limited to Cruce-owned workstream repositories");
		const info = await this.host.find(r.repository);
		if (info && (info.description !== `Cruce workstream ${r.workstreamId} baseline ${r.baseline}` || info.remote !== r.remote))
			throw new Error("Managed workspace ownership mismatch");
	}
	async publish(r: ManagedWorkspaceRecord, head: string) {
		await this.owned(r);
		await this.validate(r, head);
		if ((await this.fetch(r)) !== r.head) throw new Error("Managed workspace head changed; refresh before publishing");
		if (!r.owned || ["archived", "expired"].includes(r.state)) throw new Error("Managed workspace is closed");
		await this.git.setRef(this.ref(r.workstreamId), head);
		await this.host.withToken(r.repository, "write", (token) =>
			this.git.push({ url: r.remote, token, localRef: this.ref(r.workstreamId), remoteRef: "refs/heads/main", force: false }),
		);
		return { ...r, head, state: "published" as const };
	}
	async archive(r: ManagedWorkspaceRecord) {
		await this.owned(r);
		if (r.state === "archived") return r;
		if (!(await this.host.find(r.repository))) return { ...r, state: "archived" as const, archivedAt: this.now() };
		await this.host.revokeAll(r.repository);
		await this.host.delete(r.repository);
		return { ...r, state: "archived" as const, archivedAt: this.now() };
	}
}
