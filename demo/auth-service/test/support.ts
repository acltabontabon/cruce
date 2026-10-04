import { AuthService } from "../src/auth/auth-service.ts";
import { JwtDecoder } from "../src/auth/jwt-decoder.ts";
import { AuthMiddleware } from "../src/auth/middleware.ts";
import { SecurityConfig } from "../src/auth/security-config.ts";
import { TokenValidator } from "../src/auth/token-validator.ts";
import { AuditLog } from "../src/messaging/audit-log.ts";
import { RefreshTokenRepository } from "../src/persistence/refresh-token-repository.ts";
import { SessionRepository } from "../src/persistence/session-repository.ts";
import { SessionService } from "../src/sessions/session-service.ts";

export function createSystem() {
	const clock = { now: Date.UTC(2026, 9, 14, 9, 0, 0) };
	const now = () => clock.now;
	const decoder = new JwtDecoder("test-secret");
	const validator = new TokenValidator(decoder, now);
	const config = new SecurityConfig();
	const refreshTokens = new RefreshTokenRepository();
	const audit = new AuditLog(now);
	const users = new Map([["ada", "lovelace"]]);
	const auth = new AuthService({ decoder, validator, config, refreshTokens, audit, users, now });
	const middleware = new AuthMiddleware(validator);
	const sessionRepository = new SessionRepository();
	const sessions = new SessionService(sessionRepository, audit, now);
	return { clock, decoder, validator, config, refreshTokens, audit, auth, middleware, sessionRepository, sessions };
}
