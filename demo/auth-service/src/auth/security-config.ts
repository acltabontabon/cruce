export interface RouteRule {
	path: string;
	auth: "public" | "token";
	scope?: string;
}

/** HTTP security settings for the service. */
export class SecurityConfig {
	readonly accessTokenTtlSeconds = 900;
	readonly refreshTokenTtlSeconds = 60 * 60 * 24 * 14;

	configureHttpSecurity(): RouteRule[] {
		return [
			{ path: "/login", auth: "public" },
			{ path: "/token/refresh", auth: "public" },
			{ path: "/sessions", auth: "token", scope: "sessions:read" },
			{ path: "/admin", auth: "token", scope: "admin" },
		];
	}

	ruleFor(path: string): RouteRule | undefined {
		return this.configureHttpSecurity().find((rule) => path === rule.path || path.startsWith(`${rule.path}/`));
	}
}
