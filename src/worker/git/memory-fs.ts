/** In-memory filesystem for isomorphic-git (tests and ephemeral workspaces). Same surface as SqlFs. */

type Entry = { kind: "dir"; mtime: number } | { kind: "file"; data: Uint8Array; mtime: number };

class FsError extends Error {
	constructor(
		readonly code: string,
		path: string,
	) {
		super(`${code}: ${path}`);
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MemoryFs {
	private readonly entries = new Map<string, Entry>([["/", { kind: "dir", mtime: 0 }]]);

	readonly promises = {
		readFile: async (path: string, options?: string | { encoding?: string }) => {
			const e = this.get(path);
			if (e.kind !== "file") throw new FsError("EISDIR", path);
			const encoding = typeof options === "string" ? options : options?.encoding;
			return encoding ? decoder.decode(e.data) : e.data;
		},
		writeFile: async (path: string, data: string | Uint8Array) => {
			const p = norm(path);
			await this.promises.mkdir(parent(p), { recursive: true });
			this.entries.set(p, { kind: "file", data: typeof data === "string" ? encoder.encode(data) : new Uint8Array(data), mtime: Date.now() });
		},
		unlink: async (path: string) => {
			if (this.get(path).kind !== "file") throw new FsError("EISDIR", path);
			this.entries.delete(norm(path));
		},
		readdir: async (path: string) => {
			const p = norm(path);
			if (this.get(p).kind !== "dir") throw new FsError("ENOTDIR", p);
			const prefix = p === "/" ? "/" : `${p}/`;
			return [...this.entries.keys()]
				.filter((k) => k !== p && k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
				.map((k) => k.slice(prefix.length))
				.sort();
		},
		mkdir: async (path: string, options?: { recursive?: boolean }) => {
			const p = norm(path);
			const existing = this.entries.get(p);
			if (existing) {
				if (existing.kind !== "dir") throw new FsError("ENOTDIR", p);
				if (options?.recursive) return;
				throw new FsError("EEXIST", p);
			}
			if (!this.entries.has(parent(p))) {
				if (!options?.recursive) throw new FsError("ENOENT", parent(p));
				await this.promises.mkdir(parent(p), { recursive: true });
			}
			this.entries.set(p, { kind: "dir", mtime: Date.now() });
		},
		rmdir: async (path: string) => {
			const p = norm(path);
			if ((await this.promises.readdir(p)).length) throw new FsError("ENOTEMPTY", p);
			this.entries.delete(p);
		},
		stat: async (path: string) => this.stat(path),
		lstat: async (path: string) => this.stat(path),
		readlink: async (path: string): Promise<string> => {
			throw new FsError("ENOENT", path);
		},
		symlink: async (_t: string, path: string) => {
			throw new FsError("EEXIST", path);
		},
		chmod: async () => {},
	};

	private get(path: string): Entry {
		const e = this.entries.get(norm(path));
		if (!e) throw new FsError("ENOENT", path);
		return e;
	}

	private stat(path: string) {
		const e = this.get(path);
		const isDir = e.kind === "dir";
		return {
			size: e.kind === "file" ? e.data.byteLength : 0,
			mtimeMs: e.mtime,
			ctimeMs: e.mtime,
			mode: isDir ? 0o040000 : 0o100644,
			uid: 1,
			gid: 1,
			dev: 1,
			ino: 0,
			isFile: () => !isDir,
			isDirectory: () => isDir,
			isSymbolicLink: () => false,
		};
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
