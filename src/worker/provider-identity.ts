import { DomainError } from "../core/errors.ts";
import type { RepositoryState } from "../shared/platform.ts";
import type { Store } from "./store.ts";

/** An address/installation mismatch blocks recovery without rejecting reviewed source. */
export class ProviderIdentityError extends DomainError {
	constructor(message: string) {
		super(409, message);
	}
}

/** Repository-owned journal, saved independently of command receipts and source effects. */
export class ProviderIdentity {
	constructor(readonly store: Store) {}
	expected(name: string): string | undefined {
		const recorded = this.store.get<string>(`provider-repository:${name}`);
		const state = this.store.get<RepositoryState>("repository");
		const existing = [state?.canonical, ...(state?.workspaces.map((w) => w.fork) ?? [])].filter((r) => r?.name === name);
		const retained = state?.artifacts.filter((a) => a.storage.repository === name) ?? [];
		const ids = new Set([recorded, ...existing.map((r) => r?.id), ...retained.map((a) => a.storage.providerId)].filter(Boolean));
		if (ids.size > 1) throw new ProviderIdentityError("Recorded provider repository identities disagree");
		if (!ids.size && (existing.length || retained.length))
			throw new ProviderIdentityError("Recorded storage identity is unavailable; administrator reconciliation required");
		return recorded ?? existing[0]?.id ?? retained[0]?.storage.providerId;
	}
	check(name: string, id: string) {
		const expected = this.expected(name);
		if (!id || (expected && expected !== id)) throw new ProviderIdentityError("Artifacts repository identity changed");
	}
	record(name: string, id: string) {
		this.check(name, id);
		if (!this.store.get(`provider-repository:${name}`)) this.store.put(`provider-repository:${name}`, id);
	}
	require(name: string) {
		if (!this.expected(name)) throw new ProviderIdentityError("Provider repository identity unavailable");
	}
}
