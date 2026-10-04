import type { JwtDecoder } from "./jwt-decoder.ts";

export interface Claims {
	sub: string;
	exp: number;
	scope: string[];
}

/** Validates bearer tokens issued by AuthService. */
export class TokenValidator {
	private readonly decoder: JwtDecoder;
	private readonly now: () => number;

	constructor(decoder: JwtDecoder, now: () => number = Date.now) {
		this.decoder = decoder;
		this.now = now;
	}

	/** Returns the token's claims, or null when the token is malformed, forged, or expired. */
	validate(token: string): Claims | null {
		const decoded = this.decoder.decode(token);
		if (!decoded || typeof decoded.sub !== "string") return null;
		if (decoded.exp * 1000 <= this.now()) return null;
		return { sub: decoded.sub, exp: decoded.exp, scope: decoded.scope ?? [] };
	}

	hasScope(claims: Claims, scope: string): boolean {
		return claims.scope.includes(scope);
	}
}
