import { ControllerError } from "../core/controller.ts";
import type { ArtifactRef, Flight } from "../core/domain.ts";
import { migratePlanRecords } from "../core/migrate-records.ts";
import type { ChangesResponse } from "../shared/api.ts";
import type { ArtifactsHost } from "./artifacts-host.ts";
import { type GitAuthor, type GitWorkspace, type MergeOutcome, NOTES_REF } from "./git/workspace.ts";

/**
 * Git for one Cruce project.
 *
 * Topology (Artifacts backend):
 *
 *   <repo>                canonical project repository (accepted state)
 *   <repo>--f021 …        one fork per Flight (isolated history, refs, tokens, lifecycle)
 *
 * The control tower keeps a bare workspace with the canonical repo at `refs/heads/main` and each
 * Flight at `refs/heads/flights/<id>`, fetched/pushed with 60-second tokens. Cruce is the only
 * writer: Flights submit changes, Cruce builds the commit, gates it, and pushes it.
 *
 * The `local` backend is the same workspace without remotes (offline demo; no Cloudflare account).
 */

export type GitBackend = "artifacts" | "local";

export const CANONICAL = "refs/heads/main";
export const flightRef = (id: string) => `refs/heads/flights/${id}`;
const stagingRef = (id: string) => `refs/cruce/staging/${id}`;

export const TOWER_AUTHOR = { name: "Cruce Tower", email: "tower@cruce.acltabontabon.com" };

export class ProjectGit {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly remotes = new Map<string, string>();
	readonly backend: GitBackend;

	constructor(
		readonly ws: GitWorkspace,
		readonly repo: string,
		private readonly host?: ArtifactsHost,
	) {
		this.backend = host ? "artifacts" : "local";
	}

	get namespace() {
		return this.host?.namespace ?? "local";
	}

	get artifacts() {
		return this.host;
	}

	/**
	 * Repository epoch: bumped on every demo reset so a Flight repo name is never reused while the
	 * previous repository's deletion is still propagating (Artifacts deletes are eventually consistent).
	 */
	epoch = 0;

	flightRepoName(flightId: string) {
		const base = `${this.repo}--${flightId.toLowerCase().replace("-", "")}`;
		return this.epoch > 0 ? `${base}-r${this.epoch}` : base;
	}

	/** Serialize Git operations on the shared workspace. */
	private run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Ensure the canonical repository exists; seed it with `seed` when empty. Returns its head. */
	ensureCanonical(seed: Record<string, string>, author: GitAuthor, description: string) {
		return this.run(async () => {
			await this.ws.ensureInit();
			if (!this.host) {
				const head = (await this.ws.resolve(CANONICAL)) ?? (await this.seedCommit(seed, author));
				return { head, remote: undefined as string | undefined, created: false };
			}
			const ref = await this.host.ensure(this.repo, description);
			this.remotes.set(ref.name, ref.remote);
			const remoteLog = await this.host.log(this.repo, "main", 1);
			if (!remoteLog.length) {
				const head = (await this.ws.resolve(CANONICAL)) ?? (await this.seedCommit(seed, author));
				await this.pushTo(this.repo, CANONICAL, "refs/heads/main", true);
				return { head, remote: ref.remote, created: true };
			}
			const head = await this.fetchFrom(this.repo, CANONICAL);
			return { head: head ?? remoteLog[0].hash, remote: ref.remote, created: false };
		});
	}

	/** Demo reset: canonical back to the seed; the durable cleanup ledger owns Flight disposal. */
	resetToSeed(seed: Record<string, string>, author: GitAuthor) {
		return this.run(async () => {
			const head = await this.seedCommit(seed, author);
			await this.ws.deleteRef(NOTES_REF);
			if (this.host) {
				await this.pushTo(this.repo, CANONICAL, "refs/heads/main", true);
				await this.deleteRemoteRef(this.repo, NOTES_REF);
			}
			return head;
		});
	}

	syncCanonical() {
		return this.run(async () => (this.host ? await this.fetchFrom(this.repo, CANONICAL) : await this.ws.resolve(CANONICAL)));
	}

	/** Create the Flight's isolated workspace: an Artifacts fork of canonical at its current head. */
	async createFlightWorkspace(flightId: string, description: string, name = this.flightRepoName(flightId)): Promise<ArtifactRef> {
		const head = await this.run(async () => {
			const canonical = await this.ws.resolve(CANONICAL);
			if (!canonical) throw new Error("canonical repository is not initialised");
			await this.ws.setRef(flightRef(flightId), canonical);
			return canonical;
		});
		if (!this.host) {
			return { namespace: "local", repo: name, remote: `local://${name}`, baseCommit: head, forkedFrom: this.repo, createdAt: Date.now() };
		}
		// Forks are server-side Artifacts operations; they run in parallel outside the workspace queue.
		const fork = await this.host.fork(this.repo, name, description);
		this.remotes.set(fork.name, fork.remote);
		return {
			namespace: this.host.namespace,
			repo: fork.name,
			repoId: fork.id,
			remote: fork.remote,
			baseCommit: head,
			forkedFrom: this.repo,
			createdAt: Date.now(),
		};
	}

	/** Pull the Flight repo's head into the workspace (e.g. after an external push). */
	syncFlight(flightId: string) {
		return this.run(async () =>
			this.host ? await this.fetchFrom(this.flightRepoName(flightId), flightRef(flightId)) : await this.ws.resolve(flightRef(flightId)),
		);
	}

	/**
	 * Build the commit a Flight is asking to publish, on a staging ref. Nothing is pushed yet.
	 * When the agent supplies its own commit metadata, the rebuilt commit has the same id.
	 */
	stageCommit(flightId: string, input: { parent: string; files: Record<string, string | null>; message: string; author: GitAuthor }) {
		return this.run(async () => {
			const oid = await this.ws.commit({ ref: stagingRef(flightId), ...input });
			const diff = await this.ws.changes(input.parent, oid);
			return { oid, ...diff };
		});
	}

	/** Push an approved commit to the Flight's repository with a 60-second write token. */
	publish(flightId: string, oid: string, note: unknown) {
		return this.run(async () => {
			await this.ws.setRef(flightRef(flightId), oid);
			await this.ws.addNote(oid, note, { ...TOWER_AUTHOR, timestamp: Math.floor(Date.now() / 1000) });
			if (!this.host) return { tokenId: undefined as string | undefined };
			const name = this.flightRepoName(flightId);
			const { tokenId } = await this.host.withToken(name, "write", async (token) => {
				const url = await this.remoteOf(name);
				await this.ws.push({ url, token, localRef: flightRef(flightId), remoteRef: "refs/heads/main", force: false });
				await this.ws.push({ url, token, localRef: NOTES_REF, remoteRef: NOTES_REF, force: true });
			});
			return { tokenId };
		});
	}

	/** Non-destructive integration check against the latest accepted canonical revision. */
	preflight(flightId: string) {
		return this.run(async () => {
			const canonical = (await this.ws.resolve(CANONICAL)) as string;
			const head = (await this.ws.resolve(flightRef(flightId))) as string;
			const outcome = await this.ws.merge({
				ours: CANONICAL,
				theirs: head,
				message: "preflight",
				author: { ...TOWER_AUTHOR, timestamp: Math.floor(Date.now() / 1000) },
				dryRun: true,
			});
			const changedPaths = outcome.mergeBase ? (await this.ws.changes(outcome.mergeBase, head)).files.map((f) => f.path) : [];
			return { ...outcome, changedPaths, staleBase: outcome.mergeBase !== canonical, canonical, head };
		});
	}

	/** Integrate a Flight into canonical: merge commit + Git note, pushed to the canonical repo. */
	land(flightId: string, message: string, note: unknown, author: GitAuthor): Promise<MergeOutcome> {
		return this.run(async () => {
			const outcome = await this.ws.merge({ ours: CANONICAL, theirs: flightRef(flightId), message, author });
			if (!outcome.clean || !outcome.oid) return outcome;
			await this.ws.addNote(outcome.oid, note, author);
			if (this.host) {
				const name = this.repo;
				await this.host.withToken(name, "write", async (token) => {
					const url = await this.remoteOf(name);
					await this.ws.push({ url, token, localRef: CANONICAL, remoteRef: "refs/heads/main" });
					await this.ws.push({ url, token, localRef: NOTES_REF, remoteRef: NOTES_REF, force: true });
				});
			}
			return outcome;
		});
	}

	/** Bring a Flight onto the new canonical baseline (merge canonical into the Flight repo). */
	refreshFlight(flightId: string, author: GitAuthor): Promise<MergeOutcome> {
		return this.run(async () => {
			const outcome = await this.ws.merge({
				ours: flightRef(flightId),
				theirs: CANONICAL,
				message: `Refresh ${flightId} onto canonical`,
				author,
			});
			if (outcome.clean && this.host) {
				const name = this.flightRepoName(flightId);
				await this.host.withToken(name, "write", async (token) => {
					const url = await this.remoteOf(name);
					await this.ws.push({ url, token, localRef: flightRef(flightId), remoteRef: "refs/heads/main" });
				});
			}
			return outcome;
		});
	}

	filesAt(ref: string, filter?: (p: string) => boolean) {
		return this.run(() => this.ws.readFiles(ref, filter));
	}

	resolve(ref: string) {
		return this.run(() => this.ws.resolve(ref));
	}

	/** Compare only accepted work; completed runs remain pinned to their integration commit. */
	changes(flight: Flight, canonicalCommit: string, path?: string): Promise<ChangesResponse> {
		return this.run(async () => {
			if (flight.phase !== "landed" && flight.cleanup?.deletedAt !== undefined) throw new ControllerError("Work expired", 410);
			const integrated = flight.phase === "landed" && !!flight.landedCommit;
			const headCommit = integrated ? (flight.landedCommit as string) : await this.ws.resolve(flightRef(flight.id));
			const baseCommit = headCommit
				? integrated
					? ((await this.ws.log(headCommit, 1))[0]?.parents[0] ?? null)
					: await this.ws.mergeBase(canonicalCommit, headCommit)
				: null;
			const result: ChangesResponse = {
				flightId: flight.id,
				comparison: integrated ? "integrated" : "published",
				baseCommit,
				headCommit,
				canonicalCommit,
				files: [],
				additions: 0,
				deletions: 0,
				statsComplete: true,
				...(baseCommit && headCommit ? await this.ws.reviewChanges(baseCommit, headCommit, path) : {}),
			};
			if (path && !result.file) throw new ControllerError("File is not part of these changes", 404);
			return result;
		});
	}

	/** Commit history with Cruce notes attached (for the "show me it really happened" view). */
	history(ref: string, depth = 25) {
		return this.run(async () => {
			const entries = await this.ws.log(ref, depth);
			return Promise.all(entries.map(async (e) => ({ ...e, note: migratePlanRecords(await this.ws.readNote(e.oid)) })));
		});
	}

	/** Verify durable canonical history and notes before destroying the isolated copy. */
	verifyLanding(flight: Pick<Flight, "id" | "landedCommit"> & { publishedHead?: string }) {
		return this.run(async () => {
			const commit = flight.landedCommit;
			if (!commit) throw new Error("Landing commit missing");
			let canonical = await this.ws.resolve(CANONICAL);
			if (this.host) {
				canonical = await this.fetchFrom(this.repo, "refs/cruce/cleanup-canonical");
				const note = await this.host.readFile(this.repo, NOTES_REF, commit);
				if (!note) throw new Error("Canonical landing note missing");
				const body = JSON.parse(await note.text()) as { kind?: string; flightId?: string };
				if (body.kind !== "landing" || body.flightId !== flight.id) throw new Error("Canonical landing note mismatch");
			} else {
				const note = (await this.ws.readNote(commit)) as { kind?: string; flightId?: string } | null;
				if (note?.kind !== "landing" || note.flightId !== flight.id) throw new Error("Canonical landing note missing");
			}
			if (!canonical || (await this.ws.mergeBase(commit, canonical)) !== commit) throw new Error("Landing is not preserved in canonical");
			if (flight.publishedHead && (await this.ws.mergeBase(flight.publishedHead, commit)) !== flight.publishedHead)
				throw new Error("Published work is not preserved in the landing");
			await this.ws.deleteRef("refs/cruce/cleanup-canonical");
		});
	}

	clearFlightResources(flightId: string, repo: string, clearRefs: boolean) {
		return this.run(async () => {
			this.remotes.delete(repo);
			if (clearRefs) {
				await this.ws.deleteRef(flightRef(flightId));
				await this.ws.deleteRef(stagingRef(flightId));
			}
			this.ws.clearCache();
		});
	}

	/** Remote URLs are stable; cache them so routine Git work costs no extra control-plane calls. */
	async remoteOf(name: string): Promise<string> {
		const known = this.remotes.get(name);
		if (known) return known;
		const remote = (await this.host?.info(name))?.remote;
		if (!remote) throw new Error(`no remote for ${name}`);
		this.remotes.set(name, remote);
		return remote;
	}

	private async seedCommit(seed: Record<string, string>, author: GitAuthor) {
		return this.ws.commit({ ref: CANONICAL, parent: null, files: seed, message: "Baseline: auth-service", author });
	}

	private async fetchFrom(repoName: string, localRef: string): Promise<string | null> {
		if (!this.host) return this.ws.resolve(localRef);
		const { result } = await this.host.withToken(repoName, "read", async (token) => {
			const url = await this.remoteOf(repoName);
			return this.ws.fetch({ url, token, localRef });
		});
		return result;
	}

	private async pushTo(repoName: string, localRef: string, remoteRef: string, force: boolean) {
		if (!this.host) return;
		await this.host.withToken(repoName, "write", async (token) => {
			const url = await this.remoteOf(repoName);
			await this.ws.push({ url, token, localRef, remoteRef, force });
		});
	}

	private async deleteRemoteRef(repoName: string, remoteRef: string) {
		if (!this.host) return;
		try {
			await this.host.withToken(repoName, "write", async (token) => {
				const url = await this.remoteOf(repoName);
				await this.ws.deleteRemote({ url, token, remoteRef });
			});
		} catch {
			// nothing to delete
		}
	}
}
