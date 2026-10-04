import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/**
 * Cruce on Cloudflare.
 *
 *   cf dev                  local dev; Artifacts binding is remote (it has no local simulator)
 *   cf dev --mode offline   no Cloudflare account needed: demo runs on the local Git backend
 *   cf deploy               production Worker + Durable Objects + queue consumer
 */
export default defineConfig(({ mode }) => {
	const offline = mode === "offline";
	return {
		accountId: offline ? undefined : "YOUR_32_CHARACTER_ACCOUNT_ID",
		worker: {
			name: "cruce",
			compatibilityDate: "2026-10-01",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
			observability: { enabled: true },
			exports: {
				ControlTower: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				CONTROL_TOWER: bindings.durableObject({ worker: "cruce", exportName: "ControlTower" }),
				...(offline ? { GIT_BACKEND: bindings.text("local") } : { ARTIFACTS: bindings.artifacts({ namespace: "cruce-dev", dev: { remote: true } }) }),
				ARTIFACTS_NAMESPACE: bindings.text("cruce-dev"),
				CF_ACCOUNT_ID: bindings.text("YOUR_32_CHARACTER_ACCOUNT_ID"),
				EVENTS_QUEUE_ID: bindings.text("YOUR_QUEUE_ID"),
				CRUCE_SECRET: bindings.secret(),
				CRUCE_ADMIN_TOKEN: bindings.secret(),
			},
			triggers: offline ? [] : [triggers.queue({ name: "cruce-artifact-events", maxBatchSize: 10, maxBatchTimeout: 2 })],
		},
	};
});
