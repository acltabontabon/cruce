import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };
import { installationConfig } from "./tools/installation-config.mjs";

/** Installation infrastructure is configured once; namespaces never supply provider credentials. */
export default defineConfig(({ mode }) => {
	const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
	const config = installationConfig(env, mode === "production");
	const offline = mode === "offline";
	return {
		accountId: offline ? undefined : config.accountId,
		worker: {
			name: config.workerName,
			domains: offline || !config.domain ? [] : [config.domain],
			workersDev: offline || !config.domain,
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
				CONTROL_TOWER: bindings.durableObject({ worker: config.workerName, exportName: "ControlTower" }),
				DIRECTORY: bindings.durableObject({ worker: config.workerName, exportName: "Directory" }),
				NAMESPACE: bindings.durableObject({ worker: config.workerName, exportName: "NamespaceRuntime" }),
				OAUTH_KV: bindings.kv(),
				...(offline ? {} : { ARTIFACTS: bindings.artifacts({ namespace: config.artifactsNamespace }) }),
				CRUCE_STORAGE_ACCOUNT_ID: bindings.text(offline ? "" : (config.accountId ?? "")),
				CRUCE_ARTIFACTS_NAMESPACE: bindings.text(config.artifactsNamespace),
				CRUCE_PUBLIC_ORIGIN: bindings.text(config.origin),
				CRUCE_ACCESS_ISSUER: bindings.text(env.CRUCE_ACCESS_ISSUER ?? ""),
				CRUCE_ACCESS_AUD: bindings.text(env.CRUCE_ACCESS_AUD ?? ""),
				CRUCE_SECRET: bindings.secret(),
			},
			triggers: [],
		},
	};
});
