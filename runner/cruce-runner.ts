#!/usr/bin/env node
/**
 * cruce-runner — fly a real coding agent (Claude Code) under Cruce from your own machine.
 *
 * The same lifecycle as the Cloudflare Sandbox Flight workflow, over the public agent protocol:
 *
 *   launch (controller token) → clone the Flight's Artifacts repo READ-ONLY → DISCOVERY → Flight Plan
 *   → wait for clearance → EXECUTE inside clearance → publish gate → tests → land
 *   ↺ HOLD: wait · ↺ STALE: Cruce merges canonical into the Flight repo, the agent re-plans
 *
 * The runner never receives a write credential. Cruce rebuilds and pushes every commit itself.
 *
 *   node runner/cruce-runner.ts --url https://cruce.acltabontabon.workers.dev --project live \
 *     --title "Session cleanup" --description "End idle sessions automatically" [--priority normal]
 *
 * Env: CRUCE_ADMIN_TOKEN (controller token for launching), CRUCE_RUNNER_MODEL (optional Claude model).
 * Requires Node ≥ 23.6 (runs TypeScript directly), git, and the `claude` CLI signed in.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { correctionPrompt, discoveryPrompt, executionPrompt, type MissionText, replanPrompt } from "../src/worker/agents/prompts.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
const URL_BASE = (args.get("url") ?? "http://localhost:5173").replace(/\/$/, "");
const PROJECT = args.get("project") ?? "live";
const title = args.get("title");
const description = args.get("description") ?? title;
const priority = args.get("priority") ?? "normal";
const keep = args.has("keep");
if (!title) {
	console.error("usage: node runner/cruce-runner.ts --title <mission> [--description …] [--url …] [--project live] [--priority normal]");
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "cruce-runner-"));
const repoDir = join(work, "repo");
const taskDir = join(work, "task");
const binDir = join(work, "bin");
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function sh(
	cmd: string,
	argv: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
	return new Promise((res) => {
		const p = spawn(cmd, argv, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => {
			out += d;
		});
		p.stderr.on("data", (d) => {
			err += d;
		});
		p.on("close", (code) => res({ code: code ?? 1, out, err }));
	});
}

async function api<T>(path: string, body: unknown, token?: string): Promise<T> {
	const res = await fetch(`${URL_BASE}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": "cruce-runner/0.1",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(`${path}: ${data.error ?? res.status}`);
	return data;
}

async function main() {
	const admin = process.env.CRUCE_ADMIN_TOKEN;
	if (!admin) throw new Error("set CRUCE_ADMIN_TOKEN (the controller token) to launch a Flight");

	log(`launching "${title}" on ${URL_BASE} (${PROJECT})`);
	const launched = await api<{ flightId: string; flightToken: string }>(
		`/api/projects/${PROJECT}/commands`,
		{ type: "launch", runtime: "external", title, description, priority },
		admin,
	);
	const flightId = launched.flightId;
	const protocolUrl = `${URL_BASE}/api/projects/${PROJECT}/flights/${flightId}/protocol`;
	const protocol = <T>(body: unknown) => api<T>(`/api/projects/${PROJECT}/flights/${flightId}/protocol`, body, launched.flightToken);
	log(`${flightId} launched; repository forked`);

	// The agent's `cruce` CLI talks to this Flight's protocol endpoint with the Flight token.
	await sh("mkdir", ["-p", binDir, taskDir]);
	writeFileSync(join(binDir, "cruce"), `#!/bin/sh\nexec node ${resolve(here, "../sandbox/cruce-cli.mjs")} "$@"\n`, { mode: 0o755 });
	const agentEnv = { CRUCE_URL: protocolUrl, CRUCE_TOKEN: launched.flightToken, PATH: `${binDir}:${process.env.PATH}` };

	const fetchFlight = async (mode: "clone" | "fetch") => {
		const co = await protocol<{ remote: string; readToken: string; head: string }>({ op: "checkout" });
		const auth = ["-c", "credential.helper=", "-c", `http.extraHeader=Authorization: Bearer ${co.readToken}`];
		const r =
			mode === "clone"
				? await sh("git", [...auth, "clone", "--quiet", co.remote, repoDir])
				: await sh("git", [...auth, "fetch", "--quiet", co.remote, "main"], { cwd: repoDir });
		if (r.code !== 0) throw new Error(`git ${mode} failed: ${r.err.slice(-300)}`);
		return co.head;
	};
	const resetTo = async (commit: string) => {
		await fetchFlight("fetch");
		await sh("git", ["reset", "--hard", "--quiet", commit], { cwd: repoDir });
		await sh("git", ["clean", "-fdq"], { cwd: repoDir });
	};

	let base = await fetchFlight("clone");
	let publishedPlan = 0;
	log(`cloned read-only at ${base.slice(0, 7)}`);

	const heartbeat = setInterval(() => protocol({ op: "heartbeat" }).catch(() => undefined), 60_000);
	const mission: MissionText = {
		flightId,
		title: title as string,
		description: description as string,
		planPath: join(taskDir, "plan.json"),
	};

	const agent = async (label: string, prompt: string) => {
		log(`agent: ${label}…`);
		const tools = [
			"Read",
			"Edit",
			"Write",
			"Glob",
			"Grep",
			"Bash(cruce:*)",
			"Bash(npm test:*)",
			"Bash(node --test:*)",
			"Bash(git status:*)",
			"Bash(git diff:*)",
			"Bash(ls:*)",
			"Bash(cat:*)",
		];
		const r = await sh(
			"claude",
			[
				"--print",
				"--output-format",
				"json",
				"--permission-mode",
				"acceptEdits",
				"--allowedTools",
				tools.join(","),
				"--add-dir",
				taskDir,
				...(process.env.CRUCE_RUNNER_MODEL ? ["--model", process.env.CRUCE_RUNNER_MODEL] : []),
				"--",
				prompt,
			],
			{ cwd: repoDir, env: agentEnv },
		);
		let summary = r.err.slice(-300);
		try {
			const result = JSON.parse(r.out) as { result?: string; is_error?: boolean };
			summary = (result.result ?? "").split("\n").slice(-2).join(" ").slice(0, 200);
			if (result.is_error) throw new Error(summary);
		} catch (e) {
			if (r.code !== 0) throw new Error(`claude failed: ${(e as Error).message || summary}`);
		}
		log(`agent: ${label} done — ${summary}`);
	};

	try {
		await agent("discovery", discoveryPrompt(mission));
		for (let round = 1; round <= 10; round++) {
			const s = await protocol<{
				phase: string;
				planVersion: number;
				clearance: string;
				cleared: string[];
				held: { resource: string }[];
				stale: { reasons: string[] } | null;
				brief: string;
			}>({ op: "status" });
			if (!s.planVersion) throw new Error("the agent did not file a Flight Plan");
			if (["landed", "failed", "lost", "cancelled"].includes(s.phase)) {
				log(`${flightId} ${s.phase}`);
				return;
			}
			log(
				`status: ${s.clearance.toUpperCase()} · plan v${s.planVersion}${s.held.length ? ` · holding ${s.held.map((h) => h.resource).join(", ")}` : ""}${s.stale ? " · STALE" : ""}`,
			);

			if (s.stale) {
				const r = await protocol<{ head: string }>({ op: "refresh" });
				await resetTo(r.head);
				base = r.head;
				log(`baseline refreshed → ${base.slice(0, 7)}`);
				await agent(`re-plan (round ${round})`, replanPrompt(mission, s.stale.reasons, s.brief));
				continue;
			}
			if (s.clearance === "hold" || !s.cleared.length) {
				await new Promise((r) => setTimeout(r, 15_000));
				continue;
			}

			// Work is needed when nothing is published for the current plan or airspace is still held.
			const needsWork = publishedPlan < s.planVersion || s.held.length > 0;
			if (needsWork) await agent(`execute (round ${round})`, executionPrompt(mission, s.brief));
			for (let attempt = 1; needsWork && attempt <= 3; attempt++) {
				await sh("git", ["add", "-A"], { cwd: repoDir });
				const diff = await sh("git", ["diff", "--cached", "--name-status", "--no-renames", base], { cwd: repoDir });
				const files: Record<string, string | null> = {};
				for (const line of diff.out.split("\n").filter(Boolean)) {
					const [status, path] = line.split("\t");
					files[path] = status === "D" ? null : (await sh("git", ["show", `:${path}`], { cwd: repoDir })).out;
				}
				if (!Object.keys(files).length) break;
				const out = await protocol<{ approved: boolean; commit: string; summary: string; outside: { resource: string; reason: string }[] }>(
					{
						op: "publish",
						parent: base,
						message: `${title} (${flightId}, round ${round})`,
						files,
					},
				);
				log(`publish gate: ${out.summary}`);
				if (out.approved) {
					await resetTo(out.commit);
					base = out.commit;
					publishedPlan = s.planVersion;
					const t = await sh("npm", ["test"], { cwd: repoDir });
					const pass = /ℹ pass (\d+)/.exec(t.out)?.[1];
					const fail = /ℹ fail (\d+)/.exec(t.out)?.[1];
					const passed = t.code === 0;
					await protocol({
						op: "validate",
						commit: out.commit,
						passed,
						summary: `${pass ?? "?"} passed, ${fail ?? "?"} failed (npm test, external runner)`,
					});
					log(`tests: ${passed ? "passed" : "FAILED"}`);
					break;
				}
				const brief = (await protocol<{ brief: string }>({ op: "status" })).brief;
				await agent(`correct (round ${round}.${attempt})`, correctionPrompt(mission, out.outside, brief));
			}
			const landing = await protocol<{ landed: boolean; reason?: string }>({ op: "land" });
			if (landing.landed) {
				log(`${flightId} LANDED`);
				return;
			}
			log(`not landing yet: ${landing.reason}`);
			await new Promise((r) => setTimeout(r, 15_000));
		}
		throw new Error("did not land within 10 rounds");
	} catch (e) {
		await protocol({ op: "fail", reason: String((e as Error).message).slice(0, 380) }).catch(() => undefined);
		throw e;
	} finally {
		clearInterval(heartbeat);
		if (!keep) rmSync(work, { recursive: true, force: true });
	}
}

main().catch((e) => {
	console.error(`cruce-runner: ${(e as Error).message}`);
	process.exit(1);
});
