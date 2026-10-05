/**
 * A filesystem for isomorphic-git backed by Durable Object SQLite storage.
 *
 * Cruce keeps one bare Git object cache per repository in its control-tower Durable Object. Persisting the
 * object database here means fetches from Artifacts are incremental (no re-clone per operation) and
 * the offline demo backend survives restarts.
 */

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

	constructor(private readonly sql: SqlStorage) {
		sql.exec(`CREATE TABLE IF NOT EXISTS gitfs (path TEXT PRIMARY KEY, dir INTEGER NOT NULL, data BLOB, mtime INTEGER NOT NULL)`);
		if (!this.row("/")) sql.exec(`INSERT INTO gitfs (path, dir, data, mtime) VALUES ('/', 1, NULL, ?)`, Date.now());
	}

	/** Remove a whole subtree (used to reset the object cache). */
	removeTree(prefix: string) {
		const p = norm(prefix);
		this.sql.exec(`DELETE FROM gitfs WHERE path = ? OR (path > ? AND path < ?)`, p, `${p}/`, `${p}0`);
	}

	private row(path: string): Row | undefined {
		return this.sql.exec<Row>(`SELECT path, dir, data, mtime FROM gitfs WHERE path = ?`, path).toArray()[0];
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
		const existing = this.row(p);
		if (existing?.dir) throw new FsError("EISDIR", p);
		this.sql.exec(
			`INSERT INTO gitfs (path, dir, data, mtime) VALUES (?, 0, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, mtime = excluded.mtime`,
			p,
			bytes.slice().buffer,
			Date.now(),
		);
	}

	async unlink(path: string) {
		const p = norm(path);
		const r = this.row(p);
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
		const r = this.row(p);
		if (!r) throw new FsError("ENOENT", p);
		return new Stats(r, r.data ? r.data.byteLength : 0);
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
