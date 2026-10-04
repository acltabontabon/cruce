#!/usr/bin/env node
// Cruce agent protocol CLI (runs inside the Flight sandbox).
// Requests go to http://cruce.internal, which Cruce's Outbound handler routes to this Flight's
// control tower. The sandbox holds no credentials: identity comes from the sandbox itself.
import { readFileSync } from "node:fs";

const [, , command, ...rest] = process.argv;
const flag = (name) => {
	const i = rest.indexOf(`--${name}`);
	return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

const USAGE = `cruce — coordinate with Cruce (traffic control for coding agents)

  cruce status                          your clearance: what you may modify, what is on hold, why
  cruce plan <plan.json>                file your Flight Plan (after investigating, before editing)
  cruce amend <plan.json> --reason "…"  replace your Flight Plan (e.g. after your baseline changed)
  cruce request <Resource> --reason "…" ask for more airspace, e.g. AuthService.logout,
                                        file:src/x.ts, component:SessionService
  cruce activity "<text>"               report what you are doing (one short line)

Flight Plan JSON:
  { "summary": "...", "intent": "...",
    "readSet":  [{ "type": "symbol|component|file|module", "resource": "TokenValidator.validate", "reason": "..." }],
    "writeSet": [{ "type": "symbol", "resource": "AuthService.refreshToken", "reason": "..." }],
    "contractSet": [{ "resource": "TokenValidator.validate", "change": "behavior|signature|removal" }],
    "assumptions": ["..."], "risk": "low|medium|high" }`;

// In a Cruce sandbox the egress policy routes cruce.internal to this Flight's tower. Outside a sandbox
// (external runner), CRUCE_URL + CRUCE_TOKEN point at the HTTPS protocol endpoint for the Flight.
const ENDPOINT = process.env.CRUCE_URL ?? "http://cruce.internal/protocol";
const AUTH = process.env.CRUCE_TOKEN ? { authorization: `Bearer ${process.env.CRUCE_TOKEN}` } : {};

async function call(body) {
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json", ...AUTH },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { error: text };
	}
	if (!res.ok) {
		console.error(`cruce: ${data.error ?? res.status}`);
		process.exit(1);
	}
	return data;
}

function parseResource(arg) {
	const m = /^(symbol|component|file|module):(.+)$/.exec(arg);
	return m ? { type: m[1], resource: m[2] } : { type: arg.includes("/") ? "file" : "symbol", resource: arg };
}

const print = (data) => console.log(data.brief ?? JSON.stringify(data, null, 2));

switch (command) {
	case "status":
		print(await call({ op: "status" }));
		break;
	case "plan":
		print(await call({ op: "plan", plan: JSON.parse(readFileSync(positional[0], "utf8")) }));
		break;
	case "amend":
		print(await call({ op: "amend", plan: JSON.parse(readFileSync(positional[0], "utf8")), reason: flag("reason") ?? "route amendment" }));
		break;
	case "request":
		print(await call({ op: "request", resources: positional.map(parseResource), reason: flag("reason") ?? "needed for the task" }));
		break;
	case "activity":
		await call({ op: "activity", text: positional.join(" ").slice(0, 300) });
		break;
	default:
		console.log(USAGE);
		process.exit(command ? 1 : 0);
}
