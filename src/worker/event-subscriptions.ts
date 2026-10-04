/**
 * Artifacts repository events reach Cruce through a Queues event subscription.
 *
 * Account-level events (`repo.created|forked|deleted|imported`) need one subscription. Repository
 * events (`pushed`, `token.created`, `token.revoked`) are scoped to one repo, so Cruce subscribes each
 * Flight repository when it is forked and unsubscribes it when the Flight's repo is removed.
 *
 * Uses the event_subscriptions REST API with an API token restricted to Queues/Event Subscriptions.
 */

export interface SubscriptionConfig {
	accountId: string;
	queueId: string;
	apiToken: string;
	namespace: string;
}

const API = "https://api.cloudflare.com/client/v4";

export class EventSubscriptions {
	constructor(private readonly cfg: SubscriptionConfig) {}

	private async request<T>(method: string, path: string, body?: unknown) {
		const res = await fetch(`${API}/accounts/${this.cfg.accountId}/event_subscriptions/subscriptions${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.cfg.apiToken}`, "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		const json = (await res.json()) as {
			success: boolean;
			result: T;
			result_info?: { total_pages?: number };
			errors?: { message: string }[];
		};
		if (!res.ok || !json.success)
			throw new Error(`event subscription ${method} failed: ${json.errors?.map((e) => e.message).join("; ") ?? res.status}`);
		return json;
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		return (await this.request<T>(method, path, body)).result;
	}

	nameFor(repo: string) {
		return `cruce repo ${this.cfg.namespace}/${repo}`;
	}

	async subscribeRepo(repo: string): Promise<string> {
		const existing = await this.find(repo);
		if (existing) return existing;
		const result = await this.call<{ id: string }>("POST", "", {
			name: this.nameFor(repo),
			enabled: true,
			source: { type: "artifacts.repo", namespace: this.cfg.namespace, repo_name: repo },
			destination: { type: "queues.queue", queue_id: this.cfg.queueId },
			events: ["pushed", "token.created", "token.revoked"],
		});
		return result.id;
	}

	async unsubscribeRepo(repo: string): Promise<void> {
		for (const id of await this.findAll(repo)) {
			try {
				await this.call("DELETE", `/${id}`);
			} catch (error) {
				if (!/404|not found/i.test(String(error))) throw error;
			}
		}
	}

	private async find(repo: string): Promise<string | undefined> {
		return (await this.findAll(repo))[0];
	}

	private async findAll(repo: string): Promise<string[]> {
		const ids: string[] = [];
		for (let page = 1; ; page++) {
			const response = await this.request<{ id: string; name: string }[]>("GET", `?per_page=100&page=${page}`);
			ids.push(...response.result.filter((s) => s.name === this.nameFor(repo)).map((s) => s.id));
			if (response.result_info?.total_pages !== undefined ? page >= response.result_info.total_pages : response.result.length < 100) break;
		}
		return ids;
	}
}

/** The documented Artifacts event envelope (schema version 1). */
export interface ArtifactsEvent {
	type: string;
	source: { type: string; namespace: string; repoName: string };
	payload: {
		ref?: string;
		before?: string;
		after?: string;
		commits?: { id: string; message: string }[];
		tokenId?: string;
		scope?: string;
		repoName?: string;
	};
	metadata: { accountId: string; eventSubscriptionId: string; eventSchemaVersion: number; eventTimestamp: string };
}

export function isArtifactsEvent(body: unknown): body is ArtifactsEvent {
	const b = body as ArtifactsEvent;
	return typeof b?.type === "string" && b.type.startsWith("cf.artifacts.") && typeof b.source?.repoName === "string";
}
