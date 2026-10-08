import { DomainError, requireValue } from "../core/errors.ts";
import type { Command, RepositoryState } from "../shared/platform.ts";
import type { RepositoryHost, SourceReader } from "./artifacts.ts";
import type { GitWorkspace } from "./git/workspace.ts";
import { ProviderIdentityError } from "./provider-identity.ts";

export const SOURCE_LIMITS = { calls: 1024, entries: 5000, fileBytes: 256_000, responseBytes: 1_000_000, history: 30 } as const;
type Location = { repository: string; providerId: string; ref: string; revision: string };

/** One request budget covers repository selection, all-parent ancestry and content inspection. */
export class SourceInspection {
	private calls = 0;
	constructor(
		private readonly host: RepositoryHost,
		private readonly state: RepositoryState,
	) {}
	private async call<T>(run: () => Promise<T>): Promise<T> {
		if (++this.calls > SOURCE_LIMITS.calls)
			throw new DomainError(413, "Source inspection exceeds its provider-call limit; choose an exact published revision");
		const result = await run();
		this.bounded(result);
		return result;
	}
	private bounded(value: unknown) {
		if (new TextEncoder().encode(JSON.stringify(value)).length > SOURCE_LIMITS.responseBytes)
			throw new DomainError(413, "Source inspection exceeds its response limit");
	}
	private async source<T>(location: Location, run: (source: SourceReader) => Promise<T>) {
		if (!this.host.withSource) throw new DomainError(503, "Provider source inspection unavailable");
		return this.call(() => this.host.withSource!(location.repository, location.providerId, run));
	}
	private candidates(): Location[] {
		const retained = this.state.artifacts.filter((a) => a.kind === "source").map((a) => a.storage);
		const canonical =
			this.state.canonical && this.state.sourceHead
				? [
						{
							repository: this.state.canonical.name,
							providerId: this.state.canonical.id,
							ref: `refs/heads/${this.state.repository.defaultBranch}`,
							revision: this.state.sourceHead,
						},
					]
				: [];
		return [...retained, ...canonical].map((s) => ({
			repository: s.repository,
			providerId: requireValue(s.providerId, "Retained storage identity unavailable"),
			ref: requireValue(s.ref, "Retained storage ref unavailable"),
			revision: s.revision,
		}));
	}
	private async commit(source: SourceReader, oid: string) {
		const commit = requireValue(await this.call(() => source.readCommit(oid)), "Retained commit unavailable");
		if (commit.hash !== oid) throw new DomainError(409, "Retained commit differs from the exact revision");
		return commit;
	}
	/** Never use first-parent log to authorize an ancestor, including a merge's second parent. */
	private async ancestor(source: SourceReader, base: string, head: string) {
		const pending = [head],
			seen = new Set<string>();
		while (pending.length) {
			const oid = pending.pop()!;
			if (seen.has(oid)) continue;
			seen.add(oid);
			const commit = await this.commit(source, oid);
			if (oid === base) return true;
			pending.push(...commit.parents);
		}
		return false;
	}
	async locate(revision: string): Promise<Location> {
		const candidates = this.candidates();
		const exact = candidates.filter((s) => s.revision === revision);
		// A moved retained ref proves nothing itself, but never hides proof held by another retained ref.
		let moved: DomainError | undefined;
		for (const location of exact.length ? exact : candidates.reverse()) {
			const found = await this.source(location, async (source) => {
				const tip = await this.call(() => source.log({ ref: location.ref, limit: 1 }));
				if (tip[0]?.hash !== location.revision) {
					moved = new DomainError(409, "Retained source ref differs from the recorded revision");
					return false;
				}
				return this.ancestor(source, revision, location.revision);
			});
			if (found) return location;
		}
		throw moved ?? new DomainError(404, "Source unavailable; publish committed source first");
	}
	private async files(source: SourceReader, revision: string) {
		const root = (await this.commit(source, revision)).treeHash;
		const paths: string[] = [],
			pending = [{ oid: root, prefix: "" }];
		let entries = 0;
		while (pending.length) {
			const { oid, prefix } = pending.pop()!;
			const tree = requireValue(await this.call(() => source.readTree(oid)), "Retained tree unavailable");
			entries += tree.length;
			if (entries > SOURCE_LIMITS.entries) throw new DomainError(413, "Source tree exceeds the inspection limit; request a file path");
			for (const entry of tree) {
				const path = `${prefix}${entry.name}`;
				if (entry.type === "tree") pending.push({ oid: entry.hash, prefix: `${path}/` });
				else if (entry.type !== "gitlink") paths.push(path);
			}
		}
		return paths.sort();
	}
	private async file(source: SourceReader, revision: string, path: string) {
		// Blob bytes have their own bound; they are not JSON metadata.
		if (++this.calls > SOURCE_LIMITS.calls) throw new DomainError(413, "Source inspection exceeds its provider-call limit");
		let blob: Blob | null;
		try {
			blob = await source.readFile({ ref: revision, path });
		} catch (error) {
			if (error instanceof DomainError && error.status === 413)
				return { path, content: null, reason: "File is too large for inline source inspection." };
			throw error;
		}
		if (!blob) throw new DomainError(404, "File unavailable at this exact revision");
		if (blob.size > SOURCE_LIMITS.fileBytes) return { path, content: null, reason: "File is too large for inline source inspection." };
		const bytes = new Uint8Array(await blob.arrayBuffer());
		try {
			if (bytes.includes(0)) throw new Error("binary");
			return { path, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
		} catch {
			return { path, content: null, reason: "Binary file; inline source unavailable." };
		}
	}
	async inspect(cmd: Command, git: GitWorkspace) {
		if (cmd.sourceView === "artifact") {
			const artifact = requireValue(
				this.state.artifacts.find((a) => a.id === cmd.artifactId),
				"Artifact unavailable",
			);
			if (!artifact.storage.path) return { artifact };
			const storage = {
				...artifact.storage,
				ref: requireValue(artifact.storage.ref, "Retained storage ref unavailable"),
				providerId: requireValue(artifact.storage.providerId, "Retained storage identity unavailable"),
			};
			const file = await this.source(storage, async (source) => {
				const tip = await this.call(() => source.log({ ref: storage.ref, limit: 1 }));
				if (tip[0]?.hash !== storage.revision) throw new DomainError(409, "Retained artifact ref differs from the recorded revision");
				return this.file(source, storage.revision, storage.path!);
			});
			return { artifact, content: file.content, reason: file.reason };
		}
		const revision = requireValue(cmd.revision ?? this.state.sourceHead, "Choose a published revision");
		const location = await this.locate(revision);
		if (cmd.sourceView === "diff") {
			const base = requireValue(cmd.baseRevision, "Base required");
			await this.recover(git, revision, location);
			await this.recover(git, base);
			const diff = await git.reviewChanges(base, revision, cmd.path);
			this.bounded(diff);
			return diff;
		}
		const result = await this.source(location, async (source) => {
			if (cmd.sourceView === "history") {
				const commits = await this.call(() => source.log({ ref: revision, limit: SOURCE_LIMITS.history + 1 }));
				if (commits[0]?.hash !== revision) throw new DomainError(404, "Retained history unavailable");
				return {
					revision,
					traversal: "first-parent",
					truncated: commits.length > SOURCE_LIMITS.history,
					commits: commits
						.slice(0, SOURCE_LIMITS.history)
						.map((c) => ({ oid: c.hash, message: c.message, parents: c.parents, at: c.authoredAt, author: c.author.name })),
				};
			}
			return cmd.path
				? { revision, file: await this.file(source, revision, cmd.path) }
				: { revision, paths: await this.files(source, revision) };
		});
		this.bounded(result);
		return result;
	}
	async recover(git: GitWorkspace, revision: string, location?: Location) {
		const retained = location ?? (await this.locate(revision));
		await git.ensureInit();
		if (!(await git.hasCompleteSource(revision))) {
			const info = await this.call(() => this.host.info(retained.repository));
			if (info.id !== retained.providerId) throw new ProviderIdentityError("Retained storage identity changed");
			await this.host.withToken(retained.repository, "read", async (token) => {
				await git.recover({ url: info.remote, token, ref: retained.ref, expected: retained.revision });
			});
		}
		if (!(await git.hasCompleteSource(revision))) throw new DomainError(409, "Retained source graph is incomplete; recovery refused");
		return { revision, recovered: true };
	}
}
