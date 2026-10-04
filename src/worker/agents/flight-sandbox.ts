import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { ControlTower } from "../control-tower.ts";
import type { OutboundProps } from "./outbound.ts";
import { TEST_COMMAND, validationResult } from "./validation.ts";

/**
 * One Linux sandbox per Flight (Cloudflare Containers via a Durable Object). It holds the Flight's
 * working copy and runs Claude Code. It never holds a Git write credential or the model key: all
 * egress goes through Cruce's `Outbound` policy, and Cruce publishes changes itself.
 */

const REPO = "/workspace/repo";
const TASK = "/workspace/task";
const INACTIVITY_MS = 45 * 60 * 1000;
const CHECK_MS = 20 * 1000;
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// Outbound intercepts every HTTPS request, so the Containers CA replaces the trust store.
const TRUST = { NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, CURL_CA_BUNDLE: CA, SSL_CERT_FILE: CA };

// Runs a command in its own process group, recording its pid and, when it ends, its exit code.
const TASK_SCRIPT = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;
const RUNNING_SCRIPT = `read -r pid boot <"$1" && [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && kill -0 "$pid"`;

// Collects the working tree's changes against a base commit as { path: content | null }.
const CHANGES_SCRIPT = `
const { execFileSync } = require("node:child_process");
const git = (...a) => execFileSync("git", a, { maxBuffer: 64 << 20 }).toString("utf8");
git("add", "-A");
const files = {};
for (const line of git("diff", "--cached", "--name-status", "--no-renames", process.argv[1]).split("\\n")) {
	if (!line.trim()) continue;
	const [status, path] = line.split("\\t");
	files[path] = status === "D" ? null : git("show", ":" + path);
}
process.stdout.write(JSON.stringify(files));
`;

const ResultEvent = z.object({ type: z.literal("result"), subtype: z.string(), is_error: z.boolean(), result: z.string().optional() });

export type TaskStatus =
	| { state: "none" }
	| { state: "running" }
	| { state: "lost" }
	| { state: "succeeded"; result: string }
	| { state: "failed"; error: string };

interface SandboxEnv {
	CONTROL_TOWER: DurableObjectNamespace<ControlTower>;
	CRUCE_AGENT_MODEL?: string;
}

interface Binding extends OutboundProps {
	remote: string;
	head: string;
}

export class FlightSandbox extends DurableObject<SandboxEnv> {
	private setup: Promise<void> | undefined;

	private get container(): Container {
		const c = this.ctx.container;
		if (!c) throw new Error("This deployment has no sandbox container configured");
		return c;
	}

	private get binding(): Binding {
		const b = this.ctx.storage.kv.get("binding") as Binding | undefined;
		if (!b) throw new Error("sandbox is not bound to a Flight");
		return b;
	}

	/** Bind this sandbox to a Flight and clone the Flight's repository (read access via Outbound). */
	async prepare(binding: Binding): Promise<{ head: string }> {
		if (this.ctx.storage.kv.get("released")) throw new Error("Flight sandbox released");
		if ((await this.env.CONTROL_TOWER.getByName(binding.projectId).liveStatus(binding.projectId, binding.flightId)).terminal)
			throw new Error("Flight is terminal");
		if (this.ctx.storage.kv.get("released")) throw new Error("Flight sandbox released");
		this.ctx.storage.kv.put("binding", binding);
		await this.start();
		await this.run(["rm", "-rf", REPO], "/workspace");
		const clone = await this.run(["git", "clone", "--quiet", "--", binding.remote, REPO], "/workspace", TRUST);
		if (clone.exitCode !== 0) throw new Error(`clone failed: ${clone.stderr.slice(-500)}`);
		await this.run(["git", "config", "user.name", `${binding.flightId} · Claude Code`], REPO);
		await this.run(["git", "config", "user.email", `${binding.flightId.toLowerCase()}@agents.cruce.acltabontabon.com`], REPO);
		const head = (await this.run(["git", "rev-parse", "HEAD"], REPO)).stdout.trim();
		this.ctx.storage.kv.put("binding", { ...binding, head });
		return { head };
	}

	/** Move the working copy to a commit Cruce published or merged (refresh onto a new baseline). */
	async syncTo(commit: string): Promise<{ head: string }> {
		await this.start();
		const fetched = await this.run(["git", "fetch", "--quiet", "origin", "main"], REPO, TRUST);
		if (fetched.exitCode !== 0) throw new Error(`fetch failed: ${fetched.stderr.slice(-500)}`);
		const reset = await this.run(["git", "reset", "--hard", "--quiet", commit], REPO);
		if (reset.exitCode !== 0) throw new Error(`reset failed: ${reset.stderr.slice(-300)}`);
		await this.run(["git", "clean", "-fdq"], REPO);
		this.ctx.storage.kv.put("binding", { ...this.binding, head: commit });
		return { head: commit };
	}

	/** Start Claude Code on a prompt in the background. Completion is reported to the control tower. */
	async startTask(prompt: string, label: string): Promise<"started" | "busy"> {
		return this.ctx.blockConcurrencyWhile(async () => {
			await this.start();
			if ((await this.taskStatus()).state === "running") return "busy";
			await this.run(["rm", "-rf", TASK], "/workspace");
			await this.run(["mkdir", "-p", TASK], "/workspace");
			await this.container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", TASK, ...this.agentCommand(prompt)], {
				cwd: REPO,
				env: { ...TRUST, ...this.agentEnv() },
				stdout: "ignore",
				stderr: "ignore",
			});
			this.ctx.storage.kv.put("task", label);
			await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
			return "started";
		});
	}

	async taskStatus(): Promise<TaskStatus> {
		if (!this.container.running) return this.ctx.storage.kv.get("task") === undefined ? { state: "none" } : { state: "lost" };
		const exit = await this.readText(`${TASK}/exit-code`);
		if (exit !== undefined) return this.outcome(Number.parseInt(exit, 10));
		if ((await this.readText(`${TASK}/pid`)) === undefined)
			return this.ctx.storage.kv.get("task") ? { state: "running" } : { state: "none" };
		const probe = await this.run(["/bin/sh", "-c", RUNNING_SCRIPT, "probe", `${TASK}/pid`], "/");
		if (probe.exitCode === 0) return { state: "running" };
		const late = await this.readText(`${TASK}/exit-code`);
		return late !== undefined ? this.outcome(Number.parseInt(late, 10)) : { state: "lost" };
	}

	/** The agent's uncommitted (or locally committed) work, relative to `base`. */
	async changes(base: string): Promise<Record<string, string | null>> {
		const out = await this.run(["node", "-e", CHANGES_SCRIPT, base], REPO);
		if (out.exitCode !== 0) throw new Error(`could not read changes: ${out.stderr.slice(-400)}`);
		return JSON.parse(out.stdout || "{}");
	}

	/** Validation in the Flight's own sandbox; a missing test script cannot satisfy integration. */
	async runTests(): Promise<{ passed: boolean; summary: string }> {
		await this.start();
		const hasTests = await this.run(["node", "-e", "console.log(Boolean(require('./package.json').scripts?.test))"], REPO);
		if (hasTests.exitCode !== 0) return { passed: false, summary: "Could not inspect the repository test script" };
		if (hasTests.stdout.trim() !== "true") return { passed: false, summary: "Missing test script: validation could not run" };
		const out = await this.run(["/bin/sh", "-c", TEST_COMMAND, "tests", `${TASK}/tests.log`], REPO, TRUST);
		return validationResult(out.exitCode, out.stdout);
	}

	async destroy(): Promise<void> {
		this.ctx.storage.kv.put("released", true);
		this.ctx.storage.kv.delete("task");
		if (this.ctx.container?.running) await this.ctx.container.destroy();
		this.setup = undefined;
		await this.ctx.storage.deleteAlarm();
		this.ctx.storage.kv.delete("binding");
	}

	async alarm(): Promise<void> {
		if (this.ctx.storage.kv.get("released")) {
			await this.destroy();
			return;
		}
		if (!this.ctx.container?.running) return;
		const status = await this.taskStatus();
		if (status.state === "running") {
			// Keep the Flight's clearance leases alive while the agent works.
			const b = this.binding;
			try {
				await this.env.CONTROL_TOWER.getByName(b.projectId).protocol(b.projectId, b.flightId, { op: "heartbeat" });
			} catch {
				// the next check retries
			}
			await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
			return;
		}
		const label = this.ctx.storage.kv.get("task") as string | undefined;
		this.ctx.storage.kv.delete("task");
		if (!label) return;
		const b = this.binding;
		await this.env.CONTROL_TOWER.getByName(b.projectId).agentTaskDone(b.projectId, b.flightId, label, status);
	}

	// ── internals ───────────────────────────────────────────────────────

	private agentCommand(prompt: string): string[] {
		return [
			"claude",
			"--print",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"--no-session-persistence",
			"--model",
			this.env.CRUCE_AGENT_MODEL ?? "claude-sonnet-5-5",
			"--",
			prompt,
		];
	}

	private agentEnv(): Record<string, string> {
		return {
			ANTHROPIC_API_KEY: "injected-by-cruce-outbound",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			IS_SANDBOX: "1",
		};
	}

	private async start(): Promise<void> {
		if (this.ctx.storage.kv.get("released")) throw new Error("Flight sandbox released");
		if (this.setup === undefined || !this.container.running) {
			this.setup = this.setUp().catch((e) => {
				this.setup = undefined;
				throw e;
			});
		}
		await this.setup;
		if (this.ctx.storage.kv.get("released")) {
			if (this.ctx.container?.running) await this.ctx.container.destroy();
			throw new Error("Flight sandbox released");
		}
	}

	private async setUp(): Promise<void> {
		const c = this.container;
		if (!c.running) {
			c.start({ image: c.images.agent, instance: "standard-1", enableInternet: false });
		}
		try {
			const props = {
				projectId: this.binding.projectId,
				flightId: this.binding.flightId,
				namespace: this.binding.namespace,
				repo: this.binding.repo,
			};
			// biome-ignore lint/suspicious/noExplicitAny: loopback entrypoint specialised with per-Flight props.
			const outbound = (this.ctx.exports as any).Outbound({ props }) as Fetcher;
			await c.interceptAllOutboundHttp(outbound);
			await c.interceptOutboundHttps("*", outbound);
			await c.setInactivityTimeout(INACTIVITY_MS);
		} catch (e) {
			await c.destroy();
			throw e;
		}
	}

	private async outcome(exitCode: number): Promise<TaskStatus> {
		const events = (await this.readText(`${TASK}/stdout.log`)) ?? "";
		let result: z.infer<typeof ResultEvent> | undefined;
		for (const line of events.split("\n")) {
			try {
				const parsed = ResultEvent.safeParse(JSON.parse(line));
				if (parsed.success) result = parsed.data;
			} catch {
				// not JSON
			}
		}
		if (!result)
			return {
				state: "failed",
				error: `claude exited with ${exitCode}: ${((await this.readText(`${TASK}/stderr.log`)) ?? "").slice(-1500)}`,
			};
		if (result.is_error) return { state: "failed", error: result.result ?? result.subtype };
		return { state: "succeeded", result: (result.result ?? "").slice(-2000) };
	}

	private async readText(path: string): Promise<string | undefined> {
		const out = await this.run(["cat", path], "/");
		return out.exitCode === 0 ? out.stdout : undefined;
	}

	private async run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
		const p = await this.container.exec(cmd, { cwd, env });
		const out = await p.output();
		const d = new TextDecoder();
		return { exitCode: out.exitCode, stdout: d.decode(out.stdout), stderr: d.decode(out.stderr) };
	}
}
