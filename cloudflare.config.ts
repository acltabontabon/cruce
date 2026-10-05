import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/**
 * Cruce on Cloudflare.
 *
 *   cf dev                              local Worker; source resources require explicit namespace configuration
 *   cf dev --mode offline               local Worker with no Artifacts provisioning
 *   pnpm deploy:test                    the single live MVP test environment
 */

export default defineConfig(({ mode }) => {
	const offline = mode === "offline";
	const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
	return {
		accountId: offline ? undefined : "YOUR_32_CHARACTER_ACCOUNT_ID",
		worker: {
			name: "cruce",
			domains: offline ? [] : ["cruce.acltabontabon.com"],
			workersDev: offline,
			compatibilityDate: "2026-10-01",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api/*", "/mcp", "/mcp/*", "/bridge/*", "/auth/*", "/authorize", "/oauth/*", "/.well-known/*"],
			},
			observability: { enabled: true },
			exports: {
				ControlTower: exports.durableObject({ storage: "sqlite" }),
				Directory: exports.durableObject({ storage: "sqlite" }),
				NamespaceRuntime: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				CONTROL_TOWER: bindings.durableObject({ worker: "cruce", exportName: "ControlTower" }),
				DIRECTORY: bindings.durableObject({ worker: "cruce", exportName: "Directory" }),
				NAMESPACE: bindings.durableObject({ worker: "cruce", exportName: "NamespaceRuntime" }),
				OAUTH_KV: bindings.kv(),
				CRUCE_PUBLIC_ORIGIN: bindings.text(
					env.CRUCE_PUBLIC_ORIGIN ?? (offline ? "http://localhost:5173" : "https://cruce.acltabontabon.com"),
				),
				CRUCE_ACCESS_ISSUER: bindings.text(env.CRUCE_ACCESS_ISSUER ?? ""),
				CRUCE_ACCESS_AUD: bindings.text(env.CRUCE_ACCESS_AUD ?? ""),

				CRUCE_SECRET: bindings.secret(),
			},
			triggers: [],
		},
	};
});
