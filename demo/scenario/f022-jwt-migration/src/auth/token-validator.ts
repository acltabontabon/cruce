import type { JwtDecoder } from "./jwt-decoder.ts";

export interface Claims {
	sub: string;
	exp: number;
	scope: string[];
	jti?: string;
}

export type ValidationFailure = "malformed" | "unsupported-algorithm" | "signature" | "expired";

export type ValidationResult = { valid: true; claims: Claims } | { valid: false; reason: ValidationFailure };

/** Validates bearer tokens issued by AuthService. */
export class TokenValidator {
	private readonly decoder: JwtDecoder;
	private readonly now: () => number;
	private readonly clockSkewSeconds: number;

	constructor(decoder: JwtDecoder, now: () => number = Date.now, clockSkewSeconds = 0) {
		this.decoder = decoder;
		this.now = now;
		this.clockSkewSeconds = clockSkewSeconds;
	}

	/** Validates a bearer token and explains why it is rejected. */
	validate(token: string): ValidationResult {
		const result = this.decoder.verify(token);
		if (!result.ok) return { valid: false, reason: result.error };
		const { sub, exp, scope, jti } = result.token;
		if (typeof sub !== "string" || typeof exp !== "number") return { valid: false, reason: "malformed" };
		if ((exp + this.clockSkewSeconds) * 1000 <= this.now()) return { valid: false, reason: "expired" };
		return { valid: true, claims: { sub, exp, scope: scope ?? [], jti } };
	}

	hasScope(claims: Claims, scope: string): boolean {
		return claims.scope.includes(scope);
	}
}
