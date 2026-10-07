import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

/** Fully written private files become visible atomically; readers never see partial JSON. */
export async function writeState(path: string, value: unknown, exclusive = false) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(JSON.stringify(value, null, 2));
		await file.sync();
		await file.close();
		if (exclusive) await link(temporary, path);
		else await rename(temporary, path);
	} finally {
		await file.close().catch(() => {});
		await rm(temporary, { force: true });
	}
}

/** A short-lived update lock. A crashed holder requires explicit inspection, never expiry. */
export async function withStateLock<T>(path: string, run: () => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true });
	const lock = `${path}.lock`;
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			await mkdir(lock, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await setTimeout(50);
			continue;
		}
		try {
			await writeState(`${lock}/holder.json`, { pid: process.pid });
			return await run();
		} finally {
			await rm(lock, { recursive: true, force: true });
		}
	}
	throw new Error("Another process owns this local state update. Inspect its lock after that process exits; locks never expire.");
}
