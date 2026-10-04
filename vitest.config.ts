import { defineConfig } from "vitest/config";

// Controller, airspace, and Git logic are pure TypeScript and run on Node.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
	},
});
