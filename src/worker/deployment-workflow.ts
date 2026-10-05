import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ControlTower } from "./control-tower.ts";

export interface DeploymentParams {
	repositoryId: string;
	deploymentId: string;
}
export interface DeploymentWorkflowEnv {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
}

/** Bounded: a build that does not finish in this window is recorded as failed, never retried forever. */
export const DEPLOYMENT_POLLS = 60;
export const DEPLOYMENT_POLL_INTERVAL = "20 seconds";

/**
 * Durable orchestration for one deployment of an exact revision: wait for Workers Builds, then run
 * Cruce's own smoke checks against the result and record runtime-verified evidence. Decisions and
 * state stay in the repository's Durable Object; the Workflow only provides retries and durable waiting.
 */
export class DeploymentWorkflow extends WorkflowEntrypoint<DeploymentWorkflowEnv, DeploymentParams> {
	async run(event: WorkflowEvent<DeploymentParams>, step: WorkflowStep) {
		const { repositoryId, deploymentId } = event.payload;
		const tower = () => this.env.CONTROL_TOWER.getByName(repositoryId);
		for (let attempt = 0; attempt < DEPLOYMENT_POLLS; attempt++) {
			const state = await step.do(`observe build ${attempt}`, { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, () =>
				tower().deploymentTick(deploymentId),
			);
			if (state === "deployed" || state === "failed" || state === "superseded") return state;
			await step.sleep(`wait ${attempt}`, DEPLOYMENT_POLL_INTERVAL);
		}
		return step.do("expire", () => tower().deploymentTick(deploymentId, true));
	}
}
