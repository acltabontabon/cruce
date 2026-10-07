import { DomainError } from "../core/errors.ts";
import { boundedBody, type StorageEnv } from "./artifacts.ts";
import { diagnose } from "./diagnostics.ts";

export interface Subscription {
	id: string;
	name: string;
	enabled: boolean;
	source: { type: string; namespace: string; repo_name: string };
	destination: { type: string; queue_id: string };
	events: string[];
}
export interface SubscriptionPort {
	ensure(name: string, physical: string, previous?: string): Promise<string>;
	remove(name: string, physical: string, previous?: string): Promise<void>;
}
/** Management credential can manage subscriptions only. Git always uses the Artifacts binding. */
export class ObservationSubscriptions implements SubscriptionPort {
	constructor(
		readonly env: StorageEnv,
		readonly authorize: () => Promise<void>,
		readonly send = fetch,
	) {}
	private async request(path: string, method = "GET", body?: unknown) {
		if (!this.env.CF_EVENTS_API_TOKEN || !this.env.CRUCE_OBSERVATION_QUEUE_ID || !this.env.CRUCE_STORAGE_ACCOUNT_ID)
			throw new DomainError(503, "Observation installation is not configured");
		await this.authorize();
		// Native Worker fetch must not receive the subscription adapter as its receiver.
		const send = this.send;
		const response = await send(
			`https://api.cloudflare.com/client/v4/accounts/${this.env.CRUCE_STORAGE_ACCOUNT_ID}/event_subscriptions/subscriptions${path}`,
			{
				method,
				headers: { authorization: `Bearer ${this.env.CF_EVENTS_API_TOKEN}`, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		);
		if (response.status === 404) return undefined;
		if (!response.ok) {
			diagnose("provider_error", { provider: "rest", action: "observation.read", status: response.status });
			throw new DomainError(503, "Observation subscription service unavailable");
		}
		const data = JSON.parse(
			new TextDecoder().decode(await boundedBody(response, 1024 * 1024, "Observation subscription inventory exceeds its limit")),
		);
		if (data.success === false) throw new DomainError(503, "Observation subscription service unavailable");
		return data;
	}
	private matches(s: Subscription, name: string, physical: string) {
		return (
			s.name === name &&
			s.source.type === "artifacts.repo" &&
			s.source.namespace === this.env.CRUCE_ARTIFACTS_NAMESPACE &&
			s.source.repo_name === physical &&
			s.destination.type === "queues.queue" &&
			s.destination.queue_id === this.env.CRUCE_OBSERVATION_QUEUE_ID &&
			s.events.length === 1 &&
			s.events[0] === "pushed"
		);
	}
	private async find(name: string, physical: string, previous?: string): Promise<Subscription | undefined> {
		if (previous) {
			const item = (await this.request(`/${encodeURIComponent(previous)}`))?.result as Subscription | undefined;
			if (item) {
				if (!this.matches(item, name, physical)) throw new DomainError(409, "Observation subscription identity changed");
				return item;
			}
		}
		let found: Subscription | undefined;
		for (let page = 1; page <= 20; page++) {
			const data = await this.request(`?page=${page}&per_page=100`);
			if (!data || !Array.isArray(data.result)) throw new DomainError(503, "Observation subscription inventory is incomplete");
			for (const item of data.result as Subscription[])
				if (item.name === name) {
					if (!this.matches(item, name, physical) || found) throw new DomainError(409, "Observation subscription identity changed");
					found = item;
				}
			if (data.result.length < 100 || (typeof data.result_info?.total_pages === "number" && page >= data.result_info.total_pages))
				return found;
		}
		throw new DomainError(503, "Observation subscription inventory is incomplete");
	}
	async ensure(name: string, physical: string, previous?: string) {
		const old = await this.find(name, physical, previous);
		if (old) {
			if (!old.enabled) throw new DomainError(409, "Observation subscription is disabled");
			return old.id;
		}
		const data = await this.request("", "POST", {
			name,
			enabled: true,
			source: { type: "artifacts.repo", namespace: this.env.CRUCE_ARTIFACTS_NAMESPACE, repo_name: physical },
			destination: { type: "queues.queue", queue_id: this.env.CRUCE_OBSERVATION_QUEUE_ID },
			events: ["pushed"],
		});
		const item = data?.result as Subscription | undefined;
		if (!item?.id || !this.matches(item, name, physical)) throw new DomainError(503, "Observation subscription creation is uncertain");
		return item.id;
	}
	async remove(name: string, physical: string, previous?: string) {
		const item = await this.find(name, physical, previous);
		if (item) await this.request(`/${encodeURIComponent(item.id)}`, "DELETE");
	}
}
