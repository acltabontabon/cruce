import type { FlightInstruction } from "../../core/domain.ts";
import { type MissionText, reroutePrompt } from "./prompts.ts";

export interface CoordinationStatus {
	phase: string;
	planVersion: number;
	clearance: string;
	brief: string;
	stale?: { reasons: string[] } | null;
	instruction?: FlightInstruction | null;
}

export const terminalStatus = (s: CoordinationStatus) => ["landed", "failed", "lost", "cancelled"].includes(s.phase);

/** A heartbeat changes neither the agent's instructions nor the work it may do. */
export function coordinationKey(s: CoordinationStatus): string {
	return JSON.stringify([
		s.phase,
		s.planVersion,
		s.clearance,
		s.brief,
		s.stale,
		s.instruction?.status === "pending" ? s.instruction.id : null,
	]);
}

/** Delivery is at least once: failed delivery leaves the persisted request pending. */
export async function deliverInstruction(
	s: CoordinationStatus,
	mission: MissionText,
	run: (prompt: string) => Promise<unknown>,
	acknowledge: (id: string) => Promise<unknown>,
): Promise<boolean> {
	if (terminalStatus(s) || s.instruction?.status !== "pending") return false;
	await run(reroutePrompt(mission, s.instruction.resources, s.brief));
	await acknowledge(s.instruction.id);
	return true;
}

/** Healthy idle time never consumes an execution attempt or lets partial-clearance leases expire. */
export async function waitForTrafficChange<T extends CoordinationStatus>(
	before: T,
	ops: {
		heartbeat(attempt: number): Promise<unknown>;
		wait(attempt: number): Promise<unknown>;
		status(attempt: number): Promise<T>;
	},
): Promise<T> {
	if (terminalStatus(before) || before.stale || before.instruction?.status === "pending") return before;
	for (let attempt = 1; ; attempt++) {
		await ops.heartbeat(attempt);
		await ops.wait(attempt);
		const current = await ops.status(attempt);
		if (
			terminalStatus(current) ||
			current.stale ||
			current.instruction?.status === "pending" ||
			coordinationKey(current) !== coordinationKey(before)
		) {
			return current;
		}
	}
}
