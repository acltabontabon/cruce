import type { FlightPlanInput, PlanResource, Priority } from "../core/domain.ts";

/**
 * The deterministic demo: three Missions against the auth-service demo repository.
 *
 * Plans and code changes are scripted so the story is identical on every run, but nothing here makes
 * decisions — the controller computes congestion, right-of-way, partial clearance, publish-gate
 * verdicts, staleness, and re-clearance exactly as it does for live agents.
 */

export interface DemoFlight {
	key: "rotation" | "jwt" | "sessions";
	flightId: string;
	mission: { title: string; description: string; priority: Priority };
	plan: FlightPlanInput;
}

export const DEMO_REPO = "auth-service";

export const ROTATION_V1: FlightPlanInput = {
	summary: "Implement refresh-token rotation",
	intent:
		"Rotate refresh tokens on every use and revoke the token family when a used token is replayed. Expose the access token id (jti) from validation so refreshes can be traced, without changing the public authentication API.",
	readSet: [{ type: "component", resource: "SecurityConfig", reason: "refresh token TTL" }],
	writeSet: [
		{ type: "symbol", resource: "AuthService.refreshToken", reason: "rotate on use" },
		{ type: "symbol", resource: "TokenValidator.validate", reason: "return the token id (jti) with claims" },
		{ type: "component", resource: "RefreshTokenRepository", reason: "token families, single-use rotation" },
	],
	contractSet: [],
	dependencies: [],
	assumptions: ["Token validation contract remains stable: validate() returns Claims | null"],
	risk: "high",
};

export const ROTATION_AMENDMENT: PlanResource[] = [
	{ type: "symbol", resource: "AuthService.logout", reason: "logout must revoke the whole token family" },
];

export const ROTATION_V2: FlightPlanInput = {
	summary: "Implement refresh-token rotation (re-planned on F-022's baseline)",
	intent:
		"Rotate refresh tokens on every use and revoke the token family on replay. F-022's ValidationResult now carries the token id, so TokenValidator no longer needs to change: read it instead.",
	readSet: [
		{ type: "symbol", resource: "TokenValidator.validate", reason: "ValidationResult.claims.jti (landed in F-022)" },
		{ type: "component", resource: "SecurityConfig", reason: "refresh token TTL" },
	],
	writeSet: [
		{ type: "symbol", resource: "AuthService.refreshToken", reason: "rotate on use, audit the new jti" },
		{ type: "symbol", resource: "AuthService.logout", reason: "revoke the token family" },
		{ type: "component", resource: "RefreshTokenRepository", reason: "token families, single-use rotation" },
	],
	contractSet: [],
	dependencies: [],
	assumptions: ["validate() returns ValidationResult with claims.jti"],
	risk: "medium",
};

export const JWT_MIGRATION: FlightPlanInput = {
	summary: "Migrate to typed JWT verification",
	intent:
		"Replace the legacy JWT decoder with typed verification: algorithm allow-list, explicit failure reasons, and a token id on every token. TokenValidator.validate will return a ValidationResult instead of Claims | null; callers are updated.",
	readSet: [{ type: "symbol", resource: "AuthService.issueAccessToken", reason: "how tokens are issued" }],
	writeSet: [
		{ type: "file", resource: "src/auth/jwt-decoder.ts", reason: "new decoder" },
		{ type: "file", resource: "src/auth/token-validator.ts", reason: "ValidationResult" },
		{ type: "component", resource: "SecurityConfig", reason: "algorithm allow-list, clock skew" },
		{ type: "symbol", resource: "AuthMiddleware.requireAuth", reason: "caller of validate()" },
		{ type: "symbol", resource: "AuthService.introspect", reason: "caller of validate()" },
	],
	contractSet: [{ resource: "TokenValidator.validate", change: "signature", note: "Claims | null → ValidationResult" }],
	dependencies: [],
	assumptions: ["HS256 remains the only signing algorithm"],
	risk: "high",
};

export const SESSION_CLEANUP: FlightPlanInput = {
	summary: "Clean up idle sessions",
	intent: "End sessions that have been idle longer than a limit, with an audit record.",
	readSet: [{ type: "component", resource: "AuditLog" }],
	writeSet: [
		{ type: "component", resource: "SessionService", reason: "cleanupExpired()" },
		{ type: "component", resource: "SessionRepository", reason: "deleteIdleSince()" },
	],
	contractSet: [],
	dependencies: [],
	assumptions: [],
	risk: "low",
};

export const DEMO_FLIGHTS: DemoFlight[] = [
	{
		key: "rotation",
		flightId: "F-021",
		mission: {
			title: "Refresh-token rotation",
			description: "Rotate refresh tokens on use and revoke a token family when a used token is replayed.",
			priority: "normal",
		},
		plan: ROTATION_V1,
	},
	{
		key: "jwt",
		flightId: "F-022",
		mission: {
			title: "JWT library migration",
			description: "Move token verification to typed results with an algorithm allow-list.",
			priority: "normal",
		},
		plan: JWT_MIGRATION,
	},
	{
		key: "sessions",
		flightId: "F-023",
		mission: { title: "Session cleanup", description: "End idle sessions automatically.", priority: "normal" },
		plan: SESSION_CLEANUP,
	},
];

/** Scripted work: which overlay each Flight commits, and the commit message. */
export const DEMO_WORK = {
	"F-023": { overlay: "f023-session-cleanup", message: "Add idle session cleanup" },
	"F-022": { overlay: "f022-jwt-migration", message: "Migrate to typed JWT verification" },
	"F-021:1": { overlay: "f021-rotation-1", message: "Add refresh token families and rotation storage" },
	"F-021:2": { overlay: "f021-rotation-2", message: "Rotate refresh tokens on use" },
} as const;

export type DemoWorkKey = keyof typeof DEMO_WORK;

const seedModules = import.meta.glob("../../demo/auth-service/**/*", { query: "?raw", import: "default", eager: true }) as Record<
	string,
	string
>;
const overlayModules = import.meta.glob("../../demo/scenario/**/*", { query: "?raw", import: "default", eager: true }) as Record<
	string,
	string
>;

/** The demo repository's files at baseline, keyed by repo-relative path. */
export function seedFiles(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, content] of Object.entries(seedModules)) {
		out[key.replace("../../demo/auth-service/", "")] = content;
	}
	return out;
}

/** The files a scripted Flight step writes, keyed by repo-relative path. */
export function overlayFiles(overlay: string): Record<string, string> {
	const prefix = `../../demo/scenario/${overlay}/`;
	const out: Record<string, string> = {};
	for (const [key, content] of Object.entries(overlayModules)) {
		if (key.startsWith(prefix)) out[key.slice(prefix.length)] = content;
	}
	return out;
}
