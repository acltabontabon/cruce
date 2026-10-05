import { z } from "zod";
import { DomainError, domainStatus } from "../core/errors.ts";
import { type AuthProps, authRoute, oauthProvider } from "./auth.ts";
import { bridgeRoute } from "./bridge-auth.ts";
import { json, type PlatformEnv, platformRoute } from "./platform-router.ts";

export { ControlTower } from "./control-tower.ts";
export { DeploymentWorkflow } from "./deployment-workflow.ts";
export { Directory } from "./directory.ts";
export { WorkspaceRuntime } from "./workspace-runtime.ts";

function failure(error: unknown) {
	const status = domainStatus(error) ?? (error instanceof z.ZodError ? 400 : 500);
	return json(
		{ error: status === 500 ? "Operation unavailable; retry with the same operation identity" : (error as Error).message },
		status,
	);
}
const consoleHandler = {
	async fetch(request, env, ctx) {
		try {
			return (
				(await bridgeRoute(request, env, ctx)) ??
				(await authRoute(request, env)) ??
				(await platformRoute(request, env, ctx)) ??
				json({ error: "Not found" }, 404)
			);
		} catch (error) {
			return failure(error);
		}
	},
} satisfies ExportedHandler<PlatformEnv>;
const api = {
	async fetch(request, env, ctx) {
		try {
			const auth = ctx as ExecutionContext & { props: AuthProps; auth: { scope: string[] } };
			if (!auth.auth?.scope.includes("cruce:read")) throw new DomainError(403, "Read scope required");
			return (await platformRoute(request, env, ctx, auth.props, auth.auth.scope)) ?? json({ error: "Not found" }, 404);
		} catch (error) {
			return failure(error);
		}
	},
} satisfies ExportedHandler<PlatformEnv>;
export default {
	fetch(request, env, ctx) {
		const url = new URL(request.url),
			terminal = url.searchParams.get("terminal");
		// The existing /mcp transport exception also carries the separately authenticated human bridge.
		// Browser approval stays behind Access; no additional hostname bypass is needed.
		if (url.pathname === "/mcp" && ["start", "poll", "command"].includes(terminal ?? "")) {
			url.pathname = `/bridge/${terminal}`;
			url.search = "";
			return consoleHandler.fetch(new Request(url, request) as Parameters<typeof consoleHandler.fetch>[0], env, ctx);
		}
		return oauthProvider(api, consoleHandler, env.CRUCE_PUBLIC_ORIGIN ?? new URL(request.url).origin).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<PlatformEnv>;
