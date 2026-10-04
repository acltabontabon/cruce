import { describe, expect, it } from "vitest";
import { readRoute } from "../../src/ui/App.tsx";

describe("scope deep links", () => {
	it.each(["invalid", "m:", "f:", "s:src/auth.ts", "s:src/auth.ts#", "s:#validate", "s:src/auth.ts#validate#extra"])(
		"ignores malformed scope %s instead of passing it to resource parsing",
		(scope) => {
			expect(readRoute(`?scope=${encodeURIComponent(scope)}`).selection).toBeNull();
		},
	);

	it.each(["m:auth", "f:src/auth/token-validator.ts", "s:src/auth/token-validator.ts#TokenValidator.validate"])(
		"preserves a valid %s scope link",
		(scope) => {
			expect(readRoute(`?project=demo&view=traffic&scope=${encodeURIComponent(scope)}`)).toMatchObject({
				projectId: "demo",
				view: "traffic",
				selection: { kind: "resource", id: scope },
			});
		},
	);
});
