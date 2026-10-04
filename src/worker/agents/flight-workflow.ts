import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import type { ControlTower } from "../control-tower.ts";
import type { FlightSandbox, TaskStatus } from "./flight-sandbox.ts";
import { correctionPrompt, discoveryPrompt, executionPrompt, replanPrompt } from "./prompts.ts";

/**
 * The durable lifecycle of one live Flight:
 *
 *   provision fork → sandbox + clone (read-only) → DISCOVERY → Flight Plan → wait for clearance
 *     → EXECUTE inside clearance → publish gate (correct / request airspace) → tests → land
 *     ↺ on HOLD: wait for the tower    ↺ on STALE: refresh baseline, re-plan, continue
 *
 * The control tower makes every decision; this workflow only moves the agent between states and
 * survives restarts. Waits use `step.waitForEvent`, so a held Flight costs nothing while it waits.
 */

export interface FlightParams {
	projectId: string;
	flightId: string;
}

interface WorkflowEnv {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
	FLIGHT_SANDBOX: DurableObjectNamespace<FlightSandbox>;
}

/** RPC results carry stub types; workflow steps persist plain JSON. */
type Plain<T> = T extends object ? { [K in keyof T as K extends symbol ? never : K]: T[K] } : T;

function run<T>(step: WorkflowStep, name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<Plain<T>> {
	return step.do(name, config, async () => JSON.parse(JSON.stringify((await fn()) ?? null)) as never) as Promise<Plain<T>>;
}

const RETRY = { retries: { limit: 2, delay: "10 seconds" as const, backoff: "linear" as const }, timeout: "5 minutes" as const };
const MAX_ROUNDS = 8;

export class FlightWorkflow extends WorkflowEntrypoint<WorkflowEnv, FlightParams> {
	async run(event: WorkflowEvent<FlightParams>, step: WorkflowStep) {
		const { projectId, flightId } = event.payload;
		const tower = () => this.env.CONTROL_TOWER.getByName(projectId);
		const sandbox = () => this.env.FLIGHT_SANDBOX.getByName(`${projectId}-${flightId}`);

		/** Run one agent task in the sandbox and wait (durably) until the sandbox reports it finished. */
		const agentTask = async (label: string, prompt: string): Promise<TaskStatus> => {
			const started = await run(step, `agent ${label}: start`, RETRY, () => sandbox().startTask(prompt, label));
			if (started === "busy") throw new Error("sandbox busy");
			try {
				const done = await step.waitForEvent<{ status: TaskStatus }>(`agent ${label}: wait`, {
					type: `agent-${label}`,
					timeout: "45 minutes",
				});
				return done.payload.status;
			} catch {
				return run(step, `agent ${label}: check`, RETRY, async () => (await sandbox().taskStatus()) as TaskStatus);
			}
		};
		const waitForTower = async (label: string) => {
			try {
				await step.waitForEvent(`tower: ${label}`, { type: "tower-wake", timeout: "2 hours" });
			} catch {
				// timed out: re-check status anyway
			}
		};

		try {
			const repo = await run(step, "provision Flight repository", RETRY, () => tower().liveProvision(projectId, flightId));
			const prepared = await run(step, "start sandbox, clone read-only", { ...RETRY, timeout: "10 minutes" }, () =>
				sandbox().prepare({ projectId, flightId, namespace: repo.namespace, repo: repo.repo, remote: repo.remote, head: repo.baseCommit }),
			);
			let base = prepared.head;
			const mission = await run(step, "mission", RETRY, () => tower().liveMission(projectId, flightId));

			const discovery = await agentTask("discovery", discoveryPrompt(mission));
			let f = await run(step, "check Flight Plan", RETRY, () => tower().liveStatus(projectId, flightId));
			if (!f.planVersion) {
				throw new Error(`no Flight Plan after discovery (${discovery.state === "failed" ? discovery.error : "agent did not file one"})`);
			}

			for (let round = 1; round <= MAX_ROUNDS; round++) {
				f = await run(step, `round ${round}: status`, RETRY, () => tower().liveStatus(projectId, flightId));
				if (f.terminal) return { phase: f.phase };

				if (f.stale) {
					const refreshed = await run(step, `round ${round}: refresh baseline`, RETRY, () => tower().liveRefresh(projectId, flightId));
					await run(step, `round ${round}: sync sandbox`, RETRY, () => sandbox().syncTo(refreshed.head));
					base = refreshed.head;
					await agentTask(`replan-${round}`, replanPrompt(mission, f.stale.reasons, f.brief));
					continue;
				}
				if (f.clearance === "hold" || f.cleared === 0) {
					await run(step, `round ${round}: holding`, RETRY, () =>
						tower().liveActivity(projectId, flightId, "Holding: waiting for clearance"),
					);
					await waitForTower(`hold ${round}`);
					continue;
				}

				if (!f.published || f.held > 0 || f.planVersion > f.publishedPlanVersion) {
					await agentTask(`execute-${round}`, executionPrompt(mission, f.brief));
					for (let attempt = 1; attempt <= 3; attempt++) {
						const files = await run(step, `round ${round}: collect changes (${attempt})`, RETRY, () => sandbox().changes(base));
						if (!Object.keys(files).length) break;
						const out = (await run(step, `round ${round}: publish gate (${attempt})`, RETRY, () =>
							tower().protocol(projectId, flightId, {
								op: "publish",
								parent: base,
								message: `${mission.title} (${flightId}, round ${round})`,
								files,
							}),
						)) as { approved: boolean; commit: string; outside: { resource: string; reason: string }[] };
						if (out.approved) {
							base = out.commit;
							await run(step, `round ${round}: sync to published commit`, RETRY, () => sandbox().syncTo(out.commit));
							const tests = await run(step, `round ${round}: tests in sandbox`, { ...RETRY, timeout: "10 minutes" }, () =>
								sandbox().runTests(),
							);
							await run(step, `round ${round}: report validation`, RETRY, () =>
								tower().protocol(projectId, flightId, { op: "validate", commit: out.commit, passed: tests.passed, summary: tests.summary }),
							);
							break;
						}
						const brief = await run(
							step,
							`round ${round}: brief (${attempt})`,
							RETRY,
							async () => (await tower().liveStatus(projectId, flightId)).brief,
						);
						await agentTask(`correct-${round}-${attempt}`, correctionPrompt(mission, out.outside, brief));
					}
				}

				const landing = (await run(step, `round ${round}: request landing`, RETRY, () =>
					tower().protocol(projectId, flightId, { op: "land" }),
				)) as {
					landed: boolean;
					reason?: string;
				};
				if (landing.landed) return { phase: "landed" };
				await waitForTower(`after round ${round}`);
			}
			throw new Error(`did not land within ${MAX_ROUNDS} rounds`);
		} catch (e) {
			const reason = (e as Error).message ?? String(e);
			await run(step, "report failure", RETRY, () => tower().protocol(projectId, flightId, { op: "fail", reason: reason.slice(0, 380) }));
			throw e;
		} finally {
			await run(step, "release sandbox", RETRY, () => sandbox().destroy());
		}
	}
}
