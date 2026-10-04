import { WorkerEntrypoint } from "cloudflare:workers";
import { ProtocolRequest } from "../../shared/api.ts";
import type { ControlTower } from "../control-tower.ts";

/**
 * Egress policy for a Flight's sandbox. The container starts with `enableInternet: false`, and every
 * HTTP(S) request it makes is routed here. This is where Cruce's least-privilege model is enforced:
 *
 *   cruce.internal               → the agent protocol for THIS Flight only (identity = the sandbox)
 *   <acct>.artifacts.cloudflare.net, this Flight's repo, git-upload-pack only
 *                                → a short-lived READ token is injected (never visible to the sandbox)
 *   git-receive-pack             → refused: Cruce is the only writer; changes go through the publish gate
 *   api.anthropic.com            → the model key is injected here; the sandbox holds a placeholder
 *   anything else                → 403
 */

export interface OutboundProps {
	projectId: string;
	flightId: string;
	namespace: string;
	repo: string;
}

interface OutboundEnv {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
	ANTHROPIC_API_KEY?: string;
	AI_GATEWAY_URL?: string;
}

const deny = (reason: string, status = 403) => new Response(`${reason}\n`, { status, headers: { "content-type": "text/plain" } });

export class Outbound extends WorkerEntrypoint<OutboundEnv, OutboundProps> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const props = this.ctx.props;
		const tower = this.env.CONTROL_TOWER.getByName(props.projectId);

		if (url.hostname === "cruce.internal") {
			if (request.method !== "POST" || url.pathname !== "/protocol") return deny("POST /protocol only", 404);
			const parsed = ProtocolRequest.safeParse(await request.json().catch(() => null));
			if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
			try {
				return Response.json(await tower.protocol(props.projectId, props.flightId, parsed.data));
			} catch (e) {
				return Response.json({ error: (e as Error).message }, { status: 409 });
			}
		}

		if (url.protocol !== "https:") return deny(`${url.hostname} is reachable only over HTTPS`);

		if (url.hostname.endsWith(".artifacts.cloudflare.net")) {
			const prefix = `/git/${props.namespace}/${props.repo}.git/`;
			if (!url.pathname.startsWith(prefix)) return deny("this sandbox may only read its own Flight repository");
			const service = url.searchParams.get("service") ?? url.pathname.slice(prefix.length);
			if (service.includes("receive-pack")) {
				return deny("push refused: Cruce is the only writer. Leave changes uncommitted; Cruce publishes them through the publish gate.");
			}
			if (!service.includes("upload-pack")) return deny("unsupported git service");
			const token = await tower.readToken(props.projectId, props.flightId);
			const headers = new Headers(request.headers);
			headers.set("authorization", `Bearer ${token}`);
			return fetch(new Request(request, { headers }));
		}

		if (url.hostname === "api.anthropic.com" || (this.env.AI_GATEWAY_URL && request.url.startsWith(this.env.AI_GATEWAY_URL))) {
			if (!this.env.ANTHROPIC_API_KEY) return deny("model access is not configured for this deployment", 503);
			const headers = new Headers(request.headers);
			headers.delete("authorization");
			headers.set("x-api-key", this.env.ANTHROPIC_API_KEY);
			return fetch(new Request(request, { headers }));
		}

		return deny(`${url.hostname} is not reachable from a Cruce sandbox`);
	}
}
