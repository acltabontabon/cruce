import type { RouteRule } from "./security-config.ts";
import type { Claims, TokenValidator } from "./token-validator.ts";

export interface AuthResult {
	ok: boolean;
	status: 200 | 401 | 403;
	claims?: Claims;
}

/** Enforces SecurityConfig route rules for incoming requests. */
export class AuthMiddleware {
	private readonly validator: TokenValidator;

	constructor(validator: TokenValidator) {
		this.validator = validator;
	}

	requireAuth(authorization: string | undefined, rule: RouteRule): AuthResult {
		if (rule.auth === "public") return { ok: true, status: 200 };
		const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
		if (!token) return { ok: false, status: 401 };
		const result = this.validator.validate(token);
		if (!result.valid) return { ok: false, status: 401 };
		const claims = result.claims;
		if (rule.scope && !claims.scope.includes(rule.scope)) return { ok: false, status: 403, claims };
		return { ok: true, status: 200, claims };
	}
}
