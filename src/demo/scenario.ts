const seedModules = import.meta.glob("../../demo/auth-service/**/*", { query: "?raw", import: "default", eager: true }) as Record<
	string,
	string
>;
const overlayModules = import.meta.glob("../../demo/scenario/**/*", { query: "?raw", import: "default", eager: true }) as Record<
	string,
	string
>;

/** The demo repository's files at baseline, keyed by repo-relative path. */
export function seedFiles(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, content] of Object.entries(seedModules)) {
		out[key.replace("../../demo/auth-service/", "")] = content;
	}
	return out;
}

/** The files a scripted source change writes, keyed by repo-relative path. */
export function overlayFiles(overlay: string): Record<string, string> {
	const prefix = `../../demo/scenario/${overlay}/`;
	const out: Record<string, string> = {};
	for (const [key, content] of Object.entries(overlayModules)) {
		if (key.startsWith(prefix)) out[key.slice(prefix.length)] = content;
	}
	return out;
}
