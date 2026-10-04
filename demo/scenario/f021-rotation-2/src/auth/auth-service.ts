import { randomUUID } from "node:crypto";
import type { AuditLog } from "../messaging/audit-log.ts";
import type { RefreshTokenRepository } from "../persistence/refresh-token-repository.ts";
import type { JwtDecoder } from "./jwt-decoder.ts";
import type { SecurityConfig } from "./security-config.ts";
import type { Claims, TokenValidator } from "./token-validator.ts";

export interface Credentials {
	username: string;
	password: string;
}

export interface TokenPair {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

export interface AuthServiceDeps {
	decoder: JwtDecoder;
	validator: TokenValidator;
	config: SecurityConfig;
	refreshTokens: RefreshTokenRepository;
	audit: AuditLog;
	users: Map<string, string>;
	now?: () => number;
}

/** Issues, refreshes, and revokes tokens. */
export class AuthService {
	private readonly deps: AuthServiceDeps;
	private readonly now: () => number;

	constructor(deps: AuthServiceDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	/** Returns the claims of a valid access token, for token introspection. */
	introspect(accessToken: string): Claims | null {
		const result = this.deps.validator.validate(accessToken);
		return result.valid ? result.claims : null;
	}

	login(credentials: Credentials): TokenPair | null {
		const expected = this.deps.users.get(credentials.username);
		if (expected === undefined || expected !== credentials.password) {
			this.deps.audit.record({ type: "login.failed", userId: credentials.username });
			return null;
		}
		const refreshToken = randomUUID();
		this.deps.refreshTokens.save({
			token: refreshToken,
			userId: credentials.username,
			expiresAt: this.now() + this.deps.config.refreshTokenTtlSeconds * 1000,
		});
		this.deps.audit.record({ type: "login.succeeded", userId: credentials.username });
		return {
			accessToken: this.issueAccessToken(credentials.username),
			refreshToken,
			expiresIn: this.deps.config.accessTokenTtlSeconds,
		};
	}

	/**
	 * Rotates the refresh token: each one is single-use, and presenting a used token again revokes
	 * the whole family. The new access token's id (jti) is recorded so a family can be traced.
	 */
	refreshToken(refreshToken: string): TokenPair | null {
		const record = this.deps.refreshTokens.find(refreshToken);
		if (!record || record.expiresAt <= this.now()) return null;
		const next = {
			token: randomUUID(),
			userId: record.userId,
			expiresAt: this.now() + this.deps.config.refreshTokenTtlSeconds * 1000,
		};
		const rotation = this.deps.refreshTokens.rotate(refreshToken, next, this.now());
		if (rotation.status === "reused") {
			this.deps.audit.record({ type: "token.reuse-detected", userId: record.userId, detail: `family=${rotation.family}` });
			return null;
		}
		if (rotation.status !== "rotated") return null;
		const accessToken = this.issueAccessToken(record.userId);
		const issued = this.deps.validator.validate(accessToken);
		this.deps.audit.record({
			type: "token.refreshed",
			userId: record.userId,
			detail: issued.valid ? `jti=${issued.claims.jti}` : undefined,
		});
		return { accessToken, refreshToken: next.token, expiresIn: this.deps.config.accessTokenTtlSeconds };
	}

	/** Ends the login: revokes every refresh token descended from it. */
	logout(refreshToken: string): void {
		const record = this.deps.refreshTokens.find(refreshToken);
		if (!record) return;
		this.deps.refreshTokens.revokeFamily(record.family ?? record.token);
		this.deps.audit.record({ type: "logout", userId: record.userId });
	}

	private issueAccessToken(userId: string): string {
		return this.deps.decoder.encode({
			sub: userId,
			exp: Math.floor(this.now() / 1000) + this.deps.config.accessTokenTtlSeconds,
			scope: ["sessions:read"],
		});
	}
}
