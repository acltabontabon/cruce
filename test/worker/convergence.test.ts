import { expect, it } from "vitest";
import { localConvergence } from "../../tools/verification/local-host.ts";

it("converges two independently passing writers through a clean but behaviorally failing merge and fresh review", async () => {
	const result = await localConvergence();
	expect(result.behavior.merged).toMatchObject({ outcome: "fail", expectedDelayMs: 2000, observedDelayMs: 2 });
	expect(result.behavior.repaired.outcome).toBe("pass");
	expect(result.promotions.map((p) => p.to)).toEqual([result.revisions.s0, result.revisions.a1, result.revisions.b2]);
	expect(result.sources).toHaveLength(5);
	expect(result.evidence).toHaveLength(5);
	expect(result.reservations).toHaveLength(20);
}, 60_000);
