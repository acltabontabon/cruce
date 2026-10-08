import { DomainError } from "../core/errors.ts";
import { STATE_LIMITS } from "../shared/limits.ts";

export interface Store {
	get<T>(key: string): T | undefined;
	put(key: string, value: unknown): void;
	delete(key: string): void;
	/** Atomically writes `entries` and removes `deletes`; capacity counts the result. */
	batch(entries: { key: string; value: unknown }[], deletes?: string[]): void;
	scan<T>(prefix: string, after?: string, limit?: number): { key: string; value: T }[];
	usage(): { bytes: number; records: number };
	admit(bytes?: number, records?: number): void;
}
export function jsonBytes(value: unknown) {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}
function encode(key: string, value: unknown) {
	const body = JSON.stringify(value);
	const bytes = new TextEncoder().encode(key).length + new TextEncoder().encode(body).length;
	if (bytes > STATE_LIMITS.recordBytes) throw new DomainError(413, "Coordination record exceeds its byte limit");
	return { key, body, bytes };
}
function capacity(bytes: number, records: number, reserve = 0) {
	if (bytes > STATE_LIMITS.storeBytes - reserve || records > STATE_LIMITS.storeRecords - (reserve ? 100 : 0))
		throw new DomainError(409, "Coordination storage capacity reached; inspect retained records before adding work");
}
/** Schema discovery is read-only, including on a never-initialized Durable Object. */
export function sqlTableExists(sql: SqlStorage, name: string) {
	return sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
}
export function sqlStore(sql: SqlStorage, atomic: <T>(run: () => T) => T = (run) => run()): Store {
	let exists = false;
	const available = () => {
		if (!exists) exists = sqlTableExists(sql, "records");
		return exists;
	};
	const usage = () => {
		if (!available()) return { bytes: 0, records: 0 };
		if (sqlTableExists(sql, "record_usage"))
			return sql.exec<{ bytes: number; records: number }>("SELECT bytes, records FROM record_usage WHERE id = 1").toArray()[0];
		// Only the original bounded records table needs this scan. Explicit writes install
		// the counter atomically; cold reads never create or backfill it.
		return sql
			.exec<{ bytes: number; records: number }>(
				"SELECT coalesce(sum(length(CAST(key AS BLOB)) + length(CAST(body AS BLOB))), 0) AS bytes, count(*) AS records FROM records",
			)
			.toArray()[0];
	};
	const initialize = () => {
		if (!available()) {
			sql.exec("CREATE TABLE records (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
			exists = true;
		}
		if (!sqlTableExists(sql, "record_usage")) {
			const current = usage();
			sql.exec("CREATE TABLE record_usage (id INTEGER PRIMARY KEY, bytes INTEGER NOT NULL, records INTEGER NOT NULL)");
			sql.exec("INSERT INTO record_usage VALUES (1, ?, ?)", current.bytes, current.records);
		}
	};
	const store: Store = {
		get<T>(key: string) {
			if (!available()) return;
			const row = sql.exec<{ body: string }>("SELECT body FROM records WHERE key = ?", key).toArray()[0];
			return row ? (JSON.parse(row.body) as T) : undefined;
		},
		put(key, value) {
			store.batch([{ key, value }]);
		},
		batch(entries, deletes = []) {
			const encoded = entries.map(({ key, value }) => encode(key, value));
			if (new Set([...entries.map(({ key }) => key), ...deletes]).size !== entries.length + deletes.length)
				throw new Error("Duplicate storage key in transaction");
			const existing = (key: string) =>
				available()
					? sql
							.exec<{ bytes: number }>(
								"SELECT length(CAST(key AS BLOB)) + length(CAST(body AS BLOB)) AS bytes FROM records WHERE key = ?",
								key,
							)
							.toArray()[0]
					: undefined;
			try {
				atomic(() => {
					const current = usage();
					let bytes = current.bytes,
						records = current.records;
					for (const row of encoded) {
						const old = existing(row.key);
						bytes += row.bytes - (old?.bytes ?? 0);
						if (!old) records++;
					}
					const removed = deletes.filter((key) => {
						const old = existing(key);
						if (!old) return false;
						bytes -= old.bytes;
						records--;
						return true;
					});
					capacity(bytes, records);
					initialize();
					for (const row of encoded)
						sql.exec("INSERT INTO records VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body", row.key, row.body);
					for (const key of removed) sql.exec("DELETE FROM records WHERE key = ?", key);
					sql.exec("UPDATE record_usage SET bytes = ?, records = ? WHERE id = 1", bytes, records);
				});
			} catch (error) {
				exists = false;
				throw error;
			}
		},
		delete(key) {
			if (!available()) return;
			atomic(() => {
				initialize();
				const old = sql
					.exec<{ bytes: number }>("SELECT length(CAST(key AS BLOB)) + length(CAST(body AS BLOB)) AS bytes FROM records WHERE key = ?", key)
					.toArray()[0];
				if (!old) return;
				sql.exec("DELETE FROM records WHERE key = ?", key);
				sql.exec("UPDATE record_usage SET bytes = bytes - ?, records = records - 1 WHERE id = 1", old.bytes);
			});
		},
		scan<T>(prefix: string, after = prefix, limit = STATE_LIMITS.pageSize) {
			if (!available()) return [];
			if (!Number.isInteger(limit) || limit < 1 || limit > STATE_LIMITS.namespaceCandidates + 1)
				throw new DomainError(400, "Invalid page limit");
			if (!prefix)
				return sql
					.exec<{ key: string; body: string }>("SELECT key, body FROM records WHERE key > ? ORDER BY key LIMIT ?", after, limit)
					.toArray()
					.map(({ key, body }) => ({ key, value: JSON.parse(body) as T }));
			return sql
				.exec<{ key: string; body: string }>(
					"SELECT key, body FROM records WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?",
					prefix,
					`${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`,
					after,
					limit,
				)
				.toArray()
				.map(({ key, body }) => ({ key, value: JSON.parse(body) as T }));
		},
		usage,
		admit(bytes = STATE_LIMITS.recordBytes, records = 4) {
			const current = usage();
			capacity(current.bytes + bytes, current.records + records, STATE_LIMITS.recoveryBytes);
		},
	};
	return store;
}
/** Same bounded semantics for in-process fixtures; production uses SQLite transactions. */
export function memoryStore(values = new Map<string, unknown>()): Store {
	const usage = () => ({ bytes: [...values].reduce((sum, [key, value]) => sum + encode(key, value).bytes, 0), records: values.size });
	const store: Store = {
		get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
		put: (key, value) => store.batch([{ key, value }]),
		batch(entries, deletes = []) {
			for (const { key, value } of entries) encode(key, value);
			if (new Set([...entries.map(({ key }) => key), ...deletes]).size !== entries.length + deletes.length)
				throw new Error("Duplicate storage key in transaction");
			const candidate = new Map(values);
			for (const { key, value } of entries) candidate.set(key, structuredClone(value));
			for (const key of deletes) candidate.delete(key);
			capacity(
				[...candidate].reduce((sum, [key, value]) => sum + encode(key, value).bytes, 0),
				candidate.size,
			);
			for (const { key, value } of entries) values.set(key, structuredClone(value));
			for (const key of deletes) values.delete(key);
		},
		delete: (key) => {
			values.delete(key);
		},
		scan: <T>(prefix: string, after = prefix, limit = STATE_LIMITS.pageSize) =>
			[...values]
				.filter(([key]) => key.startsWith(prefix) && key > after)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.slice(0, limit)
				.map(([key, value]) => ({ key, value: structuredClone(value) as T })),
		usage,
		admit(bytes = STATE_LIMITS.recordBytes, records = 4) {
			const current = usage();
			capacity(current.bytes + bytes, current.records + records, STATE_LIMITS.recoveryBytes);
		},
	};
	return store;
}
export class Serial {
	private queue: Promise<unknown> = Promise.resolve();
	run<T>(fn: () => Promise<T> | T): Promise<T> {
		const next = this.queue.then(fn);
		this.queue = next.catch(() => {});
		return next;
	}
}
export async function hash(text: string) {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
}

/** Read-only paged existence check within the supported retained-record envelope. */
export function someRecord<T>(store: Store, prefix: string, predicate: (value: T) => boolean) {
	let cursor: string | undefined;
	for (let offset = 0; offset <= STATE_LIMITS.storeRecords; offset += STATE_LIMITS.pageSize) {
		const rows = store.scan<T>(prefix, cursor, STATE_LIMITS.pageSize);
		if (rows.some(({ value }) => predicate(value))) return true;
		if (rows.length < STATE_LIMITS.pageSize) return false;
		cursor = rows.at(-1)!.key;
	}
	throw new DomainError(409, "Coordination storage capacity reached; inspect retained records before adding work");
}
