import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/**
 * Cruce on Cloudflare.
 *
 *   cf dev                              local dev; Artifacts binding is remote (no local simulator)
 *   cf dev --mode offline               no Cloudflare account needed: demo on the local Git backend
 *   CRUCE_SANDBOX=on cf dev | deploy    + live Flights: Claude Code in Cloudflare Sandboxes
 *                                         (needs Docker to build the image and ANTHROPIC_API_KEY)
 *   cf deploy --secrets-file …          production
 */

// One Linux sandbox per Flight, managed by the FlightSandbox Durable Object.
const agentSandbox = defineContainer({
	name: "cruce-agent",
	schedulingPolicy: "durable-object",
	images: { agent: { dockerfile: "./sandbox/Dockerfile" } },
});

export default defineConfig(({ mode }) => {
	const offline = mode === "offline";
	// Local development and production never share repositories.
	const namespace = mode === "development" || offline ? "cruce-dev" : "cruce";
	const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
	const sandboxes = !offline && env.CRUCE_SANDBOX === "on";
	return {
		accountId: offline ? undefined : "YOUR_32_CHARACTER_ACCOUNT_ID",
		containers: sandboxes ? [agentSandbox] : [],
		worker: {
			name: "cruce",
			compatibilityDate: "2026-10-01",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
			observability: { enabled: true },
			exports: {
				ControlTower: exports.durableObject({ storage: "sqlite" }),
				...(sandboxes
					? {
							FlightSandbox: exports.durableObject({ storage: "sqlite", container: agentSandbox }),
							FlightWorkflow: exports.workflow({ name: "cruce-flight" }),
							Outbound: exports.worker(),
						}
					: {}),
			},
			env: {
				CONTROL_TOWER: bindings.durableObject({ worker: "cruce", exportName: "ControlTower" }),
				...(offline ? { GIT_BACKEND: bindings.text("local") } : { ARTIFACTS: bindings.artifacts({ namespace, dev: { remote: true } }) }),
				ARTIFACTS_NAMESPACE: bindings.text(namespace),
				CF_ACCOUNT_ID: bindings.text("YOUR_32_CHARACTER_ACCOUNT_ID"),
				EVENTS_QUEUE_ID: bindings.text("YOUR_QUEUE_ID"),
				CRUCE_SECRET: bindings.secret(),
				CRUCE_ADMIN_TOKEN: bindings.secret(),
				CF_EVENTS_API_TOKEN: bindings.secret(),
				...(sandboxes
					? {
							FLIGHT_SANDBOX: bindings.durableObject({ worker: "cruce", exportName: "FlightSandbox" }),
							FLIGHT_WORKFLOW: bindings.workflow({ name: "cruce-flight", worker: "cruce", exportName: "FlightWorkflow" }),
							CRUCE_AGENT_MODEL: bindings.text("claude-sonnet-5-5"),
							ANTHROPIC_API_KEY: bindings.secret(),
						}
					: {}),
			},
			triggers: offline ? [] : [triggers.queue({ name: "cruce-artifact-events", maxBatchSize: 10, maxBatchTimeout: 2 })],
		},
	};
});
