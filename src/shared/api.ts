import { z } from "zod";
import type { ControllerState, TowerEvent } from "../core/controller.ts";

/** Wire types for the legacy deterministic coordination demo (`/demo`). */

export interface DemoStatus {
	next: number;
	total: number;
	running: boolean;
	speed: number;
	nextAt?: number;
	lastLabel?: string;
	nextLabel?: string;
	error?: string;
	finished: boolean;
}

export interface ProjectMeta {
	id: string;
	name: string;
	repo: string;
	mode: "demo";
	description: string;
	firstFlight: number;
}

export const PROJECTS: ProjectMeta[] = [
	{
		id: "demo",
		name: "auth-service",
		repo: "auth-service",
		mode: "demo",
		description: "Deterministic demo: three scripted agents",
		firstFlight: 21,
	},
];

export interface GitInfo {
	backend: "artifacts" | "local";
	namespace: string;
	canonicalRemote?: string;
}

export interface Snapshot {
	state: ControllerState;
	demo: DemoStatus | null;
	git: GitInfo;
	integrationBlockers: Record<string, string[]>;
}

export type ServerMessage =
	| ({ type: "snapshot" } & Snapshot)
	| {
			type: "update";
			state: ControllerState;
			events: TowerEvent[];
			demo: DemoStatus | null;
			integrationBlockers: Record<string, string[]>;
	  };

export interface ChangeFile {
	path: string;
	status: "added" | "modified" | "deleted";
	additions: number | null;
	deletions: number | null;
	binary: boolean;
	tooLarge: boolean;
}

/** A Git comparison pinned to actual commits; optional file content is requested separately. */
export interface ChangesResponse {
	flightId: string;
	comparison: "published" | "integrated";
	baseCommit: string | null;
	headCommit: string | null;
	canonicalCommit: string;
	files: ChangeFile[];
	additions: number;
	deletions: number;
	statsComplete: boolean;
	file?: { path: string; patch: string | null; reason?: string };
}

export const HumanCommand = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("override"),
		congestionKey: z.string(),
		kind: z.enum(["accept", "allow-both", "first", "hold-both"]),
		flightId: z.string().optional(),
	}),
	z.object({ type: z.literal("clear-override"), congestionKey: z.string() }),
	z.object({ type: z.literal("dismiss"), attentionId: z.string() }),
	z.object({ type: z.literal("cancel"), flightId: z.string() }),
	z.object({ type: z.literal("retain"), flightId: z.string(), keep: z.boolean() }),
	z.object({ type: z.literal("reroute"), flightId: z.string() }),
	z.object({ type: z.literal("land"), flightId: z.string() }),
]);
export type HumanCommand = z.infer<typeof HumanCommand>;

export const DemoCommand = z.object({
	op: z.enum(["prepare", "play", "pause", "step", "reset", "replay", "speed"]),
	speed: z.number().min(0.25).max(4).optional(),
});
export type DemoCommand = z.infer<typeof DemoCommand>;
