import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import type { ControlTower } from "../control-tower.ts";
import { type CoordinationStatus, coordinationKey, deliverInstruction, waitForTrafficChange } from "./coordination.ts";
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
			// Workflows event types accept only letters, digits, '-' and '_', up to 100 characters.
			const eventLabel = label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 94);
			const started = await run(step, `agent ${label}: start`, RETRY, () => sandbox().startTask(prompt, eventLabel));
			if (started === "busy") throw new Error("sandbox busy");
			let result: TaskStatus;
			try {
				const done = await step.waitForEvent<{ status: TaskStatus }>(`agent ${label}: wait`, {
					type: `agent-${eventLabel}`,
					timeout: "45 minutes",
				});
				result = done.payload.status;
			} catch {
				result = await run(step, `agent ${label}: check`, RETRY, async () => (await sandbox().taskStatus()) as TaskStatus);
			}
			if (result.state !== "succeeded") throw new Error(`Agent task ${label} ${result.state === "failed" ? result.error : result.state}`);
			return result;
		};
		const status = (label: string) => run(step, label, RETRY, () => tower().liveStatus(projectId, flightId));
		const waitForTower = (label: string, before: CoordinationStatus) =>
			waitForTrafficChange(before, {
				heartbeat: (attempt) =>
					run(step, `${label}: heartbeat ${attempt}`, RETRY, () => tower().protocol(projectId, flightId, { op: "heartbeat" })),
				wait: async (attempt) => {
					try {
						await step.waitForEvent(`${label}: wait ${attempt}`, { type: "tower-wake", timeout: "1 minute" });
					} catch {
						/* On timeout, check terminal state and renew the next heartbeat. */
					}
				},
				status: (attempt) => status(`${label}: status ${attempt}`),
			});

		try {
			const repo = await run(step, "provision Flight repository", RETRY, () => tower().liveProvision(projectId, flightId));
			const prepared = await run(step, "start sandbox, clone read-only", { ...RETRY, timeout: "10 minutes" }, () =>
				sandbox().prepare({ projectId, flightId, namespace: repo.namespace, repo: repo.repo, remote: repo.remote, head: repo.baseCommit }),
			);
			let base = prepared.head;
			const mission = await run(step, "mission", RETRY, () => tower().liveMission(projectId, flightId));
			const deliver = (label: string, current: CoordinationStatus) =>
				deliverInstruction(
					current,
					mission,
					(prompt) => agentTask(`${label}: reroute ${current.instruction?.id}`, prompt),
					(instructionId) =>
						run(step, `${label}: acknowledge ${instructionId}`, RETRY, () =>
							tower().protocol(projectId, flightId, { op: "ack-instruction", instructionId }),
						),
				);

			const discovery = await agentTask("discovery", discoveryPrompt(mission));
			let f = await run(step, "check Flight Plan", RETRY, () => tower().liveStatus(projectId, flightId));
			if (!f.planVersion) {
				throw new Error(`no Flight Plan after discovery (${discovery.state === "failed" ? discovery.error : "agent did not file one"})`);
			}

			let executionKey: string | undefined;
			let workRounds = 0;
			rounds: for (let round = 1; workRounds < MAX_ROUNDS; round++) {
				f = await run(step, `round ${round}: status`, RETRY, () => tower().liveStatus(projectId, flightId));
				if (f.terminal) return { phase: f.phase };

				if (f.stale) {
					const refreshed = await run(step, `round ${round}: refresh baseline`, RETRY, () => tower().liveRefresh(projectId, flightId));
					await run(step, `round ${round}: sync sandbox`, RETRY, () => sandbox().syncTo(refreshed.head));
					base = refreshed.head;
					workRounds++;
					await agentTask(`replan-${round}`, replanPrompt(mission, f.stale.reasons, f.brief));
					const replanned = await status(`round ${round}: check amended plan`);
					if (replanned.terminal) return { phase: replanned.phase };
					if (replanned.planVersion <= f.planVersion) throw new Error("Agent did not file an amended plan after the baseline changed");
					continue;
				}
				if (await deliver(`round ${round}`, f)) continue;
				if (f.clearance === "hold" || f.cleared === 0) {
					await run(step, `round ${round}: holding`, RETRY, () =>
						tower().liveActivity(projectId, flightId, "Holding: waiting for clearance"),
					);
					await waitForTower(`hold ${round}`, f);
					continue;
				}

				if (!f.published || f.planVersion > f.publishedPlanVersion || coordinationKey(f) !== executionKey) {
					workRounds++;
					executionKey = coordinationKey(f);
					await agentTask(`execute-${round}`, executionPrompt(mission, f.brief));
					for (let attempt = 1; attempt <= 3; attempt++) {
						const boundary = await status(`round ${round}: before publish ${attempt}`);
						if (boundary.terminal) return { phase: boundary.phase };
						if (await deliver(`round ${round}: before publish ${attempt}`, boundary)) {
							executionKey = undefined;
							continue rounds;
						}
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
							if (!tests.passed) throw new Error(`Validation failed: ${tests.summary}`);
							break;
						}
						if (attempt === 3) throw new Error("Publish gate rejected changes after 3 attempts; unpublished changes were not integrated");
						const brief = await run(
							step,
							`round ${round}: brief (${attempt})`,
							RETRY,
							async () => (await tower().liveStatus(projectId, flightId)).brief,
						);
						await agentTask(`correct-${round}-${attempt}`, correctionPrompt(mission, out.outside, brief));
					}
				}

				const boundary = await status(`round ${round}: before integration`);
				if (boundary.terminal) return { phase: boundary.phase };
				if (await deliver(`round ${round}: before integration`, boundary)) continue;
				const landing = (await run(step, `round ${round}: request landing`, RETRY, () =>
					tower().protocol(projectId, flightId, { op: "land" }),
				)) as {
					landed: boolean;
					reason?: string;
				};
				if (landing.landed) return { phase: "landed" };
				await waitForTower(`after round ${round}`, boundary);
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
