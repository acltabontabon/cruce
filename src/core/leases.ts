import type { Lease } from "./domain.ts";

/**
 * Clearance leases. Write clearance on contested airspace is a lease, not a lock: it expires unless
 * the Flight heartbeats, so a crashed agent cannot hold airspace forever.
 */

export const LEASE_TTL_MS = 10 * 60 * 1000;

export class LeaseBook {
	private readonly leases = new Map<string, Lease>();

	constructor(initial: Lease[] = []) {
		for (const l of initial) this.leases.set(key(l.flightId, l.resource), { ...l });
	}

	all(): Lease[] {
		return [...this.leases.values()].sort((a, b) => a.resource.localeCompare(b.resource) || a.flightId.localeCompare(b.flightId));
	}

	held(flightId: string): Lease[] {
		return this.all().filter((l) => l.flightId === flightId);
	}

	holder(resource: string): Lease | undefined {
		return this.all().find((l) => l.resource === resource);
	}

	/** Grant (or keep) a lease. Re-granting an existing lease keeps its original grant time. */
	grant(flightId: string, resource: string, now: number, ttl = LEASE_TTL_MS): Lease {
		const k = key(flightId, resource);
		const existing = this.leases.get(k);
		const lease: Lease = existing
			? { ...existing, expiresAt: Math.max(existing.expiresAt, now + ttl) }
			: { resource, flightId, grantedAt: now, heartbeatAt: now, expiresAt: now + ttl };
		this.leases.set(k, lease);
		return lease;
	}

	heartbeat(flightId: string, now: number, ttl = LEASE_TTL_MS): number {
		let renewed = 0;
		for (const [k, l] of this.leases) {
			if (l.flightId !== flightId) continue;
			this.leases.set(k, { ...l, heartbeatAt: now, expiresAt: now + ttl });
			renewed++;
		}
		return renewed;
	}

	release(flightId: string, resource?: string): Lease[] {
		const released: Lease[] = [];
		for (const [k, l] of this.leases) {
			if (l.flightId === flightId && (resource === undefined || l.resource === resource)) {
				this.leases.delete(k);
				released.push(l);
			}
		}
		return released;
	}

	/** Keep only the given resources for a flight (used when clearance shrinks). */
	retain(flightId: string, resources: Set<string>): Lease[] {
		const released: Lease[] = [];
		for (const [k, l] of this.leases) {
			if (l.flightId === flightId && !resources.has(l.resource)) {
				this.leases.delete(k);
				released.push(l);
			}
		}
		return released;
	}

	/** Flights whose leases have all lapsed (no heartbeat within TTL). */
	expired(now: number): string[] {
		const byFlight = new Map<string, boolean>();
		for (const l of this.leases.values()) {
			const alive = l.expiresAt > now;
			byFlight.set(l.flightId, (byFlight.get(l.flightId) ?? false) || alive);
		}
		return [...byFlight.entries()]
			.filter(([, alive]) => !alive)
			.map(([id]) => id)
			.sort();
	}
}

const key = (flightId: string, resource: string) => `${flightId}\u0000${resource}`;
