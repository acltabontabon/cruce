import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/**
 * Cruce on Cloudflare.
 *
 *   cf dev                              local dev; Artifacts binding is remote (no local simulator)
 *   cf dev --mode offline               no Cloudflare account needed: demo on the local Git backend
 *   cf deploy --secrets-file …          production
 */

export default defineConfig(({ mode }) => {
	const offline = mode === "offline";
	// Local development and production never share repositories.
	const namespace = mode === "development" || offline ? "cruce-dev" : "cruce";
	const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
	return {
		accountId: offline ? undefined : "YOUR_32_CHARACTER_ACCOUNT_ID",
		worker: {
			name: "cruce",
			compatibilityDate: "2026-10-01",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api/*", "/mcp", "/mcp/*", "/coordination", "/auth/*", "/authorize", "/oauth/*", "/.well-known/*"],
			},
			observability: { enabled: true },
			exports: {
				ControlTower: exports.durableObject({ storage: "sqlite" }),
				ProjectDirectory: exports.durableObject({ storage: "sqlite" }),
				// Durable orchestration for deployments of exact revisions (build → smoke checks → evidence).
				DeploymentWorkflow: exports.workflow({ name: "cruce-deployment" }),
			},
			env: {
				CONTROL_TOWER: bindings.durableObject({ worker: "cruce", exportName: "ControlTower" }),
				PROJECT_DIRECTORY: bindings.durableObject({ worker: "cruce", exportName: "ProjectDirectory" }),
				DEPLOYMENT_WORKFLOW: bindings.workflow({ name: "cruce-deployment", worker: "cruce", exportName: "DeploymentWorkflow" }),
				OAUTH_KV: bindings.kv(),
				CRUCE_PUBLIC_ORIGIN: bindings.text(
					env.CRUCE_PUBLIC_ORIGIN ?? (offline ? "http://localhost:5173" : "https://cruce.acltabontabon.workers.dev"),
				),
				...(!offline && env.CRUCE_CLOUD_AI === "on" ? { AI: bindings.ai() } : {}),
				CRUCE_ACCESS_ISSUER: bindings.text(env.CRUCE_ACCESS_ISSUER ?? ""),
				CRUCE_ACCESS_AUD: bindings.text(env.CRUCE_ACCESS_AUD ?? ""),

				...(offline ? { GIT_BACKEND: bindings.text("local") } : { ARTIFACTS: bindings.artifacts({ namespace, dev: { remote: true } }) }),
				ARTIFACTS_NAMESPACE: bindings.text(namespace),
				CF_ACCOUNT_ID: bindings.text("YOUR_32_CHARACTER_ACCOUNT_ID"),
				EVENTS_QUEUE_ID: bindings.text("YOUR_QUEUE_ID"),
				CRUCE_SECRET: bindings.secret(),
				...(!offline ? { CF_EVENTS_API_TOKEN: bindings.secret() } : {}),
			},
			triggers: offline ? [] : [triggers.queue({ name: "cruce-artifact-events", maxBatchSize: 10, maxBatchTimeout: 2 })],
		},
	};
});
