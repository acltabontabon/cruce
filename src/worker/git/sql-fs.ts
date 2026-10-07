/**
 * A filesystem for isomorphic-git backed by Durable Object SQLite storage.
 *
 * Cruce keeps one bare Git object cache per repository in its control-tower Durable Object. Persisting the
 * object database here means fetches from Artifacts are incremental (no re-clone per operation) and
 * the offline demo backend survives restarts.
 */

import { DomainError } from "../../core/errors.ts";
import { sqlTableExists } from "../store.ts";

/** A full cache is recoverable by a reset; other limits are not. */
export const CACHE_LIMIT = "Git source exceeds the bounded cache limit; use normal Git for larger repositories";

export const GIT_CACHE_LIMITS = { retainedBytes: 48 * 1024 * 1024, maxBytes: 64 * 1024 * 1024, maxEntries: 20_000 } as const;

interface Row {
	path: string;
	dir: number;
	data: ArrayBuffer | null;
	mtime: number;
	[key: string]: SqlStorageValue;
}

class FsError extends Error {
	constructor(
		readonly code: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY",
		path: string,
	) {
		super(`${code}: ${path}`);
	}
}

class Stats {
	constructor(
		private readonly row: Row,
		private readonly bytes: number,
	) {}
	get size() {
		return this.bytes;
	}
	get mtimeMs() {
		return this.row.mtime;
	}
	get ctimeMs() {
		return this.row.mtime;
	}
	get mode() {
		return this.row.dir ? 0o040000 : 0o100644;
	}
	readonly uid = 1;
	readonly gid = 1;
	readonly dev = 1;
	readonly ino = 0;
	isFile() {
		return !this.row.dir;
	}
	isDirectory() {
		return !!this.row.dir;
	}
	isSymbolicLink() {
		return false;
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SqlFs {
	readonly promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.stat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
		chmod: async () => {},
	};

	private exists = false;
	private initialized = false;
	constructor(
		private readonly sql: SqlStorage,
		private readonly limits: { retainedBytes: number; maxBytes: number; maxEntries: number } = GIT_CACHE_LIMITS,
	) {}

	cacheUsage() {
		if (!this.available()) return { bytes: 0, entries: 0 };
		return this.sql
			.exec<{ bytes: number; entries: number }>(
				`SELECT COALESCE(SUM(COALESCE(LENGTH(data), 0) + LENGTH(CAST(path AS BLOB))), 0) AS bytes, COUNT(*) AS entries FROM gitfs`,
			)
			.toArray()[0];
	}
	/** Whole generations are evicted together: packs, indexes, refs and shallow state cannot outlive each other. */
	trimCache(prefix: string) {
		const usage = this.cacheUsage();
		if (usage.bytes <= this.limits.retainedBytes && usage.entries < Math.floor(this.limits.maxEntries / 2)) return false;
		this.removeTree(prefix);
		return true;
	}
	private capacity(path: string, bytes: number) {
		const usage = this.cacheUsage(),
			old = this.metadata(path);
		const size = usage.bytes - (old?.bytes ?? 0) + bytes + (old ? 0 : encoder.encode(path).length);
		if (size > this.limits.maxBytes || usage.entries + (old ? 0 : 1) > this.limits.maxEntries) throw new DomainError(413, CACHE_LIMIT);
	}

	private available() {
		if (!this.exists) this.exists = sqlTableExists(this.sql, "gitfs");
		return this.exists;
	}
	private initialize() {
		if (this.initialized) return;
		if (!this.available()) {
			this.sql.exec(`CREATE TABLE gitfs (path TEXT PRIMARY KEY, dir INTEGER NOT NULL, data BLOB, mtime INTEGER NOT NULL)`);
			this.exists = true;
		}
		if (!this.row("/")) this.sql.exec(`INSERT INTO gitfs (path, dir, data, mtime) VALUES ('/', 1, NULL, ?)`, Date.now());
		this.initialized = true;
	}

	/** Remove a whole subtree (used to reset the object cache). */
	removeTree(prefix: string) {
		if (!this.available()) return;
		const p = norm(prefix);
		this.sql.exec(`DELETE FROM gitfs WHERE path = ? OR (path > ? AND path < ?)`, p, `${p}/`, `${p}0`);
	}

	private row(path: string): Row | undefined {
		if (!this.available()) return;
		return this.sql.exec<Row>(`SELECT path, dir, data, mtime FROM gitfs WHERE path = ?`, path).toArray()[0];
	}
	private metadata(path: string) {
		if (!this.available()) return;
		return this.sql
			.exec<Row & { bytes: number }>(
				`SELECT path, dir, NULL AS data, mtime, COALESCE(LENGTH(data), 0) AS bytes FROM gitfs WHERE path = ?`,
				path,
			)
			.toArray()[0];
	}

	async readFile(path: string, options?: string | { encoding?: string }) {
		const p = norm(path);
		const r = this.row(p);
		if (!r) throw new FsError("ENOENT", p);
		if (r.dir) throw new FsError("EISDIR", p);
		const bytes = new Uint8Array(r.data ?? new ArrayBuffer(0));
		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? decoder.decode(bytes) : bytes;
	}

	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
		const p = norm(path);
		await this.mkdir(parent(p), { recursive: true });
		const bytes = typeof data === "string" ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
		const existing = this.metadata(p);
		if (existing?.dir) throw new FsError("EISDIR", p);
		this.capacity(p, bytes.byteLength);
		this.sql.exec(
			`INSERT INTO gitfs (path, dir, data, mtime) VALUES (?, 0, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, mtime = excluded.mtime`,
			p,
			Uint8Array.from(bytes).buffer,
			Date.now(),
		);
	}

	async unlink(path: string) {
		const p = norm(path);
		const r = this.metadata(p);
		if (!r) throw new FsError("ENOENT", p);
		if (r.dir) throw new FsError("EISDIR", p);
		this.sql.exec(`DELETE FROM gitfs WHERE path = ?`, p);
	}

	async readdir(path: string) {
		const p = norm(path);
		const r = this.row(p);
		if (!r) throw new FsError("ENOENT", p);
		if (!r.dir) throw new FsError("ENOTDIR", p);
		const prefix = p === "/" ? "/" : `${p}/`;
		const upper = p === "/" ? "0" : `${p}0`;
		const names = new Set<string>();
		for (const row of this.sql.exec<{ path: string }>(`SELECT path FROM gitfs WHERE path > ? AND path < ?`, prefix, upper)) {
			const rest = row.path.slice(prefix.length);
			if (rest && !rest.includes("/")) names.add(rest);
		}
		return [...names].sort();
	}

	async mkdir(path: string, options?: { recursive?: boolean } | number) {
		this.initialize();
		const p = norm(path);
		const existing = this.row(p);
		if (existing) {
			if (!existing.dir) throw new FsError("ENOTDIR", p);
			if (typeof options === "object" && options?.recursive) return;
			throw new FsError("EEXIST", p);
		}
		const par = parent(p);
		if (!this.row(par)) {
			if (typeof options === "object" && options?.recursive) await this.mkdir(par, { recursive: true });
			else throw new FsError("ENOENT", par);
		}
		this.capacity(p, 0);
		this.sql.exec(`INSERT OR IGNORE INTO gitfs (path, dir, data, mtime) VALUES (?, 1, NULL, ?)`, p, Date.now());
	}

	async rmdir(path: string) {
		const p = norm(path);
		const r = this.row(p);
		if (!r) throw new FsError("ENOENT", p);
		if (!r.dir) throw new FsError("ENOTDIR", p);
		if ((await this.readdir(p)).length) throw new FsError("ENOTEMPTY", p);
		this.sql.exec(`DELETE FROM gitfs WHERE path = ?`, p);
	}

	async stat(path: string) {
		const p = norm(path);
		const r = this.metadata(p);
		if (!r) throw new FsError("ENOENT", p);
		return new Stats(r, r.bytes);
	}

	async readlink(path: string): Promise<string> {
		throw new FsError("ENOENT", norm(path));
	}

	async symlink(_target: string, path: string) {
		throw new FsError("EEXIST", norm(path));
	}
}

function norm(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

function parent(path: string): string {
	const parts = norm(path).split("/").filter(Boolean);
	parts.pop();
	return `/${parts.join("/")}`;
}
