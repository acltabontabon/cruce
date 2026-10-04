import { CoordinationError } from "../core/workstreams.ts";

/** AES-GCM sealing with a key derived from CRUCE_SECRET: identity cookies and connected-account credentials. */
export interface SealingEnv {
	CRUCE_SECRET?: string;
}
const encode = (b: Uint8Array) =>
	btoa(String.fromCharCode(...b))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
export const decode = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
async function key(secret?: string) {
	if (!secret) throw new CoordinationError(503, "Identity encryption not configured");
	return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}
export async function seal(env: SealingEnv, data: unknown) {
	const iv = crypto.getRandomValues(new Uint8Array(12)),
		cipher = new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env.CRUCE_SECRET), new TextEncoder().encode(JSON.stringify(data))),
		);
	return `${encode(iv)}.${encode(cipher)}`;
}
export async function unseal<T>(env: SealingEnv, value: string): Promise<T> {
	try {
		const [iv, cipher] = value.split(".");
		return JSON.parse(
			new TextDecoder().decode(
				await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await key(env.CRUCE_SECRET), decode(cipher)),
			),
		);
	} catch {
		throw new CoordinationError(401, "Sign in again");
	}
}
