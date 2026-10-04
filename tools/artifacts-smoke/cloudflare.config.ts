import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Minimal Worker used to verify Artifacts access end to end (create → push → clone).
// It is never deployed; run it with `cf dev` and drive it from scripts/verify.sh.
export default defineConfig({
	worker: {
		name: "cruce-artifacts-smoke",
		compatibilityDate: "2026-10-01",
		entrypoint,
		env: {
			ARTIFACTS: bindings.artifacts({ namespace: "cruce-dev", dev: { remote: true } }),
		},
	},
});
