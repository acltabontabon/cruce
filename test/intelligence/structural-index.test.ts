import { describe, expect, it } from "vitest";
import { baseIndex } from "../fixtures.ts";

describe("structural index (Babel TypeScript)", () => {
	it("groups files into modules from cruce.json", () => {
		expect(baseIndex.modules.map((m) => m.label)).toEqual([
			"Authentication",
			"Sessions",
			"Persistence",
			"Messaging",
			"Tests",
			"Repository",
		]);
		expect(baseIndex.files.find((f) => f.path === "src/auth/token-validator.ts")?.module).toBe("auth");
	});

	it("indexes classes and members with line ranges that include doc comments", () => {
		const file = baseIndex.files.find((f) => f.path === "src/auth/token-validator.ts");
		const names = file?.symbols.map((s) => s.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"Claims",
				"TokenValidator",
				"TokenValidator.validate",
				"TokenValidator.hasScope",
				"TokenValidator.constructor",
			]),
		);
		const validate = file?.symbols.find((s) => s.name === "TokenValidator.validate");
		const cls = file?.symbols.find((s) => s.name === "TokenValidator");
		expect(validate && cls && validate.startLine > cls.startLine && validate.endLine < cls.endLine).toBe(true);
	});

	it("resolves relative imports, including type-only imports", () => {
		const auth = baseIndex.files.find((f) => f.path === "src/auth/auth-service.ts");
		expect(auth?.imports).toEqual([
			"src/auth/jwt-decoder.ts",
			"src/auth/security-config.ts",
			"src/auth/token-validator.ts",
			"src/messaging/audit-log.ts",
			"src/persistence/refresh-token-repository.ts",
		]);
	});
});
