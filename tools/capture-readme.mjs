// Records the README's media from the local fixture: the homepage hero and story, the console lane map
// replaying a promotion, and the review-note loop between a reviewer and the owner's agent.
// Usage: node tools/capture-readme.mjs [outDir]  (needs ffmpeg on PATH)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startFixtureServer } from "../test/browser/server.mjs";

const out = resolve(process.argv[2] ?? "docs/images/readme");
const work = mkdtempSync(join(tmpdir(), "cruce-readme-"));
mkdirSync(out, { recursive: true });
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { cwd: work, stdio: "inherit" });
const pad = (box, x, y = x) => ({ x: box.x - x, y: box.y - y, width: box.width + x * 2, height: box.height + y * 2 });

// A visible pointer, so a recording shows where each click lands.
const pointer = () => {
	addEventListener("DOMContentLoaded", () => {
		const dot = document.createElement("div");
		dot.style.cssText =
			"position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(37,99,235,.28);border:2px solid rgba(37,99,235,.85);pointer-events:none;z-index:2147483647;transition:transform .12s";
		document.body.append(dot);
		addEventListener("mousemove", (e) => dot.style.setProperty("translate", `${e.clientX + 40}px ${e.clientY + 40}px`), true);
		addEventListener("mousedown", () => (dot.style.transform = "scale(.7)"), true);
		addEventListener("mouseup", () => (dot.style.transform = ""), true);
	});
};

// Screencast frames keep the device pixel ratio that video recording loses.
async function record(page, run) {
	const cdp = await page.context().newCDPSession(page);
	const shots = [];
	cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
		shots.push({ data, time: metadata.timestamp });
		void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
	});
	await cdp.send("Page.startScreencast", { format: "png", maxWidth: 4000, maxHeight: 4000, everyNthFrame: 1 });
	await run();
	await cdp.send("Page.stopScreencast");
	await cdp.detach();
	return shots;
}

// Variable frame timing becomes an ffmpeg concat list; the last frame holds before the loop restarts.
function encode(name, shots, { viewport, clip, width, fps = 12, colors = 96 }) {
	const dir = join(work, name);
	mkdirSync(dir);
	const file = (i) => `${dir}/f${String(i).padStart(5, "0")}.png`;
	const list = shots.map((shot, i) => {
		writeFileSync(file(i), Buffer.from(shot.data, "base64"));
		return `file '${file(i)}'\nduration ${((shots[i + 1]?.time ?? shot.time + 2) - shot.time).toFixed(3)}`;
	});
	writeFileSync(join(dir, "list.txt"), `${list.join("\n")}\nfile '${file(shots.length - 1)}'\n`);
	const scale = Buffer.from(shots[0].data, "base64").readUInt32BE(16) / viewport.width;
	const even = (value) => Math.floor((value * scale) / 2) * 2;
	const crop = clip ? `crop=${even(clip.width)}:${even(clip.height)}:${even(clip.x)}:${even(clip.y)},` : "";
	ffmpeg(
		...["-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-vf"],
		`${crop}fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
		...["-loop", "0", join(out, `${name}.gif`)],
	);
}

const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
const open = async (viewport) => {
	await fetch(`${server.origin}/__fixture/reset`, { method: "POST" });
	const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
	await page.addInitScript(pointer);
	return page;
};
// Glide to an element before clicking it, as a person would.
const click = async (page, locator) => {
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
	await page.waitForTimeout(250);
	await locator.click();
};
const type = async (page, locator, text) => {
	await click(page, locator);
	await locator.pressSequentially(text, { delay: 35 });
};

try {
	// 1. Homepage: the hero as a still, then the story played once from the start.
	{
		const viewport = { width: 1440, height: 900 };
		const page = await open(viewport);
		await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
		await page.goto(server.origin);
		await page.getByText("is in early development.").waitFor();
		await page.evaluate(() => document.fonts.ready);
		const hero = page.locator(".landing-hero");
		await hero.scrollIntoViewIfNeeded();
		await page.waitForTimeout(2500);
		await page.screenshot({ path: join(work, "hero.png"), clip: pad(await hero.boundingBox(), 48, 0) });
		ffmpeg("-i", join(work, "hero.png"), "-vf", "scale=1600:-1:flags=lanczos", "-q:v", "3", join(out, "hero.jpg"));

		// The story advances only while it is in view, so centre it and let it run once from the start.
		const story = page.locator(".hero-sequence");
		await story.evaluate((element) => element.scrollIntoView({ block: "center" }));
		await story.getByRole("button", { name: "Baseline", exact: true }).click();
		await story.getByRole("button", { name: "Play", exact: true }).click();
		await page.mouse.move(4, 4);
		const clip = pad(await story.boundingBox(), 24);
		const shots = await record(page, async () => {
			await story.getByRole("button", { name: "Replay", exact: true }).waitFor({ timeout: 60_000 });
			await page.waitForTimeout(2500);
		});
		encode("story", shots, { viewport, clip, width: 800, colors: 64 });
		await page.close();
	}

	// 2. Review notes: the agent's cited answer is checked and resolved by a human, and what is left goes back to the agent.
	{
		const viewport = { width: 1280, height: 860 };
		const page = await open(viewport);
		await page.request.post(`${server.origin}/__fixture/scenario`, { data: { name: "review" } });
		await page.goto(`${server.origin}/?namespace=fernloop&repository=payments`);
		const row = page.locator(".change-row").filter({ hasText: "Bounded retry policy with backoff" });
		await row.waitFor();
		await page.evaluate(() => document.fonts.ready);
		const shots = await record(page, async () => {
			await page.waitForTimeout(1200);
			await click(page, row);
			await page.getByRole("status").getByText("Your agent answered 1 concern; 1 still open.", { exact: true }).waitFor();
			await page.waitForTimeout(1800);
			await click(page, page.getByRole("button", { name: "Check the answers", exact: true }));
			const answered = page.locator(".rv-note").filter({ hasText: "Three immediate attempts" });
			await answered.getByText("Answered. Check the code, then resolve or reply.", { exact: true }).waitFor();
			await page.waitForTimeout(3200);
			await click(page, answered.getByRole("button", { name: "Resolve", exact: true }));
			await type(page, answered.getByLabel("Reason for resolving", { exact: true }), "Verified the backoff and its cap");
			await page.waitForTimeout(500);
			await click(page, answered.getByRole("button", { name: "Resolve", exact: true }));
			await page.getByRole("status").getByText("1 concern waits for your changes.", { exact: true }).waitFor();
			await page.evaluate(() => scrollTo({ top: 0, behavior: "smooth" }));
			await page.waitForTimeout(1600);
			await click(page, page.getByRole("button", { name: "Hand to your agent", exact: true }));
			await page.getByRole("region", { name: "Review step", exact: true }).getByText("address_review_notes", { exact: true }).waitFor();
			await page.waitForTimeout(4500);
		});
		encode("review-notes", shots, { viewport, width: 1000 });
		await page.close();
	}

	// 3. Lane map: approve and promote one change, then replay the repository's history on the Workspaces tab.
	{
		const viewport = { width: 1280, height: 900 };
		const page = await open(viewport);
		await page.goto(`${server.origin}/?namespace=fernloop&repository=payments`);
		await page.locator(".change-row").filter({ hasText: "Bounded retry policy" }).click();
		await page.getByRole("button", { name: "Record result", exact: true }).click();
		const step = page.getByRole("region", { name: "Review step", exact: true });
		await step.getByRole("button", { name: "Record checked tests pass", exact: true }).click();
		await page.getByRole("button", { name: "Approve", exact: true }).click();
		await page.getByRole("button", { name: "Promote to main", exact: true }).click();
		await page.locator(".change-header").getByText("Promoted", { exact: true }).waitFor();
		await page
			.getByRole("navigation", { name: "Repository navigation" })
			.getByRole("button", { name: /^Workspaces/ })
			.click();
		const map = page.locator(".lane-map");
		await map.locator(".lane").first().waitFor();
		await map.evaluate((element) => scrollBy(0, element.getBoundingClientRect().top - 24));
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(3000);
		// Replay adds its own controls below the map, so leave room for them.
		const box = await map.boundingBox();
		const clip = { ...pad(box, 16), height: box.height + 96 };
		const shots = await record(page, async () => {
			await page.waitForTimeout(1500);
			await click(page, map.getByRole("button", { name: "Replay history", exact: true }));
			await map.getByRole("button", { name: "Replay history", exact: true }).waitFor({ timeout: 60_000 });
			await page.waitForTimeout(3500);
		});
		encode("lane-map", shots, { viewport, clip, width: 1000 });
		await page.close();
	}
	console.log(`Wrote hero.jpg, story.gif, review-notes.gif and lane-map.gif to ${out}.`);
} finally {
	await browser.close();
	await server.close();
	rmSync(work, { recursive: true, force: true });
}
