import type { StorageEnv } from "./artifacts.ts";
import type { ControlTower } from "./control-tower.ts";
import type { Directory } from "./directory.ts";
import { pushSignal } from "./observation.ts";

interface Env extends StorageEnv {
	DIRECTORY: DurableObjectNamespace<Directory>;
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
}
/** Only the installation Queue binding invokes this handler; HTTP has no ingestion route. */
export async function observationQueue(batch: MessageBatch<unknown>, env: Env) {
	if (!env.CRUCE_OBSERVATION_QUEUE || ![env.CRUCE_OBSERVATION_QUEUE, `${env.CRUCE_OBSERVATION_QUEUE}-dead`].includes(batch.queue)) {
		batch.retryAll();
		return;
	}
	for (const message of batch.messages) {
		try {
			const signal = pushSignal(message.body);
			if (
				!signal ||
				signal.metadata.accountId !== env.CRUCE_STORAGE_ACCOUNT_ID ||
				signal.source.namespace !== env.CRUCE_ARTIFACTS_NAMESPACE
			) {
				message.ack();
				continue;
			}
			const route = await env.DIRECTORY.getByName("namespace-directory").observationRoute(signal.metadata.eventSubscriptionId);
			if (!route) {
				message.retry({ delaySeconds: 30 });
				continue;
			}
			await env.CONTROL_TOWER.getByName(route.repositoryId).ingestObservation(message.id, signal, route, batch.queue.endsWith("-dead"));
			message.ack();
		} catch {
			message.retry({ delaySeconds: 30 });
		}
	}
}
