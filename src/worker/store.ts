export interface Store {
	get<T>(key: string): T | undefined;
	put(key: string, value: unknown): void;
	delete(key: string): void;
}
/** Schema discovery is read-only, including on a never-initialized Durable Object. */
export function sqlTableExists(sql: SqlStorage, name: string) {
	return sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
}
export function sqlStore(sql: SqlStorage): Store {
	let exists = false;
	const available = () => {
		if (!exists) exists = sqlTableExists(sql, "records");
		return exists;
	};
	return {
		get<T>(key: string) {
			if (!available()) return;
			const row = sql.exec<{ body: string }>("SELECT body FROM records WHERE key = ?", key).toArray()[0];
			return row ? (JSON.parse(row.body) as T) : undefined;
		},
		put(key, value) {
			if (!available()) {
				sql.exec("CREATE TABLE records (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
				exists = true;
			}
			sql.exec("INSERT INTO records VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body", key, JSON.stringify(value));
		},
		delete(key) {
			if (!available()) return;
			sql.exec("DELETE FROM records WHERE key = ?", key);
		},
	};
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
