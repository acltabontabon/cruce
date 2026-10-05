export interface Store {
	get<T>(key: string): T | undefined;
	put(key: string, value: unknown): void;
	delete(key: string): void;
}
export function sqlStore(sql: SqlStorage): Store {
	sql.exec("CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
	return {
		get<T>(key: string) {
			const row = sql.exec<{ body: string }>("SELECT body FROM records WHERE key = ?", key).toArray()[0];
			return row ? (JSON.parse(row.body) as T) : undefined;
		},
		put(key, value) {
			sql.exec("INSERT INTO records VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body", key, JSON.stringify(value));
		},
		delete(key) {
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
