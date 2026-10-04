import { describe, expect, it } from "vitest";
import { LEASE_TTL_MS, LeaseBook } from "../../src/core/leases.ts";

describe("clearance leases", () => {
	it("grants and keeps the original grant time on re-grant", () => {
		const b = new LeaseBook();
		b.grant("F1", "r", 0);
		const again = b.grant("F1", "r", 100);
		expect(again.grantedAt).toBe(0);
		expect(b.holder("r")?.flightId).toBe("F1");
	});

	it("heartbeat extends every lease of a flight", () => {
		const b = new LeaseBook();
		b.grant("F1", "a", 0);
		b.grant("F1", "b", 0);
		expect(b.heartbeat("F1", 5000)).toBe(2);
		expect(b.held("F1").every((l) => l.expiresAt === 5000 + LEASE_TTL_MS)).toBe(true);
	});

	it("expires a crashed flight's leases", () => {
		const b = new LeaseBook();
		b.grant("F1", "a", 0);
		b.grant("F2", "b", 0);
		b.heartbeat("F2", LEASE_TTL_MS - 1);
		expect(b.expired(LEASE_TTL_MS + 1)).toEqual(["F1"]);
	});

	it("releases one or all leases", () => {
		const b = new LeaseBook();
		b.grant("F1", "a", 0);
		b.grant("F1", "b", 0);
		expect(b.release("F1", "a")).toHaveLength(1);
		expect(b.retain("F1", new Set())).toHaveLength(1);
		expect(b.all()).toEqual([]);
	});
});
