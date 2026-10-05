import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import { startFixtureServer } from "./server.mjs";

let server, browser, page;
before(async () => {
	server = await startFixtureServer();
	browser = await chromium.launch({ headless: true });
	await mkdir("dist/ui-checks", { recursive: true });
});
after(async () => {
	await page?.unrouteAll({ behavior: "ignoreErrors" });
	await page?.close();
	await browser?.close();
	await server?.close();
});
beforeEach(async () => {
	// Polling can leave a route handler mid-flight; drop routes quietly before closing the previous page.
	await page?.unrouteAll({ behavior: "ignoreErrors" });
	await page?.close();
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(7000);
	await page.request.post(`${server.origin}/__fixture/reset`);
});
async function openRepo() {
	await page.goto(`${server.origin}/?namespace=fernloop&repository=payments`);
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
}
async function openHomepage() {
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Many agents. One repository. Common ground." }).waitFor();
}
test("public homepage explains independent work without requesting private repository data", async () => {
	const privateRequests = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/")) privateRequests.push(request.url());
	});
	await openHomepage();
	assert.equal(await page.getByRole("navigation", { name: "Repository navigation" }).count(), 0);
	assert.equal(await page.getByRole("link", { name: /GitHub|Docs/ }).count(), 0);
	const signIn = page.getByRole("link", { name: "Sign in", exact: true });
	assert.equal(await signIn.count(), 1);
	assert.equal(await signIn.getAttribute("href"), "/auth/login");
	assert.equal(await page.getByRole("button", { name: /Sign up/ }).count(), 0);
	assert.equal(await page.getByRole("link", { name: /Sign up|Get started/ }).count(), 0);
	await page.getByText("Coming soon · in early development.", { exact: true }).waitFor();
	assert.equal(await page.getByRole("link", { name: "How it works" }).count(), 0);
	assert.equal(await page.locator("main section").count(), 1);
	assert.equal(await page.locator(".product-preview, .revision-preview, .reality-tools").count(), 0);
	assert.deepEqual(privateRequests, []);
});
test("illustration reviews exact revisions and accepts three distinct revisions in a clean sequence", async () => {
	await page.clock.install();
	await openHomepage();
	const story = page.getByRole("group", { name: "Development story stages" });
	const canonical = page.locator(".graph-canonical-head");
	await page.getByText("Coordination vision · illustrative", { exact: true }).waitFor();
	for (const stage of ["Independent work", "Shared awareness", "Human review"]) {
		await story.getByRole("button", { name: stage, exact: true }).click();
		assert.equal(await canonical.textContent(), "");
		assert.equal((await page.locator(".crossing-graph").getAttribute("data-canonical")).slice(0, 8), "71d94e2a");
		assert.equal(await page.locator(".graph-convergence.is-visible").count(), 0);
	}
	assert.equal(await page.locator(".graph-alignment, .graph-message").count(), 0);
	assert.equal(await page.locator(".graph-decision.is-visible").count(), 1);
	assert.equal(await page.locator(".lane-2.graph-lane path").evaluate((el) => getComputedStyle(el).strokeOpacity), "0.3");
	assert.match(await page.locator(".sequence-description").textContent(), /only an authenticated human approval/);
	assert.equal(await page.locator(".sequence-explanation, .sequence-footer, .hero-sequence details").count(), 0);
	await page.screenshot({ path: "dist/ui-checks/homepage-review.png", fullPage: true });
	await story.getByRole("button", { name: "Sequential convergence", exact: true }).click();
	assert.equal(await canonical.textContent(), "bc811af0");
	assert.equal(await page.locator(".graph-convergence.is-visible").count(), 1);
	assert.equal(await page.locator(".graph-convergence.is-visible").getAttribute("data-workspace"), "claude");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.getByRole("button", { name: "Play", exact: true }).click();
	await page.clock.runFor(3700);
	assert.equal(await canonical.textContent(), "bc811af0");
	assert.equal((await page.locator(".graph-lane").nth(1).getAttribute("data-head")).slice(0, 8), "b2c4e718");
	assert.equal(await page.locator(".graph-upstream.is-visible").count(), 1);
	await page.screenshot({ path: "dist/ui-checks/homepage-reconciliation.png", fullPage: true });
	await page.clock.runFor(4700);
	assert.equal(await canonical.textContent(), "b2c4e718");
	assert.equal(await page.locator(".graph-convergence.is-visible").count(), 2);
	await page.clock.runFor(3700);
	assert.equal(await canonical.textContent(), "b2c4e718");
	assert.equal((await page.locator(".graph-lane").last().getAttribute("data-head")).slice(0, 8), "c3d8a902");
	assert.match(await page.locator(".sequence-description").textContent(), /starting revision remains 71d94e2a/);
	await page.clock.runFor(4700);
	assert.equal(await canonical.textContent(), "c3d8a902");
	assert.equal(await page.locator(".graph-convergence.is-visible").count(), 3);
	await story.getByRole("button", { name: "Common ground", exact: true }).click();
	assert.equal(await page.locator(".graph-lane.is-focused").count(), 3);
	assert.deepEqual(
		await page
			.locator(".graph-convergence.is-visible")
			.evaluateAll((groups) => groups.map((g) => [g.dataset.workspace, g.dataset.revision.slice(0, 8)])),
		[
			["claude", "bc811af0"],
			["codex", "b2c4e718"],
			["cursor", "c3d8a902"],
		],
	);
	// Test the actual geometry: no pair of return curves intersects, and their main dots advance left to right.
	assert.equal(
		await page.locator(".graph-convergence .graph-trace").evaluateAll((paths) => {
			const samples = paths.map((path) => Array.from({ length: 81 }, (_, i) => path.getPointAtLength((path.getTotalLength() * i) / 80)));
			const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
			for (let i = 0; i < samples.length; i++)
				for (let j = i + 1; j < samples.length; j++)
					for (let a = 1; a < 81; a++)
						for (let b = 1; b < 81; b++) {
							const p = samples[i][a - 1],
								q = samples[i][a],
								r = samples[j][b - 1],
								s = samples[j][b];
							if (cross(p, q, r) * cross(p, q, s) < 0 && cross(r, s, p) * cross(r, s, q) < 0) return false;
						}
			return true;
		}),
		true,
	);
	const dots = await page.locator(".graph-accepted-dot").evaluateAll((nodes) => nodes.map((n) => Number(n.getAttribute("cx"))));
	assert.equal(dots[0] < dots[1] && dots[1] < dots[2], true);
	await page.screenshot({ path: "dist/ui-checks/homepage-convergence.png", fullPage: true });
	await page.setViewportSize({ width: 390, height: 1000 });
	assert.equal(await page.locator(".mobile-main-dot.is-accepted").count(), 3);
	await page.screenshot({ path: "dist/ui-checks/homepage-cycle-mobile.png", fullPage: true });
	await story.getByRole("button", { name: "Shared awareness", exact: true }).click();
	assert.equal(await canonical.textContent(), "");
	assert.equal((await page.locator(".crossing-graph").getAttribute("data-canonical")).slice(0, 8), "71d94e2a");
	assert.equal(await page.locator(".graph-convergence.is-visible").count(), 0);
	assert.equal(await page.locator(".graph-overlap.is-visible").count(), 1);
	await page.emulateMedia({ reducedMotion: "reduce" });
	assert.equal(await page.getByRole("button", { name: "Pause", exact: true }).count(), 0);
});
test("sign-out hands off to Access, and returning home keeps the Cruce console signed out", async () => {
	// Only the real provider can revoke Access sessions. Hold its boundary here
	// to verify the console navigation without simulating revocation as evidence.
	await openHomepage();
	await page.getByRole("link", { name: "Sign in", exact: true }).first().click();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("link", { name: "Sign out", exact: true }).click();
	await page.getByRole("heading", { name: "Fixture Access logout boundary" }).waitFor();
	assert.equal(new URL(page.url()).pathname, "/cdn-cgi/access/logout");
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Many agents. One repository. Common ground." }).waitFor();
	assert.equal(new URL(page.url()).pathname, "/");
	await page.reload();
	await page.getByRole("heading", { name: "Many agents. One repository. Common ground." }).waitFor();
});
test("sign-in preserves a saved repository revision and invitation fragment without changing the login URL", async () => {
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.goto(`${server.origin}/?namespace=fernloop&repository=payments#/code/source`);
	await page.getByRole("heading", { name: "Many agents. One repository. Common ground." }).waitFor();
	await page.getByRole("link", { name: "Sign in", exact: true }).first().click();
	await page.getByRole("heading", { name: "Bounded retry policy", exact: true }).waitFor();
	assert.equal(new URL(page.url()).hash, "#/code/source");
	assert.equal(new URL(page.url()).search, "?namespace=fernloop&repository=payments");
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.goto(`${server.origin}/invite/fernloop#fixture-invitation`);
	await page.getByRole("heading", { name: "Many agents. One repository. Common ground." }).waitFor();
	await page.getByRole("link", { name: "Sign in", exact: true }).first().click();
	await page.getByRole("heading", { name: "Join namespace", exact: true }).waitFor();
	assert.equal(new URL(page.url()).pathname, "/invite/fernloop");
	assert.equal(new URL(page.url()).hash, "#fixture-invitation");
});
test("session failures retain a retry state and stale confirmation cannot remount an expired console", async () => {
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: true, failure: true } });
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Connection unavailable." }).waitFor();
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await page.getByRole("heading", { name: "Many agents. One repository. Common ground." }).waitFor();
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: true, delay: 500 } });
	await page.goto(server.origin);
	await page.getByRole("status").waitFor();
	await page.evaluate(() => window.dispatchEvent(new Event("cruce:session-expired")));
	await page.getByRole("heading", { name: "Many agents. One repository. Common ground." }).waitFor();
	await page.waitForTimeout(650);
	assert.equal(await page.getByRole("heading", { name: "Your repositories", exact: true }).count(), 0);
});
test("expired console requests clear private views and public anchors do not rewrite console deep links", async () => {
	await openRepo();
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("button", { name: "Switch namespace", exact: true }).click();
	// Trigger a normal console read after revocation without waiting for the polling interval.
	await page.evaluate(async () => {
		const { request } = await import("/src/ui/request.ts");
		try {
			await request("/api/me");
		} catch {}
	});
	await page.getByRole("heading", { name: "Many agents. One repository. Common ground." }).waitFor();
	assert.equal(await page.locator(".shell").count(), 0);
	assert.equal(new URL(page.url()).search, "?namespace=fernloop&repository=payments");
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: true } });
	await page.reload();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
});
test("homepage reflows, keyboard controls work, and reduced motion leaves a readable static story", async () => {
	await openHomepage();
	await page.keyboard.press("Tab");
	assert.equal(await page.getByRole("link", { name: "Skip to content" }).evaluate((element) => element === document.activeElement), true);
	await page.keyboard.press("Enter");
	assert.equal(await page.locator("#landing-content").evaluate((element) => element === document.activeElement), true);
	const crossing = page.getByRole("group", { name: "Development story stages" }).getByRole("button", { name: /Shared awareness/ });
	await crossing.focus();
	await page.keyboard.press("Enter");
	assert.equal(await crossing.getAttribute("aria-pressed"), "true");
	await page.evaluate(() => document.activeElement?.blur());
	for (const width of [1440, 1024, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await page.screenshot({ path: `dist/ui-checks/homepage-${width}.png`, fullPage: true });
	}
	assert.equal(await page.locator(".crossing-mobile").isVisible(), true);
	assert.equal(await page.locator(".crossing-desktop").isVisible(), false);
	assert.equal(await page.locator(".graph-convergence.is-visible").count(), 0);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.evaluate(() => {
		document.documentElement.style.zoom = "2";
	});
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	assert.equal(
		await page.locator(".landing-hero").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
		1,
	);
	await page.screenshot({ path: "dist/ui-checks/homepage-zoom.png", fullPage: true });
});
test("homepage motion runs once and pauses when controlled, hidden, or outside the viewport", async () => {
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.clock.install();
	await page.goto(server.origin);
	await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
	const story = page.getByRole("group", { name: "Development story stages" });
	await page.clock.runFor(4300);
	assert.equal(await story.getByRole("button", { name: /Shared awareness/ }).getAttribute("aria-pressed"), "true");
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	assert.equal(await page.locator(".hero-sequence").getAttribute("data-motion"), "paused");
	assert.equal(
		await page
			.locator('.sequence-controls button[aria-pressed="true"] .sequence-step-copy')
			.evaluate((element) => getComputedStyle(element).opacity),
		"1",
	);
	await page.clock.runFor(5000);
	assert.equal(await story.getByRole("button", { name: /Shared awareness/ }).getAttribute("aria-pressed"), "true");
	await story.getByRole("button", { name: "Independent work", exact: true }).click();
	await page.getByRole("button", { name: "Play", exact: true }).click();
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.clock.runFor(5000);
	assert.equal(await story.getByRole("button", { name: /Independent work/ }).getAttribute("aria-pressed"), "true");
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, value: false });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.setViewportSize({ width: 1440, height: 100 });
	await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
	await page.waitForTimeout(80); // Allow the browser's native IntersectionObserver to observe the scroll.
	await page.clock.runFor(5000);
	assert.equal(await story.getByRole("button", { name: /Independent work/ }).getAttribute("aria-pressed"), "true");
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator(".hero-sequence").scrollIntoViewIfNeeded();
	await page.waitForTimeout(80);
	for (const duration of [4300, 4900, 5700, 3700, 4700, 3700, 4700, 3700, 3300]) await page.clock.runFor(duration);
	assert.equal(await story.getByRole("button", { name: /Common ground/ }).getAttribute("aria-pressed"), "true");
	await page.getByRole("button", { name: "Replay", exact: true }).waitFor();
	await page.clock.runFor(10000);
	assert.equal(await story.getByRole("button", { name: /Common ground/ }).getAttribute("aria-pressed"), "true");
});
test("hero draws native SVG paths smoothly and Pause holds a partially drawn promotion", async () => {
	await openHomepage();
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.getByRole("button", { name: "Play", exact: true }).waitFor();
	await page.getByRole("button", { name: "Human review", exact: true }).click();
	await page.getByRole("button", { name: "Play", exact: true }).click();
	await page.waitForTimeout(300);
	const independentWorker = page.locator(".lane-2 .graph-worker");
	assert.equal(await independentWorker.evaluate((element) => element.getAnimations()[0].playState), "running");
	assert.equal(await page.locator(".graph-message").count(), 0);
	assert.equal(await page.locator(".graph-canonical-head").textContent(), "");
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".lane-2 .graph-worker").getAnimations()[0].playState === "paused");
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const workerPausedAt = await independentWorker.evaluate((element) => element.getAnimations()[0].currentTime);
	assert.equal(workerPausedAt > 100, true);
	assert.equal(await page.locator(".graph-decision").evaluate((element) => getComputedStyle(element).opacity), "1");
	await page.waitForTimeout(100);
	assert.equal(await independentWorker.evaluate((element) => element.getAnimations()[0].currentTime), workerPausedAt);
	await page.screenshot({ path: "dist/ui-checks/homepage-coordination-paused.png", fullPage: true });
	await page
		.getByRole("group", { name: "Development story stages" })
		.getByRole("button", { name: /Sequential convergence/ })
		.click();
	await page.getByRole("button", { name: "Play", exact: true }).click();
	const curve = page.locator('.graph-convergence[data-workspace="claude"] .graph-trace');
	assert.equal(await page.locator(".graph-worker").count(), 2);
	await page.waitForTimeout(500);
	const offset = await curve.evaluate((element) => Number.parseFloat(getComputedStyle(element).strokeDashoffset));
	const length = await curve.evaluate((element) => element.getTotalLength());
	assert.equal(offset > 0 && offset < length, true);
	assert.equal(
		Math.abs((await curve.evaluate((element) => Number.parseFloat(getComputedStyle(element).strokeDasharray))) - length) < 0.01,
		true,
	);
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await page.waitForFunction(
		() => document.querySelector('.graph-convergence[data-workspace="claude"] .graph-trace').getAnimations()[0].playState === "paused",
	);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const pausedAt = await curve.evaluate((element) => element.getAnimations()[0].currentTime);
	await page.waitForTimeout(100);
	assert.equal(await curve.evaluate((element) => element.getAnimations()[0].currentTime), pausedAt);
	assert.equal(await curve.evaluate((element) => element.getAnimations()[0].playState), "paused");
	assert.equal(await curve.evaluate((element) => getComputedStyle(element.parentElement).opacity), "1");
	assert.equal(
		await page
			.locator('.sequence-controls button[aria-pressed="true"] .sequence-step-copy')
			.evaluate((element) => Number(getComputedStyle(element).opacity) > 0),
		true,
	);
	const paintedFrame = await page.screenshot({ path: "dist/ui-checks/homepage-motion-paused.png", fullPage: true });
	const samples = await curve.evaluate((path) =>
		[20, 35, 50].map((distance) => {
			const point = path.getPointAtLength(distance).matrixTransform(path.getScreenCTM());
			return { x: Math.round(point.x + scrollX), y: Math.round(point.y + scrollY) };
		}),
	);
	const copperPixels = await page.evaluate(
		async ({ png, samples }) => {
			const image = new Image();
			image.src = `data:image/png;base64,${png}`;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			let count = 0;
			for (const { x, y } of samples) {
				const pixels = context.getImageData(x - 2, y - 2, 5, 5).data;
				for (let i = 0; i < pixels.length; i += 4) {
					if (pixels[i] < 210 && pixels[i] > pixels[i + 1] + 25 && pixels[i + 1] > pixels[i + 2] + 20) count++;
				}
			}
			return count;
		},
		{ png: paintedFrame.toString("base64"), samples },
	);
	assert.equal(copperPixels > 3, true, "the paused return curve must actually paint, not merely have a computed offset");
	assert.equal(await curve.evaluate((element) => element.getAnimations()[0].currentTime), pausedAt);
	await page.getByRole("button", { name: "Play", exact: true }).click();
	try {
		await page.waitForFunction(
			(frozenTime) => {
				const animation = document.querySelector('.graph-convergence[data-workspace="claude"] .graph-trace').getAnimations()[0];
				return animation.playState !== "paused" && animation.currentTime > frozenTime;
			},
			pausedAt,
			{ timeout: 2500 },
		);
	} catch (error) {
		throw new Error(
			JSON.stringify(
				await page.evaluate(() => {
					const animation = document.querySelector('.graph-convergence[data-workspace="claude"] .graph-trace').getAnimations()[0];
					return {
						motion: document.querySelector(".hero-sequence").dataset.motion,
						hidden: document.hidden,
						time: animation.currentTime,
						state: animation.playState,
						stage: document.querySelector(".crossing-graph").className,
						playback: document.querySelector(".sequence-playback").textContent,
						scroll: scrollY,
					};
				}),
			),
			{ cause: error },
		);
	}

	assert.equal(await curve.evaluate((element) => element.getAnimations()[0].currentTime > 0), true);
});
test("moving dots stay on their own paths and no message passes between workspaces", async () => {
	await openHomepage();
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.getByRole("button", { name: "Human review", exact: true }).click();
	await page.getByRole("button", { name: "Play", exact: true }).click();
	await page.waitForTimeout(150);
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	assert.equal(await page.locator(".graph-message").count(), 0);
	const failures = await page.evaluate(async () => {
		const failures = [];
		for (const fraction of [0, 0.125, 0.5, 0.9, 1]) {
			for (const worker of document.querySelectorAll(".graph-worker")) {
				const animation = worker.getAnimations()[0];
				animation.pause();
				animation.currentTime = 3200 * fraction;
			}
			await new Promise(requestAnimationFrame);
			for (const worker of document.querySelectorAll(".graph-worker")) {
				const dot = worker.getBoundingClientRect(),
					tip = worker.parentElement.querySelector(".graph-tip").getBoundingClientRect();
				const center = dot.left + dot.width / 2,
					end = tip.left + tip.width / 2;
				if (center > end - 2 || Math.abs(dot.top + dot.height / 2 - (tip.top + tip.height / 2)) > 1)
					failures.push({ fraction, center, end });
			}
		}
		return failures;
	});
	assert.deepEqual(failures, []);
	await page.screenshot({ path: "dist/ui-checks/homepage-dot-endpoints.png", fullPage: true });
});
test("active progress caption fits its step without covering the diagram through every moment", async () => {
	await page.clock.install();
	await openHomepage();
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const durations = [4200, 4800, 5600, 3600, 4600, 3600, 4600, 3600, 3200];
	for (const width of [1440, 1024, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.getByRole("button", { name: "Independent work", exact: true }).click();
		await page.getByRole("button", { name: "Play", exact: true }).click();
		await page.locator(".hero-sequence").scrollIntoViewIfNeeded();
		let initialHeight;
		for (let stage = 0; stage < durations.length; stage++) {
			await page.locator(`.crossing-graph.graph-stage-${stage}`).waitFor();
			await page.clock.runFor(250);
			const layout = await page.locator(".hero-sequence").evaluate((root) => {
				const note = root.querySelector('.sequence-controls button[aria-pressed="true"]');
				const box = note.getBoundingClientRect();
				const graph = root.querySelector(".crossing-graph").getBoundingClientRect();
				const controls = root.querySelector(".sequence-controls").getBoundingClientRect();
				const copy = note.querySelector(".sequence-step-copy").getBoundingClientRect();
				return {
					clear: box.top >= graph.bottom && box.bottom <= controls.bottom,
					fits: copy.left >= box.left && copy.right <= box.right && copy.bottom <= box.bottom,
					height: controls.height,
				};
			});
			assert.equal(layout.clear, true, `${width}px moment ${stage}: caption must remain below diagram within controls`);
			assert.equal(layout.fits, true, `${width}px moment ${stage}: caption text must fit`);
			initialHeight ??= layout.height;
			assert.equal(layout.height, initialHeight, `${width}px moment ${stage}: caption must not shift controls`);
			assert.equal(await page.locator(".sequence-step-detail").count(), 1);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
			await page.screenshot({ path: `dist/ui-checks/homepage-note-${width}-${stage}.png`, fullPage: true });
			if (stage < durations.length - 1) await page.clock.runFor(durations[stage] - 250 + 80);
		}
	}
});
const repoNav = () => page.getByRole("navigation", { name: "Repository navigation" });
const namespaceNav = () => page.getByRole("navigation", { name: "Namespace navigation" });
const root = () => `${server.origin}/?namespace=fernloop&repository=payments`;
async function openChange() {
	await openRepo();
	await page.locator(".change-row").filter({ hasText: "Bounded retry policy" }).click();
	await page.getByRole("heading", { name: /Bounded retry policy/, level: 1 }).waitFor();
}
const workspaceRow = (title) => page.locator(".workspace-row").filter({ has: page.getByText(title, { exact: true }) });
async function openWorkspace(title) {
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	await workspaceRow(title).click();
	await page.getByRole("heading", { name: title, exact: true, level: 1 }).waitFor();
}

test("home lists repositories by what needs attention and keeps its filter while the account menu opens", async () => {
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	const row = page.locator(".repo-row").filter({ hasText: "payment-service" });
	await row.getByText("1 to review", { exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/namespaces.png", fullPage: true });
	await page.getByLabel("Filter namespaces").fill("payment-service");
	assert.equal(await page.locator(".namespace-row").count(), 1);
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("region", { name: "Your account", exact: true }).waitFor();
	assert.equal(new URL(page.url()).search, "");
	assert.equal(await page.getByLabel("Filter namespaces").inputValue(), "payment-service");
	await page.screenshot({ path: "dist/ui-checks/account.png", fullPage: true });
	await page.keyboard.press("Escape");
	await page.reload();
	await page.getByRole("button", { name: "Fernloop", exact: true }).click();
	await namespaceNav().getByRole("button", { name: "Teams", exact: true }).click();
	await page.reload();
	assert.equal(await namespaceNav().getByRole("button", { name: "Teams", exact: true }).getAttribute("aria-current"), "page");
	await page.goBack();
	assert.equal(await namespaceNav().getByRole("button", { name: "Repositories", exact: true }).getAttribute("aria-current"), "page");
	await page.getByRole("heading", { name: "Fernloop", exact: true, level: 1 }).waitFor();
});
test("empty namespaces inherit installation storage and creation dialogs keep focus contained", async () => {
	await page.goto(server.origin);
	await page.getByRole("button", { name: "Alex Morgan", exact: true }).click();
	await page.getByRole("heading", { name: "No repositories yet", exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "View storage setup", exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "New repository", exact: true }).count(), 2);
	await page.screenshot({ path: "dist/ui-checks/empty-namespace.png", fullPage: true });
	await page.goto(`${server.origin}/?namespace=fernloop`);
	const trigger = page.getByRole("button", { name: "New repository", exact: true });
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "New repository", exact: true });
	await dialog.getByText("Creates canonical Git storage", { exact: false }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/create-repository.png", fullPage: true });
	for (let i = 0; i < 10; i++) {
		await page.keyboard.press("Tab");
		assert.equal(await page.evaluate(() => !!document.activeElement?.closest("dialog")), true);
	}
	await page.keyboard.press("Escape");
	assert.equal(await dialog.count(), 0);
	assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
	await page.getByRole("button", { name: "Switch namespace", exact: true }).click();
	await page.getByRole("button", { name: "Create namespace", exact: true }).click();
	await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Design team");
	await page.getByLabel("Namespace handle").fill("design-team");
	await page.getByRole("button", { name: "Create namespace", exact: true }).click();
	await page.getByRole("button", { name: "Switch namespace" }).filter({ hasText: "Design team" }).waitFor();
	await namespaceNav().getByRole("button", { name: "Members", exact: true }).waitFor();
});
test("a new repository opens on Changes with a way to connect an agent", async () => {
	await page.goto(`${server.origin}/?namespace=fernloop`);
	await page.getByRole("button", { name: "New repository", exact: true }).click();
	await page.getByLabel("Repository name", { exact: true }).fill("local-tools");
	await page.getByRole("button", { name: "Add repository", exact: true }).click();
	await page.getByRole("heading", { name: "local-tools", exact: true }).waitFor();
	await page.getByRole("heading", { name: "No changes yet", exact: true }).waitFor();
	await page.getByText("Nothing needs you right now.", { exact: true }).waitFor();
	await page.locator(".changes-screen").getByRole("button", { name: "Connect an agent", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Connect an agent", exact: true });
	await dialog.getByRole("button", { name: "Codex", exact: true }).click();
	await dialog.getByText(/--client codex/).waitFor();
	assert.equal(await dialog.getByRole("button", { name: "Codex", exact: true }).getAttribute("aria-pressed"), "true");
	await page.waitForTimeout(250); // Let the 140ms selection transition finish before capturing.
	await page.screenshot({ path: "dist/ui-checks/connect-agent.png", fullPage: true });
});
test("brand navigation reaches an unscoped Home and Back restores the repository", async () => {
	await openRepo();
	await page.getByRole("link", { name: "Cruce home", exact: true }).click();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	assert.equal(new URL(page.url()).search, "");
	await page.getByRole("navigation", { name: "Current location" }).getByText("Home", { exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Switch namespace", exact: true }).count(), 0);
	assert.equal(await namespaceNav().count(), 0);
	await page.reload();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	await page.getByRole("button", { name: "Switch namespace", exact: true }).filter({ hasText: "Fernloop" }).waitFor();
});
test("saved global URLs cannot select or fetch a hidden repository or namespace scope", async () => {
	let repositoryReads = 0;
	await page.route("**/api/namespaces/fernloop/repositories/payments", (route) => {
		repositoryReads++;
		return route.continue();
	});
	await page.goto(`${server.origin}/?page=namespaces&namespace=fernloop&repository=payments#/work`);
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	assert.equal(new URL(page.url()).searchParams.has("namespace"), false);
	assert.equal(new URL(page.url()).searchParams.has("repository"), false);
	assert.equal(await page.getByRole("button", { name: "Switch namespace", exact: true }).count(), 0);
	assert.equal(repositoryReads, 0);
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("region", { name: "Your account", exact: true }).waitFor();
	assert.equal(new URL(page.url()).search, "?page=namespaces");
	assert.equal(await page.getByRole("button", { name: "Switch namespace", exact: true }).count(), 0);
});
test("avatar menu preserves repository context and keyboard focus; saved account links open it on Home", async () => {
	await openRepo();
	const current = page.url();
	const trigger = page.getByRole("button", { name: "Your account", exact: true });
	await trigger.click();
	const menu = page.getByRole("region", { name: "Your account", exact: true });
	await menu.getByText("Alex Morgan", { exact: true }).waitFor();
	await menu.getByText("alex@example.com", { exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/account-card.png", clip: { x: 980, y: 35, width: 460, height: 240 } });
	assert.equal(await menu.getByRole("link", { name: "Sign out", exact: true }).getAttribute("href"), "/auth/logout");
	assert.deepEqual(
		(await menu.getByRole("link").allTextContents()).map((text) => text.trim()),
		["Sign out"],
	);
	assert.equal(page.url(), current);
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	assert.equal(await page.getByRole("dialog").count(), 0);
	assert.equal(await page.locator("header").getByText("Alpha", { exact: false }).count(), 0);
	await page.getByRole("contentinfo").getByText("Cruce · Alpha", { exact: true }).waitFor();
	await page.keyboard.press("Escape");
	assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
	assert.equal(await menu.count(), 0);
	await page.goto(`${server.origin}/?page=account&namespace=fernloop&repository=payments`);
	await menu.waitFor();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	assert.equal(new URL(page.url()).search, "");
	assert.equal(await page.getByRole("button", { name: "Switch namespace", exact: true }).count(), 0);
	await page.reload();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	assert.equal(await menu.count(), 0);
});
test("avatar menu fits a narrow screen and tabbing out dismisses it without trapping focus", async () => {
	await page.setViewportSize({ width: 320, height: 700 });
	await page.goto(server.origin);
	const trigger = page.getByRole("button", { name: "Your account", exact: true });
	await trigger.click();
	const menu = page.getByRole("region", { name: "Your account", exact: true });
	const bounds = await menu.boundingBox();
	assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.screenshot({ path: "dist/ui-checks/account-narrow.png", fullPage: true });
	await page.keyboard.press("Tab");
	assert.equal(await menu.count(), 0);
});
test("namespace dropdown switches scope with keyboard selection and restores focus after cancelling creation", async () => {
	await openRepo();
	let trigger = page.getByRole("button", { name: "Switch namespace", exact: true });
	await trigger.click();
	const dropdown = page.getByRole("region", { name: "Switch namespace", exact: true });
	assert.equal(await page.getByRole("dialog").count(), 0);
	assert.equal(await page.locator("main").evaluate((element) => element.inert), false);
	await dropdown
		.getByRole("link", { name: "Fernloop Shared namespace", exact: true })
		.getAttribute("aria-current")
		.then((current) => assert.equal(current, "true"));
	await page.getByLabel("Search namespaces").fill("No matching namespace");
	await page.keyboard.press("Enter");
	assert.equal(await page.getByRole("dialog").count(), 0);
	await page.getByLabel("Search namespaces").fill("Alex");
	await page.keyboard.press("Enter");
	await page.getByRole("heading", { name: "Alex Morgan", exact: true, level: 1 }).waitFor();
	await trigger.filter({ hasText: "Alex Morgan" }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Switch repository", exact: true }).count(), 0);
	assert.deepEqual(
		(await page.getByRole("navigation", { name: "Namespace navigation" }).getByRole("button").allTextContents()).map((text) => text.trim()),
		["Repositories", "Settings"],
	);
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	trigger = page.getByRole("button", { name: "Switch namespace", exact: true });
	await trigger.click();
	await dropdown.getByRole("button", { name: "Create namespace", exact: true }).click();
	await page.getByRole("dialog", { name: "Create namespace", exact: true }).waitFor();
	await page.keyboard.press("Escape");
	assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
});
test("repository dropdown stays within its namespace and can return to the namespace's repositories", async () => {
	await openRepo();
	const trigger = page.getByRole("button", { name: "Switch repository", exact: true });
	await trigger.click();
	const dropdown = page.getByRole("region", { name: "Switch repository", exact: true });
	await dropdown.getByRole("link", { name: "payment-service main", exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/repository-dropdown.png", fullPage: true });
	await page.getByLabel("Search repositories").fill("payment");
	assert.equal(await dropdown.getByRole("link").count(), 1);
	await page.keyboard.press("Escape");
	await trigger.click();
	await dropdown.getByRole("link", { name: "All repositories Fernloop", exact: true }).click();
	await page.getByRole("heading", { name: "Fernloop", exact: true, level: 1 }).waitFor();
	assert.equal(new URL(page.url()).searchParams.has("repository"), false);
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
});
test("search shortcuts focus the same field, Escape and Tab dismiss results, and empty matches do not navigate", async () => {
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	const current = page.url();
	const search = page.getByRole("combobox", { name: "Find repository", exact: true });
	await page.keyboard.press("Meta+k");
	assert.equal(await search.evaluate((element) => element === document.activeElement), true);
	await page.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	await search.fill("nothing-matches-this-repository");
	await page
		.getByRole("region", { name: "Repository search", exact: true })
		.getByText("No matching repositories.", { exact: true })
		.waitFor();
	await page.keyboard.press("Enter");
	assert.equal(page.url(), current);
	await page.keyboard.press("Escape");
	assert.equal(await search.getAttribute("aria-expanded"), "false");
	assert.equal(await search.evaluate((element) => element === document.activeElement), true);
	await page.keyboard.press("Control+k");
	assert.equal(await search.getAttribute("aria-expanded"), "true");
	await search.fill("payment");
	await page.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	await page.keyboard.press("Tab");
	assert.equal(await page.getByRole("region", { name: "Repository search", exact: true }).count(), 0);
	assert.equal(
		await page.getByRole("button", { name: "Your account", exact: true }).evaluate((element) => element === document.activeElement),
		true,
	);
	assert.equal(page.url(), current);
});
test("search preserves partial results and retries unavailable namespaces without moving the page", async () => {
	let fail = true;
	await page.route("**/api/namespaces/*/repositories", (route) => {
		if (!route.request().url().includes("/fernloop/") && fail)
			return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
		return route.continue();
	});
	await page.goto(server.origin);
	await page.getByRole("combobox", { name: "Find repository", exact: true }).fill("payment");
	const panel = page.getByRole("region", { name: "Repository search", exact: true });
	await panel.getByRole("alert").getByText("Some repositories are unavailable.", { exact: true }).waitFor();
	await panel.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	assert.equal(await panel.getByText("No matching repositories.", { exact: true }).count(), 0);
	await panel.getByRole("button", { name: "Retry", exact: true }).focus();
	await page.keyboard.press("Escape");
	assert.equal(await panel.count(), 0);
	const search = page.getByRole("combobox", { name: "Find repository", exact: true });
	assert.equal(await search.evaluate((element) => element === document.activeElement), true);
	await search.click();
	await panel.getByRole("alert").waitFor();
	fail = false;
	await panel.getByRole("button", { name: "Retry", exact: true }).click();
	await panel.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	assert.equal(await panel.getByRole("alert").count(), 0);
	assert.equal(new URL(page.url()).search, "");
	await page.getByRole("heading", { name: "Your repositories", exact: true }).click();
	assert.equal(await panel.count(), 0);
});
test("mobile search is anchored below the compact header and keeps navigation available", async () => {
	await page.setViewportSize({ width: 320, height: 700 });
	await openRepo();
	const current = page.url();
	const trigger = page.getByRole("button", { name: "Find repository", exact: true });
	await trigger.click();
	const search = page.getByRole("combobox", { name: "Find repository", exact: true });
	const panel = page.getByRole("region", { name: "Repository search", exact: true });
	await search.fill("fernloop/payment");
	await panel.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	assert.equal(await page.getByRole("dialog").count(), 0);
	assert.equal(await search.evaluate((element) => element === document.activeElement), true);
	const bounds = await page.locator(".search-content").boundingBox();
	assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.screenshot({ path: "dist/ui-checks/search-mobile.png", fullPage: true });
	await page.keyboard.press("Escape");
	assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
	assert.equal(await panel.count(), 0);
	assert.equal(page.url(), current);
	await page.keyboard.press("Control+k");
	await panel.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	await panel.getByRole("option", { name: "fernloop/payment-service", exact: true }).click();
	assert.equal(await panel.count(), 0);
	assert.equal(await page.getByRole("button", { name: "Switch namespace", exact: true }).isVisible(), true);
});
test("dismissed search requests cannot replace a newer search and shortcuts leave creation forms alone", async () => {
	let release;
	const delayed = new Promise((resolve) => {
		release = resolve;
	});
	let delivered;
	const delivery = new Promise((resolve) => {
		delivered = resolve;
	});
	let first = true;
	const data = await (await page.request.get(`${server.origin}/api/namespaces/fernloop/repositories`)).json();
	await page.route("**/api/namespaces/fernloop/repositories", async (route) => {
		if (!first) return route.continue();
		first = false;
		await delayed;
		try {
			await route.fulfill({ json: [{ ...data[0], id: "stale", name: "stale-repository" }] });
		} finally {
			delivered();
		}
	});
	await openRepo();
	const search = page.getByRole("combobox", { name: "Find repository", exact: true });
	await search.click();
	const panel = page.getByRole("region", { name: "Repository search", exact: true });
	await panel.getByText("Finding repositories…", { exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await search.click();
	await panel.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	release();
	await delivery;
	await panel.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	assert.equal(await panel.getByRole("option", { name: /stale-repository/ }).count(), 0);
	await page.getByRole("button", { name: "Switch namespace", exact: true }).click();
	await page
		.getByRole("region", { name: "Switch namespace", exact: true })
		.getByRole("button", { name: "Create namespace", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "Create namespace", exact: true });
	await dialog.getByLabel("Name", { exact: true }).fill("Keep my place");
	await page.keyboard.press("Meta+k");
	assert.equal(await dialog.getByLabel("Name", { exact: true }).evaluate((element) => element === document.activeElement), true);
	assert.equal(await panel.count(), 0);
	await page.keyboard.press("Escape");
	await search.click();
	await panel.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	assert.equal(await panel.getByRole("option", { name: /stale-repository/ }).count(), 0);
});
test("mobile view has no horizontal page overflow", async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openRepo();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.screenshot({ path: "dist/ui-checks/mobile.png", fullPage: true });
});
test("a repository whose creation stopped before canonical setup offers a maintainer retry of the original operation", async () => {
	let retried = false;
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const response = await route.fetch(),
			data = await response.json();
		if (!retried) {
			delete data.sourceHead;
			delete data.canonical;
			data.canonicalSetup = { required: true, retry: true };
		}
		await route.fulfill({ json: data });
	});
	const sent = [];
	await page.route("**/api/namespaces/fernloop/repositories/payments/command", async (route) => {
		const body = route.request().postDataJSON();
		sent.push(body.tool);
		if (body.tool !== "retry_repository_setup") return route.continue();
		retried = true;
		await route.fulfill({ json: { revision: "a".repeat(40) } });
	});
	await openRepo();
	const notice = page.locator(".canonical-setup");
	await notice.getByText("Canonical storage was not created.").waitFor();
	assert.equal(await page.getByRole("button", { name: "Clone", exact: true }).isDisabled(), true);
	await page.screenshot({ path: "dist/ui-checks/repository-setup-retry.png", fullPage: true });
	await notice.getByRole("button", { name: "Retry setup", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
	assert.deepEqual(sent, ["retry_repository_setup"]);
	await page.locator(".canonical-setup").waitFor({ state: "detached" });
});
test("viewers without maintain authority see why setup is missing but no retry control", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const response = await route.fetch(),
			data = await response.json();
		delete data.sourceHead;
		delete data.canonical;
		data.canonicalSetup = { required: true, retry: false };
		await route.fulfill({ json: data });
	});
	await openRepo();
	await page.locator(".canonical-setup").getByText("A repository maintainer can retry setup.").waitFor();
	assert.equal(await page.getByRole("button", { name: "Retry setup", exact: true }).count(), 0);
});
test("mobile dropdowns support keyboard navigation, Escape, outside clicks and reduced motion without trapping focus", async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await openRepo();
	const trigger = page.getByRole("button", { name: "Switch namespace", exact: true });
	await trigger.focus();
	await page.keyboard.press("ArrowDown");
	const dropdown = page.getByRole("region", { name: "Switch namespace", exact: true });
	await dropdown.waitFor();
	assert.equal(await page.getByRole("dialog").count(), 0);
	assert.equal(await page.getByLabel("Search namespaces").evaluate((e) => e === document.activeElement), true);
	await page.screenshot({ path: "dist/ui-checks/namespace-dropdown-mobile.png", fullPage: true });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.keyboard.press("Escape");
	assert.equal(await trigger.evaluate((e) => e === document.activeElement), true);
	assert.equal(await dropdown.count(), 0);
	await trigger.click();
	const bounds = await dropdown.boundingBox();
	await page.mouse.click(bounds.x + bounds.width + 8, bounds.y + 8);
	assert.equal(await dropdown.count(), 0);
	await trigger.click();
	await page.getByLabel("Search namespaces").fill("fernloop");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	assert.equal(await dropdown.count(), 0);
	assert.equal(
		await page.getByRole("button", { name: "Switch repository", exact: true }).evaluate((e) => e === document.activeElement),
		true,
	);
	assert.equal(
		await page
			.locator(".tabs button")
			.first()
			.evaluate((e) => getComputedStyle(e).transitionDuration),
		"0s",
	);
});
test("repository pages lead with what needs attention and retired routes resolve to their new homes", async () => {
	await openRepo();
	assert.deepEqual(
		(await repoNav().getByRole("button").allTextContents()).map((text) => text.replace(/\d+$/, "").trim()),
		["Changes", "Workspaces", "History", "Settings"],
	);
	await page.getByRole("button", { name: "1 change needs your review", exact: true }).waitFor();
	await page.getByRole("button", { name: "1 file changed in more than one workspace", exact: true }).click();
	assert.ok(page.url().endsWith("#/workspaces"));
	await page.screenshot({ path: "dist/ui-checks/repository.png", fullPage: true });
	await page.goto(`${root()}#/overview`);
	await page.locator(".change-row").filter({ hasText: "Bounded retry policy" }).waitFor();
	await page.goto(page.url().replace(/#.*$/, "#deployments"));
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	assert.equal(await page.getByRole("heading", { name: "Deployments", exact: true }).count(), 0);
	await page.goto(`${server.origin}/?namespace=fernloop#settings`);
	await page.getByRole("heading", { name: "Daily operations", exact: true }).waitFor();
	assert.equal(await page.getByLabel("Previews per workspace").count(), 0);
});
test("header search accepts typing directly and supports keyboard selection and Back navigation", async () => {
	await openRepo();
	const search = page.getByRole("combobox", { name: "Find repository", exact: true });
	await search.click();
	await search.fill("  FERNLOOP payment  ");
	await page.getByRole("option", { name: "fernloop/payment-service", exact: true }).waitFor();
	assert.equal(await page.getByRole("dialog").count(), 0);
	assert.equal(await page.locator("main").evaluate((element) => element.inert), false);
	await page.screenshot({ path: "dist/ui-checks/finder.png", fullPage: true });
	await page.screenshot({ path: "dist/ui-checks/search-header.png", clip: { x: 0, y: 0, width: 1440, height: 250 } });
	await page.keyboard.press("ArrowDown");
	assert.equal(await search.evaluate((element) => element === document.activeElement), true);
	assert.ok(await search.getAttribute("aria-activedescendant"));
	await page.keyboard.press("Enter");
	assert.equal(await page.getByRole("region", { name: "Repository search", exact: true }).count(), 0);
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	assert.equal(
		await repoNav()
			.getByRole("button", { name: /^Workspaces/ })
			.getAttribute("aria-current"),
		"page",
	);
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	assert.equal(
		await repoNav()
			.getByRole("button", { name: /^Changes/ })
			.getAttribute("aria-current"),
		"page",
	);
});
test("workspace detail explains who works on it, its baseline and overlap, and the owner can release its checkout", async () => {
	await openWorkspace("Implement retry policy");
	const facts = page.locator(".facts");
	await facts.getByText("Started from", { exact: true }).waitFor();
	await facts.getByText(/is also changed in Inspect payment timeout/).waitFor();
	await page.locator(".change-meta").getByText("Codex", { exact: true }).waitFor();
	await page.getByText(/Attached to a worktree through Codex/).waitFor();
	const start = await facts.locator("dd").first().textContent();
	await page.getByRole("button", { name: "Release checkout", exact: true }).click();
	await page.getByText(/Not attached to a checkout\. Continue it anywhere with cruce resume --workspace/).waitFor();
	assert.equal(await page.getByRole("button", { name: "Release checkout", exact: true }).count(), 0);
	await page.locator(".change-header").getByText("Detached", { exact: true }).waitFor();
	assert.equal(await facts.locator("dd").first().textContent(), start);
});
test("workspaces behind canonical say so and show canonical changes without moving their baseline", async () => {
	await page.request.post(`${server.origin}/__fixture/upstream`);
	await openRepo();
	await page.getByRole("button", { name: "1 workspace behind canonical", exact: true }).click();
	const row = workspaceRow("Inspect payment timeout");
	await row.getByText("Behind canonical", { exact: true }).waitFor();
	await row.click();
	const start = await page.locator(".facts dd").first().textContent();
	await page.getByText(/Canonical moved to/).waitFor();
	await page.getByRole("button", { name: "See what changed on canonical", exact: true }).click();
	await page.getByText("also changed in this workspace", { exact: false }).waitFor();
	assert.equal(await page.locator(".facts dd").first().textContent(), start);
});
test("review is a checklist: confirm checks, approve the exact revision, then promote to main", async () => {
	await openChange();
	const promote = page.getByRole("button", { name: "Promote to main", exact: true });
	assert.equal(await promote.isDisabled(), true);
	await page.getByText("Finish the steps above to promote.", { exact: true }).waitFor();
	await page.locator(".patch").waitFor();
	await page.screenshot({ path: "dist/ui-checks/review.png", fullPage: true });
	await page.getByRole("button", { name: "Confirm tests pass", exact: true }).click();
	await page.getByText("Tests confirmed", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Approve", exact: true }).click();
	await page.locator(".change-header").getByText("Ready to promote", { exact: true }).waitFor();
	assert.equal(await promote.isEnabled(), true);
	await promote.click();
	await page.locator(".change-header").getByText("Promoted", { exact: true }).waitFor();
	await page.locator(".canonical-line").getByText(/main/).waitFor();
	await page.getByRole("button", { name: "1 workspace behind canonical", exact: true }).waitFor();
});
test("concerns and failures ask for a reason and block promotion until resolved", async () => {
	await openChange();
	await page.getByRole("button", { name: "Raise concern", exact: true }).click();
	await page.getByLabel("Raise concern note", { exact: true }).fill("Retry bound needs a jitter test");
	await page.locator(".note-action").getByRole("button", { name: "Raise concern", exact: true }).click();
	await page.locator(".change-header").getByText("Has concerns", { exact: true }).waitFor();
	await page.getByText("Retry bound needs a jitter test", { exact: false }).first().waitFor();
	await page.getByRole("button", { name: "Resolve concern", exact: true }).click();
	await page.getByLabel("Resolve concern note", { exact: true }).fill("Covered by the existing bound test");
	await page.locator(".note-action").getByRole("button", { name: "Resolve concern", exact: true }).click();
	await page.locator(".change-header").getByText("Needs review", { exact: true }).waitFor();
});
test("failed promotion preserves canonical source and reuses retry identity", async () => {
	await openChange();
	const before = await page.locator(".canonical-line").innerText();
	await page.getByRole("button", { name: "Confirm tests pass", exact: true }).click();
	await page.getByText("Tests confirmed", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Approve", exact: true }).click();
	await page.locator(".change-header").getByText("Ready to promote", { exact: true }).waitFor();
	const keys = [];
	await page.route("**/command", async (route) => {
		const body = route.request().postDataJSON();
		if (body.tool !== "promote_proposal") return route.continue();
		keys.push(body.idempotencyKey);
		await route.fulfill({ status: 503, json: { error: "Canonical update unavailable" } });
	});
	const promote = page.getByRole("button", { name: "Promote to main", exact: true });
	await promote.click();
	await page.getByRole("alert").filter({ hasText: "Canonical update unavailable" }).first().waitFor();
	await promote.click();
	await page.getByRole("alert").filter({ hasText: "Canonical update unavailable" }).first().waitFor();
	assert.equal(keys.length, 2);
	assert.equal(keys[0], keys[1]);
	assert.equal(await page.locator(".canonical-line").innerText(), before);
	await page.locator(".change-header").getByText("Ready to promote", { exact: true }).waitFor();
});
test("interrupted promotion can reconcile after reload with its persisted operation identity", async () => {
	let command;
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const response = await route.fetch(),
			data = await response.json();
		const proposal = data.proposals[0];
		proposal.state = "promoting";
		command = {
			tool: "promote_proposal",
			namespaceId: "fernloop",
			repositoryId: "payments",
			proposalId: proposal.id,
			idempotencyKey: "durable-promotion-key",
		};
		data.promotionRecovery = { [proposal.id]: { ready: true, reasons: [], command } };
		await route.fulfill({ response, json: data });
	});
	await openChange();
	await page.reload();
	await page.getByRole("button", { name: "Reconcile promotion", exact: true }).waitFor();
	let sent;
	await page.route("**/command", async (route) => {
		if (route.request().postDataJSON().tool !== "promote_proposal") return route.continue();
		sent = route.request().postDataJSON();
		await route.fulfill({ status: 200, json: { state: "complete" } });
	});
	await page.getByRole("button", { name: "Reconcile promotion", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
	assert.deepEqual(sent, command);
});
test("History shows canonical, published revisions and lineage, and browses exact source", async () => {
	const data = await (await page.request.get(`${server.origin}/api/namespaces/fernloop/repositories/payments`)).json();
	const source = data.artifacts.find((a) => a.kind === "source");
	await openRepo();
	await repoNav().getByRole("button", { name: "History", exact: true }).click();
	await page.getByRole("heading", { name: "Canonical main", exact: true }).waitFor();
	await page.locator(".retained-row").filter({ hasText: "Bounded retry policy" }).click();
	assert.ok(page.url().endsWith(`#/history/${source.id}`));
	await page.getByText("Review base", { exact: true }).waitFor();
	await page.getByText("Storage details", { exact: true }).click();
	await page.getByText(source.contentHash, { exact: true }).waitFor();
	await page.getByRole("button", { name: "Trace lineage" }).click();
	await page.locator(".lineage").filter({ hasText: "Implement retry policy" }).waitFor();
	await page.getByRole("button", { name: "Browse files", exact: true }).click();
	await page.getByRole("navigation", { name: "Repository files" }).getByRole("button", { name: "src/retry.ts", exact: true }).click();
	await page.locator(".source-browser pre").getByText("export const retries = 3;", { exact: false }).waitFor();
	await page.reload();
	await page.getByRole("button", { name: "View change #1 →", exact: true }).click();
	await page.getByRole("heading", { name: /Bounded retry policy/, level: 1 }).waitFor();
	await page.goBack();
	await page.getByText("Review base", { exact: true }).waitFor();
});
test("saved links from the retired Code, Work and Artifacts views open the same records", async () => {
	const data = await (await page.request.get(`${server.origin}/api/namespaces/fernloop/repositories/payments`)).json();
	await openRepo();
	await page.goto(`${root()}#/artifacts/source`);
	await page.getByRole("heading", { name: "Bounded retry policy", exact: true }).waitFor();
	await page.getByText("Review base", { exact: true }).waitFor();
	await page.goto(`${root()}#/code/source`);
	await page.getByText("Review base", { exact: true }).waitFor();
	await page.goto(`${root()}#/work/test-report`);
	await page.getByRole("heading", { name: "Retry policy test report", exact: true }).waitFor();
	assert.ok(page.url().endsWith("#/history/test-report"));
	await page.goto(`${root()}#/work/${data.proposals[0].id}`);
	await page.getByRole("heading", { name: /Bounded retry policy/, level: 1 }).waitFor();
	assert.ok(page.url().endsWith(`#/changes/${data.proposals[0].id}`));
	await page.goto(`${root()}#/work/${data.workspaces[1].id}`);
	await page.getByRole("heading", { name: data.workspaces[1].title, exact: true }).waitFor();
	assert.ok(page.url().endsWith(`#/workspaces/${data.workspaces[1].id}`));
});
test("stored evidence is readable beside its change and links back to it", async () => {
	await openChange();
	await page.locator(".timeline").getByRole("button", { name: "Retry policy test report", exact: true }).click();
	assert.ok(page.url().endsWith("#/history/test-report"));
	await page.getByRole("button", { name: "Read evidence", exact: true }).click();
	await page.locator("pre").getByText("Reported tests: 12 passed", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Trace lineage", exact: true }).click();
	await page.locator(".lineage").getByText("Implement retry policy", { exact: true }).waitFor();
	await page.reload();
	await page.getByRole("heading", { name: "Retry policy test report", exact: true }).waitFor();
	await page.getByRole("button", { name: "View change #1 →", exact: true }).click();
	assert.equal(await page.getByRole("button", { name: "Promote to main", exact: true }).isDisabled(), true);
});
test("changes exclude stale and unrelated reports while keeping explicitly linked evidence", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		const report = data.artifacts.find((a) => a.kind === "evidence"),
			proposal = data.proposals[0];
		data.artifacts.push(
			{ ...report, id: "stale", title: "Earlier revision report", revision: proposal.base },
			{ ...report, id: "unrelated", title: "Unrelated workspace report", workspaceId: data.workspaces[0].id },
			{ ...report, id: "linked", title: "Explicitly linked report", workspaceId: data.workspaces[0].id },
		);
		data.verifications.push({
			id: "linked-check",
			proposalId: proposal.id,
			revision: proposal.revision,
			artifactId: "linked",
			kind: "tests",
			outcome: "pass",
			trust: "reported",
			actor: data.workspaces[1].createdBy,
			summary: "Linked reported check",
		});
		await route.fulfill({ json: data });
	});
	await openChange();
	const timeline = page.locator(".timeline");
	await timeline.getByRole("button", { name: "Explicitly linked report", exact: true }).waitFor();
	assert.equal(await timeline.getByRole("button", { name: /Earlier revision report|Unrelated workspace report/ }).count(), 0);
	await page.getByText(/reported a pass: “Linked reported check”/).waitFor();
	await page.goto(`${root()}#/history/stale`);
	await page.getByRole("heading", { name: "Earlier revision report", exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "View change #1 →", exact: true }).count(), 0);
	await page.route("**/command", async (route) =>
		route.request().postDataJSON().tool === "read_artifact" ? route.fulfill({ json: {} }) : route.continue(),
	);
	await page.getByRole("button", { name: "Read evidence", exact: true }).click();
	await page.getByText("Evidence content is unavailable.", { exact: true }).waitFor();
});
test("late evidence responses cannot appear after navigating to a published revision", async () => {
	await page.goto(`${root()}#/history/test-report`);
	await page.getByRole("heading", { name: "Retry policy test report", exact: true }).waitFor();
	let release, received;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const ready = new Promise((resolve) => {
		received = resolve;
	});
	await page.route("**/command", async (route) => {
		if (route.request().postDataJSON().tool !== "read_artifact") return route.continue();
		received();
		await gate;
		await route.fulfill({ json: { content: "STALE EVIDENCE RESPONSE" } });
	});
	await page.getByRole("button", { name: "Read evidence", exact: true }).click();
	await ready;
	await page.getByRole("button", { name: "View revision →", exact: true }).click();
	await page.getByRole("heading", { name: "Bounded retry policy", exact: true }).waitFor();
	const response = page.waitForResponse((r) => r.request().postData()?.includes("read_artifact"));
	release();
	await response;
	await page.getByRole("button", { name: "Trace lineage", exact: true }).click();
	await page.locator(".lineage").waitFor();
	assert.equal(await page.getByText("STALE EVIDENCE RESPONSE", { exact: true }).count(), 0);
});
test("late source responses cannot overwrite a newer history inspection", async () => {
	await page.goto(`${root()}#/history/canonical`);
	await page.getByRole("heading", { name: "Browse source", exact: true }).waitFor();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	let received;
	const ready = new Promise((resolve) => {
		received = resolve;
	});
	await page.route("**/command", async (route) => {
		if (route.request().postDataJSON().tool !== "get_source") return route.continue();
		received();
		await gate;
		await route.fulfill({ json: { files: { "late.ts": "SHOULD NOT REPLACE HISTORY" } } });
	});
	await page.getByRole("button", { name: "Browse files", exact: true }).click();
	await ready;
	await page.getByRole("button", { name: "Commit history", exact: true }).click();
	await page.locator(".commit-history").waitFor();
	const response = page.waitForResponse((r) => r.request().postData()?.includes("get_source"));
	release();
	await response;
	assert.equal(await page.locator(".source-browser").count(), 0);
	assert.equal(await page.locator(".commit-history").count(), 1);
});
test("teams and invitation links are functional", async () => {
	await page.goto(`${server.origin}/?namespace=fernloop`);
	await namespaceNav().getByRole("button", { name: "Teams", exact: true }).click();
	await page.locator("summary").filter({ hasText: "Create team" }).click();
	await page.getByLabel("Team name").fill("Platform");
	await page.getByRole("checkbox", { name: "Alex Morgan" }).check();
	await page.getByRole("button", { name: "Create team", exact: true }).click();
	await page.locator("summary").filter({ hasText: "Platform" }).waitFor();
	await namespaceNav().getByRole("button", { name: "Members", exact: true }).click();
	await page.getByLabel("Email", { exact: true }).fill("alex@example.com");
	await page.getByRole("button", { name: "Create invitation link" }).click();
	await page.getByRole("status").filter({ hasText: "/invite/fernloop" }).waitFor();
});
test("namespace settings inherit installation storage and show today's operation budget", async () => {
	await page.goto(`${server.origin}/?namespace=fernloop#/settings`);
	await page.getByRole("heading", { name: "Git storage", exact: true }).waitFor();
	await page.getByText("Managed by this Cruce installation.", { exact: false }).waitFor();
	await page.getByText(/of 100/).waitFor();
	await page.getByText("Create workspace forks", { exact: false }).waitFor();
	assert.equal(await page.getByLabel("API token", { exact: false }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Connect account", exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Replace token", exact: true }).count(), 0);
});
test("unavailable installation storage explains administrator setup without requesting customer credentials", async () => {
	await page.route("**/api/namespaces/fernloop", async (route) => {
		const response = await route.fetch();
		const data = await response.json();
		await route.fulfill({
			response,
			json: {
				...data,
				storage: { mode: "deployment", ready: false, reason: "Installation storage is unavailable; contact the administrator" },
			},
		});
	});
	await page.goto(`${server.origin}/?namespace=fernloop#/settings`);
	await page.getByText("Installation storage is unavailable; contact the administrator", { exact: true }).waitFor();
	assert.equal(await page.getByLabel("API token", { exact: false }).count(), 0);
	assert.equal(await page.getByLabel("Account ID", { exact: true }).count(), 0);
	await page.unroute("**/api/namespaces/fernloop");
});
test("namespace home, account and creation remain usable on mobile", async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(server.origin);
	await page.getByRole("button", { name: "Fernloop", exact: true }).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.screenshot({ path: "dist/ui-checks/namespaces-mobile.png", fullPage: true });
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("region", { name: "Your account", exact: true }).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Fernloop", exact: true }).click();
	await page.getByRole("button", { name: "New repository", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "New repository" });
	await dialog.getByLabel("Repository name", { exact: true }).fill("mobile-tools");
	await page.screenshot({ path: "dist/ui-checks/create-mobile.png", fullPage: true });
	await dialog.getByRole("button", { name: "Add repository", exact: true }).click();
	await page.getByRole("heading", { name: "mobile-tools", exact: true }).waitFor();
});
test("repository clone uses normal Git and fork deletion waits until the workspace ends", async () => {
	await openRepo();
	await page.getByRole("button", { name: "Clone", exact: true }).click();
	await page.getByText(`git clone ${server.origin}/mcp/git/fernloop/payments/canonical.git`, { exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	await workspaceRow("Implement retry policy").click();
	await page.getByText("Workspace fork is available.", { exact: false }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Delete fork" }).isDisabled(), true);
	await page.getByText("End the workspace before cleaning up its fork.", { exact: false }).waitFor();
});
test("unknown canonical, quiet and detached workspaces stay distinct from accepted source", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const response = await route.fetch(),
			data = await response.json();
		delete data.sourceHead;
		data.workspaces[0].state = "disconnected";
		const { execution: _, ...detached } = data.workspaces[0];
		data.workspaces.push({ ...detached, id: "detached", title: "Paused elsewhere", state: "detached" });
		await route.fulfill({ json: data });
	});
	await openRepo();
	await page
		.locator(".canonical-line")
		.getByText(/Canonical revision unavailable/)
		.waitFor();
	await page.getByRole("button", { name: "1 workspace not reporting", exact: true }).click();
	await workspaceRow("Paused elsewhere").getByText("Detached", { exact: true }).waitFor();
	await page.locator(".workspace-row").getByText("Not reporting", { exact: true }).waitFor();
	assert.equal(await page.locator(".workspace-row").count(), 3);
	assert.equal(await page.getByRole("button", { name: "Clone", exact: true }).isDisabled(), true);
});
test("namespace failures remain unavailable on Home and retry restores attention counts", async () => {
	let fail = true;
	await page.route("**/api/namespaces/fernloop", async (route) =>
		fail ? route.fulfill({ status: 503, json: { error: "Namespace temporarily unavailable" } }) : route.continue(),
	);
	await page.goto(server.origin);
	await page.getByRole("alert").filter({ hasText: "Namespace temporarily unavailable" }).waitFor();
	assert.equal(await page.locator(".repo-row").count(), 0);
	fail = false;
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await page.locator(".repo-row").getByText("1 to review", { exact: true }).waitFor();
});
test("screen families remain readable across desktop, tablet, mobile and 200 percent zoom", async () => {
	const data = await (await page.request.get(`${server.origin}/api/namespaces/fernloop/repositories/payments`)).json();
	const routes = [
		["home", server.origin, "Your repositories"],
		["changes", root(), "payment-service"],
		["review", `${root()}#/changes/${data.proposals[0].id}`, /Bounded retry policy/],
		["workspaces", `${root()}#/workspaces`, "payment-service"],
		["workspace", `${root()}#/workspaces/${data.workspaces[0].id}`, data.workspaces[0].title],
		["history", `${root()}#/history`, "Canonical main"],
		["revision", `${root()}#/history/${data.artifacts[0].id}`, "Bounded retry policy"],
		["evidence", `${root()}#/history/test-report`, "Retry policy test report"],
		["repository-settings", `${root()}#/settings`, "Review policy"],
		["members", `${server.origin}/?namespace=fernloop#/members`, "Fernloop"],
		["teams", `${server.origin}/?namespace=fernloop#/teams`, "Fernloop"],
		["namespace-settings", `${server.origin}/?namespace=fernloop#/settings`, "Daily operations"],
		["account", `${server.origin}/?page=account`, "Your repositories"],
	];
	for (const width of [1440, 1024, 390]) {
		await page.setViewportSize({ width, height: 1000 });
		for (const [name, url, title] of routes) {
			await page.goto(url);
			await page
				.getByRole("heading", { name: title, exact: typeof title === "string" })
				.first()
				.waitFor();
			if (name === "account") await page.getByRole("region", { name: "Your account", exact: true }).waitFor();
			if (name === "revision") {
				await page.getByRole("button", { name: "Trace lineage", exact: true }).click();
				await page.locator(".lineage").waitFor();
			}
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
				false,
				`${name} overflow at ${width}`,
			);
			await page.screenshot({ path: `dist/ui-checks/${name}-${width}.png`, fullPage: true });
		}
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(root());
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	await page.evaluate(() => {
		document.documentElement.style.zoom = "2";
	});
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	assert.equal(await page.getByRole("button", { name: "Switch namespace" }).isVisible(), true);
	await page.screenshot({ path: "dist/ui-checks/overview-zoom.png", fullPage: true });
	await page.evaluate(() => {
		document.documentElement.style.zoom = "";
	});
	await page.goto(server.origin);
	await page.setContent(
		`<html><body style="margin:0;background:#f5f5ef"><img alt="Identity exploration" src="${server.origin}/brand/study.svg" width="900" height="790"></body></html>`,
	);
	await page.locator("img").evaluate((img) => img.decode());
	await page.screenshot({ path: "dist/ui-checks/brand-study.png", fullPage: true });
	await page.setContent(
		`<html><body style="margin:32px;background:#f5f5ef;font-family:Arial"><h1>Cruce / optical sizes</h1>${["symbol-ink", "symbol-white", "symbol"].map((name) => `<div style="display:flex;align-items:center;gap:48px;padding:32px;background:${name === "symbol-ink" ? "#f5f5ef" : "#17251f"}">${[16, 24, 32].map((size) => `<img alt="${name} ${size}px" src="${server.origin}/brand/${name}.svg" width="${size}" height="${size}">`).join("")}</div>`).join("")}</body></html>`,
	);
	await page.locator("img").evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode())));
	await page.screenshot({ path: "dist/ui-checks/brand-sizes.png", fullPage: true });
});
test("many workspaces, long paths and read-only authority stay usable on a phone", async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		const original = data.workspaces[0];
		data.workspaces = Array.from({ length: 8 }, (_, i) => ({
			...original,
			id: `writer-${i}`,
			startedAt: i,
			title: `Independent change ${i} ${"extended-description-".repeat(5)}`,
			branch: `cruce/${"long-branch-".repeat(10)}`,
		}));
		data.workspaces.push({ ...original, id: "ended", state: "completed" });
		data.overlaps = [
			{
				id: "one",
				kind: "file",
				surface: `src/${"nested/".repeat(15)}renamed-file.ts`,
				workspaces: ["writer-0", "writer-2"],
				evidence: "reported",
				observedAt: 1,
			},
			{ id: "two", kind: "file", surface: "assets/binary.dat", workspaces: ["writer-3", "writer-7"], evidence: "reported", observedAt: 1 },
		];
		data.permissions = { write: false, maintain: false, human: true };
		await route.fulfill({ json: data });
	});
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	assert.equal(await page.locator(".workspaces-screen > .rows > .workspace-row").count(), 8);
	await page.getByText("1 ended workspace", { exact: true }).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	await page.screenshot({ path: "dist/ui-checks/many-writers-mobile.png", fullPage: true });
	await repoNav()
		.getByRole("button", { name: /^Changes/ })
		.click();
	await page.locator(".change-row").filter({ hasText: "Bounded retry policy" }).click();
	assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Promote to main", exact: true }).count(), 0);
	await page.getByText("A repository maintainer confirms checks and promotes.", { exact: true }).waitFor();
});
