import { createTwoFilesPatch, diffLines } from "diff";
import git, { Errors, type PromiseFsClient, type TreeEntry } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { changedRanges } from "../../core/line-diff.ts";
import type { ChangesResponse } from "../../shared/api.ts";
import type { ChangedFile } from "../../shared/git.ts";

/**
 * Real Git, inside the control plane. A bare Git workspace repository (no working tree) where Cruce
 * builds commits from trees, computes diffs, runs three-way merges, and attaches notes. Artifacts
 * repositories are remotes of this workspace; tokens are passed per request as an Authorization
 * header and never written to config or URLs.
 */

export interface GitAuthor {
	name: string;
	email: string;
	/** Unix seconds. Fixed timestamps make demo commits reproducible. */
	timestamp: number;
}

export interface MergeOutcome {
	clean: boolean;
	oid?: string;
	mergeBase: string;
	conflicts: string[];
	fastForward: boolean;
	alreadyMerged: boolean;
}

export const NOTES_REF = "refs/notes/cruce";

type Fs = PromiseFsClient;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class GitWorkspace {
	private cache = {};

	clearCache() {
		this.cache = {};
	}

	constructor(
		private readonly fs: Fs,
		private readonly gitdir = "/workspace.git",
	) {}

	private get base() {
		return { fs: this.fs, gitdir: this.gitdir, cache: this.cache };
	}

	async ensureInit() {
		try {
			await this.fs.promises.stat(`${this.gitdir}/HEAD`);
		} catch {
			await git.init({ fs: this.fs, gitdir: this.gitdir, bare: true, defaultBranch: "main" });
		}
	}

	/** Import an exact agent commit pack. No commit is rebuilt and no working tree is touched. */
	async importPack(pack: Uint8Array) {
		if (pack.byteLength < 32 || pack.byteLength > 32 * 1024 * 1024 || new TextDecoder().decode(pack.slice(0, 4)) !== "PACK")
			throw new Error("Invalid or oversized Git pack");
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", pack.slice(0, -20)));
		if (!digest.every((v, i) => v === pack[pack.length - 20 + i])) throw new Error("Git pack checksum mismatch");
		const name = [...digest].map((v) => v.toString(16).padStart(2, "0")).join("");
		await this.fs.promises.mkdir(`${this.gitdir}/objects/pack`, { recursive: true });
		const filepath = `objects/pack/pack-${name}.pack`;
		await this.fs.promises.writeFile(`${this.gitdir}/${filepath}`, pack);
		const result = await git.indexPack({ ...this.base, dir: this.gitdir, filepath });
		this.clearCache();
		return result.oids;
	}

	/** Export immutable source using real Git objects; external hosting is never required. */
	async exportPack(head: string, stop?: string): Promise<Uint8Array> {
		const oids = new Set<string>();
		const tree = async (oid: string) => {
			if (oids.has(oid)) return;
			oids.add(oid);
			for (const e of (await git.readTree({ ...this.base, oid })).tree) {
				if (e.type === "tree") await tree(e.oid);
				else if (e.type === "blob") oids.add(e.oid);
			}
		};
		const commit = async (oid: string) => {
			if (oid === stop || oids.has(oid)) return;
			oids.add(oid);
			const c = await git.readCommit({ ...this.base, oid });
			await tree(c.commit.tree);
			for (const parent of c.commit.parent) await commit(parent);
		};
		await commit(head);
		const result = await git.packObjects({ ...this.base, oids: [...oids] });
		if (!result.packfile || result.packfile.length > 32 * 1024 * 1024) throw new Error("Source export exceeds the 32 MiB transfer limit");
		return result.packfile;
	}

	async resolve(ref: string): Promise<string | null> {
		try {
			return await git.resolveRef({ ...this.base, ref });
		} catch (e) {
			if (e instanceof Errors.NotFoundError) return null;
			throw e;
		}
	}

	async setRef(ref: string, oid: string) {
		await git.writeRef({ ...this.base, ref, value: oid, force: true });
	}

	async deleteRef(ref: string) {
		try {
			await git.deleteRef({ ...this.base, ref });
		} catch {
			// already gone
		}
	}

	/** Commit `files` (path → content, or null to delete) on top of `parent` and point `ref` at it. */
	async commit(input: {
		ref: string;
		parent: string | null;
		files: Record<string, string | null>;
		message: string;
		author: GitAuthor;
		extraParents?: string[];
	}): Promise<string> {
		const baseTree = input.parent ? (await git.readCommit({ ...this.base, oid: input.parent })).commit.tree : null;
		const tree = await this.writeTreeWith(baseTree, input.files);
		const person = { ...input.author, timezoneOffset: 0 };
		const oid = await git.commit({
			...this.base,
			message: input.message,
			author: person,
			committer: person,
			tree,
			parent: [...(input.parent ? [input.parent] : []), ...(input.extraParents ?? [])],
			ref: input.ref,
			noUpdateBranch: false,
		});
		await this.setRef(input.ref, oid);
		return oid;
	}

	private async writeTreeWith(treeOid: string | null, changes: Record<string, string | null>): Promise<string> {
		const entries: TreeEntry[] = treeOid ? (await git.readTree({ ...this.base, oid: treeOid })).tree : [];
		const byName = new Map(entries.map((e) => [e.path, e]));
		const nested = new Map<string, Record<string, string | null>>();
		for (const [path, content] of Object.entries(changes)) {
			const [head, ...rest] = path.split("/");
			if (rest.length) {
				const group = nested.get(head) ?? {};
				group[rest.join("/")] = content;
				nested.set(head, group);
			} else if (content === null) {
				byName.delete(head);
			} else {
				const oid = await git.writeBlob({ ...this.base, blob: encoder.encode(content) });
				byName.set(head, { mode: "100644", path: head, oid, type: "blob" });
			}
		}
		for (const [dir, sub] of nested) {
			const existing = byName.get(dir);
			const childOid = await this.writeTreeWith(existing?.type === "tree" ? existing.oid : null, sub);
			const child = await git.readTree({ ...this.base, oid: childOid });
			if (child.tree.length) byName.set(dir, { mode: "040000", path: dir, oid: childOid, type: "tree" });
			else byName.delete(dir);
		}
		return git.writeTree({ ...this.base, tree: [...byName.values()] });
	}

	/** All text files at a commit (path → content). Optionally filtered. */
	async readFiles(ref: string, filter: (path: string) => boolean = () => true): Promise<Record<string, string>> {
		const oid = await git.resolveRef({ ...this.base, ref }).catch(() => ref);
		const commit = await git.readCommit({ ...this.base, oid });
		const out: Record<string, string> = {};
		const walk = async (treeOid: string, prefix: string) => {
			for (const e of (await git.readTree({ ...this.base, oid: treeOid })).tree) {
				const path = prefix + e.path;
				if (e.type === "tree") await walk(e.oid, `${path}/`);
				else if (e.type === "blob" && filter(path)) out[path] = decoder.decode((await git.readBlob({ ...this.base, oid: e.oid })).blob);
			}
		};
		await walk(commit.commit.tree, "");
		return out;
	}

	/** Files that differ between two commits, with changed line ranges in base coordinates. */
	async changes(baseRef: string, headRef: string): Promise<{ files: ChangedFile[]; base: Record<string, string> }> {
		const [baseOid, headOid] = await Promise.all([this.peel(baseRef), this.peel(headRef)]);
		const [bt, ht] = await Promise.all([this.treeOf(baseOid), this.treeOf(headOid)]);
		const files: ChangedFile[] = [];
		const base: Record<string, string> = {};
		const cmp = async (a: string | null, b: string | null, prefix: string) => {
			if (a === b) return;
			const ae = a ? (await git.readTree({ ...this.base, oid: a })).tree : [];
			const be = b ? (await git.readTree({ ...this.base, oid: b })).tree : [];
			const names = new Set([...ae.map((e) => e.path), ...be.map((e) => e.path)]);
			for (const name of [...names].sort()) {
				const x = ae.find((e) => e.path === name);
				const y = be.find((e) => e.path === name);
				if (x?.oid === y?.oid) continue;
				const path = prefix + name;
				if (x?.type === "tree" || y?.type === "tree") {
					await cmp(x?.type === "tree" ? x.oid : null, y?.type === "tree" ? y.oid : null, `${path}/`);
					continue;
				}
				if (!x && y) files.push({ path, status: "added", ranges: [] });
				else if (x && !y) {
					base[path] = await this.blobText(x.oid);
					files.push({ path, status: "deleted", ranges: [] });
				} else if (x && y) {
					const before = await this.blobText(x.oid);
					base[path] = before;
					files.push({ path, status: "modified", ranges: changedRanges(before, await this.blobText(y.oid)) });
				}
			}
		};
		await cmp(bt, ht, "");
		return { files, base };
	}

	async mergeBase(a: string, b: string): Promise<string | null> {
		const bases = await git.findMergeBase({ ...this.base, oids: [await this.peel(a), await this.peel(b)] });
		return bases[0] ?? null;
	}

	/** Bounded, read-only review data. Never read staging refs or decode binary files as source. */
	async reviewChanges(
		baseRef: string,
		headRef: string,
		requestedPath?: string,
	): Promise<Pick<ChangesResponse, "files" | "additions" | "deletions" | "statsComplete" | "file">> {
		const blobs = async (ref: string) => {
			const result = new Map<string, string>();
			const walk = async (oid: string, prefix = "") => {
				for (const entry of (await git.readTree({ ...this.base, oid })).tree) {
					if (entry.type === "tree") await walk(entry.oid, `${prefix}${entry.path}/`);
					else if (entry.type === "blob") result.set(`${prefix}${entry.path}`, entry.oid);
				}
			};
			await walk(await this.treeOf(await this.peel(ref)));
			return result;
		};
		const [before, after] = await Promise.all([blobs(baseRef), blobs(headRef)]);
		const result: Pick<ChangesResponse, "files" | "additions" | "deletions" | "statsComplete" | "file"> = {
			files: [],
			additions: 0,
			deletions: 0,
			statsComplete: true,
		};
		for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
			const a = before.get(path);
			const b = after.get(path);
			if (a === b) continue;
			const read = async (oid?: string) => (oid ? (await git.readBlob({ ...this.base, oid })).blob : new Uint8Array());
			const [oldBytes, newBytes] = await Promise.all([read(a), read(b)]);
			const binary = oldBytes.includes(0) || newBytes.includes(0);
			const tooLarge = oldBytes.byteLength + newBytes.byteLength > 256_000;
			let additions: number | null = null;
			let deletions: number | null = null;
			let patch: string | null = null;
			let reason: string | undefined;
			if (binary || tooLarge) {
				result.statsComplete = false;
				reason = binary ? "Binary file; source diff unavailable." : "File is too large for an inline diff.";
			} else {
				const oldText = decoder.decode(oldBytes);
				const newText = decoder.decode(newBytes);
				const parts = diffLines(oldText, newText, { timeout: 100 });
				if (!parts) {
					result.statsComplete = false;
					reason = "This diff is too complex to display inline.";
				} else {
					additions = parts.reduce((sum, part) => sum + (part.added ? part.count : 0), 0);
					deletions = parts.reduce((sum, part) => sum + (part.removed ? part.count : 0), 0);
					result.additions += additions;
					result.deletions += deletions;
					if (requestedPath === path) {
						patch =
							createTwoFilesPatch(a ? `a/${path}` : "/dev/null", b ? `b/${path}` : "/dev/null", oldText, newText, undefined, undefined, {
								context: 3,
								timeout: 100,
							}) ?? null;
						if (patch === null) reason = "This diff is too complex to display inline.";
						if (patch && patch.length > 200_000) {
							patch = null;
							reason = "Diff is too large to display inline.";
						}
					}
				}
			}
			result.files.push({ path, status: !a ? "added" : !b ? "deleted" : "modified", additions, deletions, binary, tooLarge });
			if (requestedPath === path) result.file = { path, patch, ...(reason ? { reason } : {}) };
		}
		return result;
	}

	/**
	 * Three-way merge of `theirs` into branch `ours` (non-destructive when `dryRun`).
	 * Conflicts are reported, never auto-resolved: Git is the source of truth for integration.
	 */
	async merge(input: { ours: string; theirs: string; message: string; author: GitAuthor; dryRun?: boolean }): Promise<MergeOutcome> {
		const oursOid = await this.peel(input.ours);
		const theirsOid = await this.peel(input.theirs);
		const mergeBase = (await this.mergeBase(oursOid, theirsOid)) ?? "";
		const temp = "refs/cruce/merge-theirs";
		await this.setRef(temp, theirsOid);
		const person = { ...input.author, timezoneOffset: 0 };
		try {
			const result = await git.merge({
				...this.base,
				ours: input.ours,
				theirs: temp,
				fastForward: false,
				dryRun: input.dryRun,
				noUpdateBranch: input.dryRun,
				abortOnConflict: true,
				message: input.message,
				author: person,
				committer: person,
			});
			return {
				clean: true,
				oid: result.oid,
				mergeBase,
				conflicts: [],
				fastForward: !!result.fastForward,
				alreadyMerged: !!result.alreadyMerged,
			};
		} catch (e) {
			if (e instanceof Errors.MergeConflictError) {
				return { clean: false, mergeBase, conflicts: e.data.filepaths, fastForward: false, alreadyMerged: false };
			}
			if (e instanceof Errors.MergeNotSupportedError) {
				return { clean: false, mergeBase, conflicts: ["(merge not supported for this change)"], fastForward: false, alreadyMerged: false };
			}
			throw e;
		} finally {
			await this.deleteRef(temp);
		}
	}

	async addNote(oid: string, note: unknown, author: GitAuthor) {
		const person = { ...author, timezoneOffset: 0 };
		await git.addNote({
			...this.base,
			ref: NOTES_REF,
			oid,
			note: `${JSON.stringify(note, null, 2)}\n`,
			author: person,
			committer: person,
			force: true,
		});
	}

	async readNote(oid: string): Promise<unknown | null> {
		try {
			const raw = await git.readNote({ ...this.base, ref: NOTES_REF, oid });
			return JSON.parse(decoder.decode(raw));
		} catch {
			return null;
		}
	}

	async log(ref: string, depth = 30) {
		try {
			const entries = await git.log({ ...this.base, ref, depth });
			return entries.map((e) => ({
				oid: e.oid,
				message: e.commit.message.trim(),
				parents: e.commit.parent,
				at: e.commit.author.timestamp,
				author: e.commit.author.name,
			}));
		} catch (e) {
			if (e instanceof Errors.NotFoundError) return [];
			throw e;
		}
	}

	/** Fetch a remote branch over smart HTTP into `localRef`. */
	async fetch(input: { url: string; token: string; remoteBranch?: string; localRef: string; depth?: number }): Promise<string | null> {
		await this.prepareFetch();
		const result = await git.fetch({
			...this.base,
			http,
			remote: "artifacts",
			url: input.url,
			ref: input.remoteBranch ?? "main",
			singleBranch: true,
			tags: false,
			depth: input.depth,
			headers: { Authorization: `Bearer ${input.token}` },
		});
		if (result.fetchHead) await this.setRef(input.localRef, result.fetchHead);
		return result.fetchHead ?? null;
	}

	/** Fetch the notes ref from a remote (best effort; absent notes are fine). */
	async fetchNotes(input: { url: string; token: string }) {
		try {
			await this.prepareFetch();
			const result = await git.fetch({
				...this.base,
				http,
				remote: "artifacts",
				url: input.url,
				ref: NOTES_REF,
				remoteRef: NOTES_REF,
				singleBranch: true,
				tags: false,
				headers: { Authorization: `Bearer ${input.token}` },
			});
			if (result.fetchHead) await this.setRef(NOTES_REF, result.fetchHead);
		} catch {
			// no notes on the remote yet
		}
	}

	private async prepareFetch() {
		// A bare init has no remote refspec. Fetch needs one even when its URL is explicit.
		// Tracking refs stay separate from accepted source, namespace heads and local notes.
		await git.setConfig({ ...this.base, path: "remote.artifacts.fetch", value: "+refs/*:refs/remotes/artifacts/*" });
	}

	async push(input: { url: string; token: string; localRef: string; remoteRef: string; force?: boolean }) {
		const result = await git.push({
			...this.base,
			http,
			url: input.url,
			ref: input.localRef,
			remoteRef: input.remoteRef,
			force: input.force,
			headers: { Authorization: `Bearer ${input.token}` },
		});
		if (!result.ok) throw new Error(`push rejected: ${JSON.stringify(result.refs)}`);
		return result;
	}

	async remoteRefs(input: { url: string; token: string }) {
		return git.listServerRefs({ http, url: input.url, headers: { Authorization: `Bearer ${input.token}` } });
	}

	async deleteRemote(input: { url: string; token: string; remoteRef: string }) {
		await git.push({
			...this.base,
			http,
			url: input.url,
			remoteRef: input.remoteRef,
			delete: true,
			headers: { Authorization: `Bearer ${input.token}` },
		});
	}

	private async peel(ref: string): Promise<string> {
		if (/^[0-9a-f]{40}$/.test(ref)) return ref;
		return git.resolveRef({ ...this.base, ref });
	}

	private async treeOf(oid: string) {
		return (await git.readCommit({ ...this.base, oid })).commit.tree;
	}

	private async blobText(oid: string) {
		return decoder.decode((await git.readBlob({ ...this.base, oid })).blob);
	}
}
