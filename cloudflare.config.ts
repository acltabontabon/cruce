import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };
import { installationConfig } from "./tools/installation-config.mjs";

/** Installation infrastructure is configured once; namespaces never supply provider credentials. */
export default defineConfig(({ mode }) => {
	const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
	const config = installationConfig(env, mode === "production");
	const offline = mode === "offline";
	const observationQueue = env.CRUCE_OBSERVATION_QUEUE?.trim() || `${config.workerName}-artifact-events`;
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
				...(!offline
					? {
							OBSERVATION_QUEUE: bindings.queue({ name: observationQueue }),
							OBSERVATION_DEAD_QUEUE: bindings.queue({ name: `${observationQueue}-dead` }),
						}
					: {}),
				CRUCE_OBSERVATION_QUEUE: bindings.text(observationQueue),
				CRUCE_OBSERVATION_QUEUE_ID: bindings.text(env.CRUCE_OBSERVATION_QUEUE_ID ?? ""),
				CF_EVENTS_API_TOKEN: bindings.secret(),
				CRUCE_STORAGE_ACCOUNT_ID: bindings.text(offline ? "" : (config.accountId ?? "")),
				CRUCE_ARTIFACTS_NAMESPACE: bindings.text(config.artifactsNamespace),
				CRUCE_PUBLIC_ORIGIN: bindings.text(config.origin),
				CRUCE_ACCESS_ISSUER: bindings.text(env.CRUCE_ACCESS_ISSUER ?? ""),
				CRUCE_ACCESS_AUD: bindings.text(env.CRUCE_ACCESS_AUD ?? ""),
				CRUCE_SIGN_IN_PROVIDER: bindings.text(env.CRUCE_SIGN_IN_PROVIDER ?? ""),
				CRUCE_SECRET: bindings.secret(),
			},
			triggers: offline
				? []
				: [
						triggers.queue({
							name: observationQueue,
							deadLetterQueue: `${observationQueue}-dead`,
							maxBatchSize: 10,
							maxBatchTimeout: 1,
							maxRetries: 5,
							retryDelay: 30,
						}),
						triggers.queue({ name: `${observationQueue}-dead`, maxBatchSize: 10, maxBatchTimeout: 1, maxRetries: 10 }),
					],
		},
	};
});
