import { z } from "zod";
import type { ControllerState, TowerEvent } from "../core/controller.ts";
import { FlightPlanInput, PlanResource, Priority } from "../core/domain.ts";

/** Wire types shared by the Worker, the Durable Object, the UI, and external agent runners. */

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
	mode: "demo" | "live";
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
	{
		id: "live",
		name: "auth-service · live",
		repo: "auth-service-live",
		mode: "live",
		description: "Real coding agents in Cloudflare Sandboxes",
		firstFlight: 31,
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
	liveAgents: { available: boolean; reason?: string };
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
	z.object({ type: z.literal("reroute"), flightId: z.string() }),
	z.object({ type: z.literal("land"), flightId: z.string() }),
	z.object({
		type: z.literal("launch"),
		title: z.string().min(3).max(120),
		description: z.string().min(3).max(2000),
		priority: Priority.default("normal"),
		runtime: z.enum(["sandbox", "external"]).default("sandbox"),
	}),
]);
export type HumanCommand = z.infer<typeof HumanCommand>;

export const DemoCommand = z.object({
	op: z.enum(["prepare", "play", "pause", "step", "reset", "replay", "speed"]),
	speed: z.number().min(0.25).max(4).optional(),
});
export type DemoCommand = z.infer<typeof DemoCommand>;

/** The provider-neutral agent protocol (HTTP today; an MCP adapter maps 1:1 onto these ops). */
export const ProtocolRequest = z.discriminatedUnion("op", [
	z.object({ op: z.literal("status") }),
	z.object({ op: z.literal("plan"), plan: FlightPlanInput }),
	z.object({ op: z.literal("amend"), plan: FlightPlanInput, reason: z.string().max(400) }),
	z.object({ op: z.literal("request"), resources: z.array(PlanResource).min(1).max(20), reason: z.string().max(400) }),
	z.object({ op: z.literal("activity"), text: z.string().min(1).max(300) }),
	z.object({ op: z.literal("heartbeat") }),
	z.object({ op: z.literal("ack-instruction"), instructionId: z.string().min(1).max(100) }),
	z.object({
		op: z.literal("publish"),
		parent: z.string().regex(/^[0-9a-f]{40}$/),
		message: z.string().min(1).max(2000),
		files: z.record(z.string().max(400), z.string().max(1_000_000).nullable()),
		author: z.object({ name: z.string().max(100), email: z.string().max(200), timestamp: z.number().int() }).optional(),
		claimedCommit: z
			.string()
			.regex(/^[0-9a-f]{40}$/)
			.optional(),
	}),
	z.object({ op: z.literal("validate"), commit: z.string(), passed: z.boolean(), summary: z.string().max(400) }),
	z.object({ op: z.literal("land") }),
	z.object({ op: z.literal("checkout") }),
	z.object({ op: z.literal("refresh") }),
	z.object({ op: z.literal("fail"), reason: z.string().max(400) }),
]);
export type ProtocolRequest = z.infer<typeof ProtocolRequest>;
