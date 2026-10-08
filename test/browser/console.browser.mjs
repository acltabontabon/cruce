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
	await page.getByRole("heading", { name: "Code is written in parallel now. The decision is still yours.", level: 1 }).waitFor();
}
const stageNames = ["Baseline", "Work", "Overlap", "Review", "Promote", "Reconcile", "Continue"];
const stageDurations = [3800, 4400, 4800, 5400, 4600, 5400, 6000];
const desktop = (selector) => page.locator(`.crossing-desktop ${selector}`);
test("initial identity failures can retry without signing in again", async () => {
	let fail = true;
	await page.route("**/api/me", (route) =>
		fail ? route.fulfill({ status: 503, json: { error: "Identity temporarily unavailable" } }) : route.continue(),
	);
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Connection unavailable", exact: true }).waitFor();
	fail = false;
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
});
test("namespace access denial clears settings and controls, and successful retry restores them", async () => {
	await page.clock.install();
	let denied = false;
	await page.route("**/api/namespaces/fernloop", (route) =>
		denied ? route.fulfill({ status: 403, json: { error: "Namespace access denied" } }) : route.continue(),
	);
	await page.goto(`${server.origin}/?namespace=fernloop#/settings`);
	await page.getByRole("heading", { name: "Storage operations", exact: true }).waitFor();
	denied = true;
	await page.clock.fastForward(15000);
	await page.getByRole("alert").filter({ hasText: "Namespace access denied" }).waitFor();
	assert.equal(await page.getByRole("heading", { name: "Storage operations", exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Save namespace", exact: true }).count(), 0);
	denied = false;
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await page.getByRole("heading", { name: "Storage operations", exact: true }).waitFor();
});
test("slow polling does not overlap, and a forced refresh rejects the earlier response", async () => {
	await page.clock.install();
	let armed = false,
		calls = 0,
		failNamespace = false;
	let release, started;
	const waiting = new Promise((resolve) => {
		started = resolve;
	});
	const held = new Promise((resolve) => {
		release = resolve;
	});
	await page.route("**/api/namespaces/fernloop", (route) =>
		failNamespace ? route.fulfill({ status: 503, json: { error: "Refresh unavailable" } }) : route.continue(),
	);
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const response = await route.fetch(),
			data = await response.json();
		if (armed) {
			calls++;
			data.repository.name = calls === 1 ? "Earlier snapshot" : "Current snapshot";
			if (calls === 1) {
				started();
				await held;
			}
		}
		await route.fulfill({ json: data });
	});
	try {
		await openRepo();
		armed = true;
		failNamespace = true;
		await page.clock.fastForward(15000);
		await waiting;
		await page.clock.fastForward(15000);
		assert.equal(calls, 1);
		await page.getByRole("alert").filter({ hasText: "Refresh unavailable" }).waitFor();
		failNamespace = false;
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await page.getByRole("heading", { name: "Current snapshot", exact: true }).waitFor();
		release();
		await page.waitForTimeout(100);
		assert.equal(await page.getByRole("heading", { name: "Earlier snapshot", exact: true }).count(), 0);
	} finally {
		release();
	}
});
test("partial repository status stays unavailable rather than showing zero attention", async () => {
	await page.route("**/api/namespaces/fernloop", async (route) => {
		const response = await route.fetch(),
			data = await response.json();
		data.repositorySummaries = [];
		data.repositoryFailures = data.repositories.map((repo) => ({ repositoryId: repo.id, message: "Status unavailable" }));
		await route.fulfill({ json: data });
	});
	await page.goto(`${server.origin}/?namespace=fernloop`);
	await page.getByText("Counts cover available repositories.", { exact: false }).waitFor();
	assert.equal(await page.locator(".stats").getByText("—", { exact: true }).count(), 3);
	assert.equal(await page.getByRole("button", { name: "Retry unavailable repositories", exact: true }).count(), 1);
});
test("repository setup only clones or attaches, and links one-time machine setup", async () => {
	await openRepo();
	await page.getByRole("button", { name: "Set up locally", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Set up locally", exact: true });
	await dialog.getByText(/git clone https?:/).waitFor();
	// Installing, authorizing Git and connecting tools happen once per machine, never per repository.
	assert.equal(await dialog.getByText(/npm install|cruce (auth|login|connect)/).count(), 0);
	assert.equal(await dialog.getByText(/path\/to\/cruce/).count(), 0);
	await page.screenshot({ path: "dist/ui-checks/setup-clone.png", fullPage: true });
	await dialog.getByRole("button", { name: "Existing checkout", exact: true }).click();
	await dialog.getByText(/git remote add cruce https?:.*\/canonical\.git/).waitFor();
	await dialog.getByText(/history and existing remotes stay as they are/).waitFor();
	await dialog.getByText(/creates an isolated fork and uses namespace resource operations/).waitFor();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Set up locally", exact: true }).click();
	await dialog.getByRole("link", { name: "Local setup", exact: true }).click();
	await page.getByRole("heading", { name: "Local setup", level: 1 }).waitFor();
	assert.equal(new URL(page.url()).search, "?page=setup");
	assert.equal(await page.getByRole("dialog").count(), 0);
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
});
test("review remains usable after approval and after a failed evidence result", async () => {
	await openChange();
	await page.getByRole("button", { name: "Approve", exact: true }).click();
	await page.getByRole("button", { name: "Approve again", exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Raise concern", exact: true }).isVisible(), true);
	await page.getByRole("button", { name: "Record failure", exact: true }).click();
	await page.getByLabel("Record failure note", { exact: true }).fill("Check needs another run");
	await page.locator(".note-action").getByRole("button", { name: "Record failure", exact: true }).click();
	await page.locator(".checklist").getByText("Tests failing", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Record updated tests pass", exact: true }).click();
	await page.locator(".checklist").getByText("Tests attested", { exact: false }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Promote to main", exact: true }).isEnabled(), true);
	await page.screenshot({ path: "dist/ui-checks/review-completed-checks.png", fullPage: true });
});
test("historical approvals require a fresh decision and Developers cannot approve", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json(),
			proposal = data.proposals[0];
		proposal.reviews.push({
			id: "historical",
			actor: { id: "former", userId: "former", name: "Former reviewer", kind: "human" },
			revision: proposal.revision,
			outcome: "approve",
			reason: "Old approval",
			at: 0,
		});
		data.readiness[proposal.id].checks.approved = false;
		data.permissions = { write: true, human: true, maintain: false, approve: false };
		await route.fulfill({ json: data });
	});
	await openChange();
	assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Raise concern", exact: true }).isVisible(), true);
	await page.getByText("A human repository maintainer attests evidence, approves and promotes.", { exact: true }).waitFor();
});
test("copy failures provide a manual-copy alternative", async () => {
	await openRepo();
	await page.evaluate(() =>
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } }),
	);
	await page.getByRole("button", { name: "Set up locally", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).first().click();
	await page.getByRole("alert").filter({ hasText: "Select and copy the command above." }).waitFor();
});
test("metadata-only Git changes remain visible in source review", async () => {
	await page.route("**/command", (route) => {
		const body = route.request().postDataJSON();
		if (body.tool !== "get_diff") return route.continue();
		return route.fulfill({
			json: {
				files: [
					{
						path: "script.sh",
						status: "modified",
						additions: 0,
						deletions: 0,
						binary: false,
						tooLarge: false,
						before: { oid: "a".repeat(40), mode: "100644", type: "blob" },
						after: { oid: "a".repeat(40), mode: "100755", type: "blob" },
					},
				],
				additions: 0,
				deletions: 0,
				statsComplete: true,
				...(body.path ? { file: { path: "script.sh", patch: null, reason: "File mode changed; contents unchanged." } } : {}),
			},
		});
	});
	await openChange();
	await page.getByText("Mode 100644 → 100755.", { exact: false }).waitFor();
	await page.getByText("File mode changed; contents unchanged.", { exact: true }).waitFor();
});
test("a completed mutation cannot navigate away from the page opened while it was pending", async () => {
	let release, started;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	const waiting = new Promise((resolve) => {
		started = resolve;
	});
	await page.route("**/api/namespaces", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		const response = await route.fetch();
		started();
		await held;
		await route.fulfill({ response });
	});
	try {
		await page.goto(`${server.origin}/?namespace=fernloop`);
		await page.getByRole("button", { name: "Switch namespace", exact: true }).click();
		await page.getByRole("button", { name: "Create namespace", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Create namespace", exact: true });
		await dialog.getByLabel("Name", { exact: true }).fill("Later result");
		await dialog.getByRole("button", { name: "Create namespace", exact: true }).click();
		await waiting;
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.getByRole("link", { name: "Cruce home", exact: true }).click();
		await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
		release();
		await page.waitForTimeout(100);
		assert.equal(new URL(page.url()).search, "");
		assert.equal(await page.getByRole("heading", { name: "Your repositories", exact: true }).isVisible(), true);
	} finally {
		release();
	}
});
test("public homepage leads with context, then shows how it works, without requesting private repository data", async () => {
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
	assert.equal(await page.getByRole("link", { name: /Sign up|Get started/ }).count(), 0);
	await page.getByText("Cruce is in early development.", { exact: true }).waitFor();
	assert.equal(await page.locator("main > section").count(), 3);
	assert.deepEqual(privateRequests, []);
	// Workspaces carry the hierarchy; tools are annotations on local work.
	assert.equal((await desktop(".graph-workspace").allTextContents()).join(","), "workspace/auth,workspace/billing,workspace/deps");
	assert.deepEqual(await desktop(".graph-tool").allTextContents(), [
		"via Claude Code · local work",
		"via Codex · local work",
		"via Cursor · local work",
	]);
	assert.equal(await page.locator(".graph-message, .graph-worker").count(), 0);
	assert.deepEqual(await page.getByRole("list", { name: "What Cruce does not do" }).getByRole("listitem").allTextContents(), [
		"Runs no agents",
		"Replaces no Git",
		"Lands nothing without a human",
	]);
	for (const heading of [
		"Many paths. One history.",
		"However many agents you run.",
		"Work outlives the session.",
		"What you approve is what lands.",
		"Bring any agent. Keep Git.",
	])
		await page.getByRole("heading", { name: heading }).waitFor();
	await page.getByText("cruce push", { exact: true }).waitFor();
	assert.match(await page.getByRole("img", { name: /canonical is promoted to exactly 7be2d14/ }).textContent(), /human approval/);
	// Context first, then how it works, then what stays true: a short page, not a template.
	assert.deepEqual(await page.locator("main > section h1, main > section > :is(div, header) > h2").allTextContents(), [
		"Code is written in parallel now.The decision is still yours.",
		"Many paths.One history.",
		"However many agents you run.",
	]);
	await page.getByRole("list", { name: "Three generations of software development" }).getByText("III · Agentic").waitFor();
	const height = await page.evaluate(() => document.documentElement.scrollHeight / innerHeight);
	assert.equal(height < 3.6, true, `page is ${height.toFixed(2)} screens tall`);
});
test("illustration binds review, approval and canonical to one exact revision at every step", async () => {
	await openHomepage();
	const story = page.getByRole("group", { name: "Development story stages" });
	const graph = page.locator(".crossing-desktop");
	const expected = [
		{ canonical: "c3d8a90", promotions: 0, heads: ["c3d8a90", "c3d8a90", "c3d8a90"] },
		{ canonical: "c3d8a90", promotions: 0, heads: ["a42f91c", "96cd0e3", "f881b27"] },
		{ canonical: "c3d8a90", promotions: 0, heads: ["a42f91c", "96cd0e3", "f881b27"] },
		{ canonical: "c3d8a90", promotions: 0, heads: ["a42f91c", "96cd0e3", "f881b27"] },
		{ canonical: "a42f91c", promotions: 1, heads: ["a42f91c", "96cd0e3", "f881b27"] },
		{ canonical: "a42f91c", promotions: 1, heads: ["a42f91c", "7be2d14", "f881b27"] },
		{ canonical: "7be2d14", promotions: 2, heads: ["a42f91c", "7be2d14", "0d93e5a"] },
	];
	for (const [stage, name] of stageNames.entries()) {
		await story.getByRole("button", { name, exact: true }).click();
		assert.equal(await graph.getAttribute("data-canonical"), expected[stage].canonical, name);
		assert.equal(await desktop(".graph-promotion.is-visible").count(), expected[stage].promotions, name);
		assert.deepEqual(
			await desktop(".graph-lane").evaluateAll((lanes) => lanes.map((lane) => lane.dataset.head)),
			expected[stage].heads,
			name,
		);
		// The baseline is immutable: it is drawn and named identically in every moment.
		assert.equal(await desktop(".graph-baseline + text").textContent(), "c3d8a90");
		assert.equal(await desktop(".graph-overlap.is-visible").count(), stage === 2 ? 1 : 0, name);
		await page.screenshot({ path: `dist/ui-checks/homepage-stage-${stage}.png` });
	}
	await story.getByRole("button", { name: "Overlap", exact: true }).click();
	assert.match(await desktop(".graph-overlap").textContent(), /shares src\/auth\/session\.ts.*advisory · not a conflict/);
	assert.match(await page.locator(".sequence-description").textContent(), /not a conflict verdict/);
	await story.getByRole("button", { name: "Review", exact: true }).click();
	assert.match(await desktop(".graph-review.is-visible").textContent(), /proposal a42f91c.*approved by a human/);
	assert.match(await page.locator(".sequence-description").textContent(), /Only an authenticated human approval satisfies promotion/);
	await story.getByRole("button", { name: "Continue", exact: true }).click();
	// What canonical became is exactly what was reviewed, in promotion order.
	assert.deepEqual(await desktop(".graph-promotion text:first-of-type").allTextContents(), ["a42f91c", "7be2d14"]);
	const nodes = await desktop(".graph-canonical-node").evaluateAll((circles) => circles.map((c) => Number(c.getAttribute("cx"))));
	assert.equal(nodes[0] < nodes[1], true);
	assert.match(await page.locator(".sequence-description").textContent(), /deps keeps working/);
	await page.setViewportSize({ width: 390, height: 1000 });
	assert.equal(await page.locator(".crossing-mobile").isVisible(), true);
	assert.equal(await page.locator(".crossing-desktop").isVisible(), false);
	assert.equal(await page.locator(".crossing-mobile .graph-canonical-node").count(), 2);
	await page.locator(".hero-sequence").screenshot({ path: "dist/ui-checks/homepage-mobile-continue.png" });
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
	await page.getByRole("heading", { name: "Code is written in parallel now. The decision is still yours.", level: 1 }).waitFor();
	assert.equal(new URL(page.url()).pathname, "/");
	await page.reload();
	await page.getByRole("heading", { name: "Code is written in parallel now. The decision is still yours.", level: 1 }).waitFor();
});
test("sign-in preserves a saved repository revision and invitation fragment without changing the login URL", async () => {
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.goto(`${server.origin}/?namespace=fernloop&repository=payments#/code/source`);
	await page.getByRole("heading", { name: "Bounded retry policy", exact: true }).waitFor();
	assert.equal(new URL(page.url()).hash, "#/code/source");
	assert.equal(new URL(page.url()).search, "?namespace=fernloop&repository=payments");
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.goto(`${server.origin}/invite/fernloop#fixture-invitation`);
	await page.getByRole("heading", { name: "Join namespace", exact: true }).waitFor();
	assert.equal(new URL(page.url()).pathname, "/invite/fernloop");
	assert.equal(new URL(page.url()).hash, "#fixture-invitation");
});
test("sign-in goes directly to Access and saved sign-in links skip the removed page", async () => {
	await openHomepage();
	assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).getAttribute("href"), "/auth/login");
	await page.getByRole("link", { name: "Sign in", exact: true }).click();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.goto(`${server.origin}/sign-in`);
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	assert.equal(new URL(page.url()).pathname, "/");
	assert.equal(await page.locator(".sign-in").count(), 0);
});
test("fast session checks do not flash loading content; slow checks remain visible", async () => {
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await page.addInitScript(() => {
		window.loadingMessages = [];
		new MutationObserver(() => {
			const status = document.querySelector(".session-status [role=status]");
			if (status) window.loadingMessages.push(status.textContent);
		}).observe(document, { childList: true, subtree: true });
	});
	await openHomepage();
	assert.deepEqual(await page.evaluate(() => window.loadingMessages), []);
	assert.equal(await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(245, 245, 239)");
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false, delay: 900 } });
	await page.goto(server.origin);
	await page.getByRole("status").filter({ hasText: "Checking sign-in…" }).waitFor();
	assert.equal(await page.locator(".session-status").evaluate((element) => element.getBoundingClientRect().height <= innerHeight), true);
	assert.equal(await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(245, 245, 239)");
	await page.getByRole("heading", { name: "Code is written in parallel now. The decision is still yours.", level: 1 }).waitFor();
});
test("local setup is once per machine, then lists what each connection may do and revokes one", async () => {
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("link", { name: "Local setup", exact: true }).click();
	await page.getByRole("heading", { name: "Local setup", level: 1 }).waitFor();
	assert.equal(new URL(page.url()).search, "?page=setup");
	assert.equal(await page.title(), "Local setup · Cruce");
	const main = page.locator("main");
	await main.getByText(/npm install --global .*downloads\/cruce-client.tgz/).waitFor();
	const download = await page.request.get(`${server.origin}/downloads/cruce-client.tgz`);
	assert.equal(download.status(), 200);
	assert.equal(download.headers()["content-type"], "application/gzip");
	assert.deepEqual([...(await download.body()).subarray(0, 2)], [0x1f, 0x8b]);
	await main.getByText(`cruce login --server ${server.origin}`, { exact: true }).waitFor();
	await main.getByText(`cruce connect --server ${server.origin} --client claude`, { exact: true }).waitFor();
	// Nothing on this page names a repository: one setup serves every repository the person can access.
	assert.equal(await main.getByText(/--namespace|--repository/).count(), 0);
	await main.getByRole("button", { name: "Codex", exact: true }).click();
	await main.getByText(`cruce connect --server ${server.origin} --client codex`, { exact: true }).waitFor();
	assert.equal(await main.getByRole("button", { name: "Codex", exact: true }).getAttribute("aria-pressed"), "true");
	await main.getByText("codex", { exact: true }).waitFor();
	// The heading renders before /api/connections settles; wait for the loaded list before reading it.
	await page.locator("#connections-heading .panel-count", { hasText: "4" }).waitFor();
	const rows = page.locator(".connection-row");
	await rows.nth(3).waitFor();
	await page.waitForTimeout(250); // Let the 140ms selection transition finish before capturing.
	await page.screenshot({ path: "dist/ui-checks/local-setup.png", fullPage: true });
	assert.deepEqual(await rows.locator("strong").allTextContents(), ["Cursor", "Codex", "release-check script", "Claude Code"]);
	// Known reported names get their mark; anything else falls back to initials.
	assert.deepEqual(await rows.locator(".agent-mark").evaluateAll((marks) => marks.map((m) => m.dataset.agent ?? m.textContent)), [
		"cursor",
		"codex",
		"RC",
		"claude",
	]);
	assert.equal(await rows.filter({ hasText: "Cursor" }).getByText("All repositories you can access", { exact: true }).count(), 1);
	const codex = rows.filter({ hasText: "Codex" });
	assert.equal(await codex.locator("code").textContent(), "fernloop/payment-service");
	assert.deepEqual(await codex.locator(".connection-abilities li").allTextContents(), ["Workspaces", "Publish revisions", "Changes"]);
	assert.equal(await rows.filter({ hasText: "Claude Code" }).getByText("Repositories not recorded").count(), 1);
	assert.equal(await codex.getByRole("button", { name: "Revoke Codex" }).evaluate((e) => getComputedStyle(e).height), "32px");
	await codex.getByRole("button", { name: "Revoke Codex" }).click();
	const dialog = page.getByRole("dialog", { name: "Revoke Codex?" });
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	assert.equal(await rows.count(), 4);
	await codex.getByRole("button", { name: "Revoke Codex" }).click();
	await dialog.getByRole("button", { name: "Revoke connection", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "Codex was revoked." }).waitFor();
	assert.deepEqual(await rows.locator("strong").allTextContents(), ["Cursor", "release-check script", "Claude Code"]);
	assert.deepEqual(
		(await (await page.request.get(`${server.origin}/__fixture/calls`)).json()).filter((call) => call.revoke),
		[{ revoke: "grant-codex" }],
	);
	await page.goBack();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	await page.goto(`${server.origin}/?page=setup`);
	await page.getByRole("heading", { name: "Local setup", level: 1 }).waitFor();
	await page.getByRole("heading", { name: /Agent connections/, level: 2 }).waitFor();
	await page.setViewportSize({ width: 320, height: 800 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.setViewportSize({ width: 1440, height: 1000 });
});
test("session failures retain a retry state and stale confirmation cannot remount an expired console", async () => {
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: true, failure: true } });
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Connection unavailable." }).waitFor();
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await page.getByRole("heading", { name: "Code is written in parallel now. The decision is still yours.", level: 1 }).waitFor();
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: true, delay: 2000 } });
	await page.goto(server.origin);
	await page.getByRole("status").waitFor();
	await page.route("**/auth/login", (route) =>
		route.fulfill({ contentType: "text/html", body: "<h1>Fixture Access sign-in boundary</h1>" }),
	);
	await page.evaluate(() => window.dispatchEvent(new Event("cruce:session-expired")));
	await page.getByRole("heading", { name: "Fixture Access sign-in boundary", level: 1 }).waitFor();
	await page.waitForTimeout(2200);
	assert.equal(await page.getByRole("heading", { name: "Your repositories", exact: true }).count(), 0);
});
test("expired console requests clear private views and public anchors do not rewrite console deep links", async () => {
	await openRepo();
	await page.request.post(`${server.origin}/__fixture/session`, { data: { authenticated: false } });
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("button", { name: "Switch namespace", exact: true }).click();
	await page.route("**/auth/login", (route) =>
		route.fulfill({ contentType: "text/html", body: "<h1>Fixture Access sign-in boundary</h1>" }),
	);
	// Trigger a normal console read after revocation without waiting for the polling interval.
	await page.evaluate(async () => {
		const { request } = await import("/src/ui/request.ts");
		try {
			await request("/api/me");
		} catch {}
	});
	await page.getByRole("heading", { name: "Fixture Access sign-in boundary", level: 1 }).waitFor();
	assert.equal(await page.locator(".shell").count(), 0);
	assert.equal(new URL(page.url()).pathname, "/auth/login");
	assert.equal(await page.evaluate(() => sessionStorage.getItem("cruce:sign-in-destination")), "/?namespace=fernloop&repository=payments");
	await page.unroute("**/auth/login");
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
	const overlap = page.getByRole("group", { name: "Development story stages" }).getByRole("button", { name: "Overlap" });
	await overlap.focus();
	await page.keyboard.press("Enter");
	assert.equal(await overlap.getAttribute("aria-pressed"), "true");
	await page.evaluate(() => document.activeElement?.blur());
	assert.equal(await page.getByRole("button", { name: "Replay", exact: true }).count(), 1);
	for (const width of [1440, 1024, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px scrolls sideways`);
		assert.equal(
			await page.locator(".identity-record code, .title-block code").evaluateAll((codes) =>
				codes.every((code) => {
					const box = code.getBoundingClientRect();
					return box.height < 24 && code.scrollWidth <= code.clientWidth + 1;
				}),
			),
			true,
			`${width}px: revision identities must stay readable on one line`,
		);
		await page.screenshot({ path: `dist/ui-checks/homepage-${width}.png`, fullPage: true });
	}
	assert.equal(await page.locator(".crossing-mobile").isVisible(), true);
	assert.equal(await page.locator(".crossing-desktop").isVisible(), false);
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
	// The story sits below the context; it waits, unadvanced, until it is actually seen.
	await page.clock.runFor(stageDurations[0] * 2);
	assert.equal(await story.getByRole("button", { name: "Baseline" }).getAttribute("aria-pressed"), "true");
	await page.locator(".hero-sequence").scrollIntoViewIfNeeded();
	await page.waitForTimeout(80);
	await page.clock.runFor(stageDurations[0] + 100);
	assert.equal(await story.getByRole("button", { name: "Work" }).getAttribute("aria-pressed"), "true");
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	assert.equal(await page.locator(".hero-sequence").getAttribute("data-motion"), "paused");
	await page.clock.runFor(6000);
	assert.equal(await story.getByRole("button", { name: "Work" }).getAttribute("aria-pressed"), "true");
	await story.getByRole("button", { name: "Baseline", exact: true }).click();
	await page.getByRole("button", { name: "Play", exact: true }).click();
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.clock.runFor(6000);
	assert.equal(await story.getByRole("button", { name: "Baseline" }).getAttribute("aria-pressed"), "true");
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, value: false });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.setViewportSize({ width: 1440, height: 100 });
	await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
	await page.waitForTimeout(80); // Allow the browser's native IntersectionObserver to observe the scroll.
	await page.clock.runFor(6000);
	assert.equal(await story.getByRole("button", { name: "Baseline" }).getAttribute("aria-pressed"), "true");
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator(".hero-sequence").scrollIntoViewIfNeeded();
	await page.waitForTimeout(80);
	for (const duration of stageDurations) await page.clock.runFor(duration + 100);
	assert.equal(await story.getByRole("button", { name: "Continue" }).getAttribute("aria-pressed"), "true");
	await page.getByRole("button", { name: "Replay", exact: true }).waitFor();
	await page.clock.runFor(10000);
	assert.equal(await story.getByRole("button", { name: "Continue" }).getAttribute("aria-pressed"), "true");
});
test("hero draws native SVG paths smoothly and Pause holds a promotion mid-flight", async () => {
	await openHomepage();
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.getByRole("button", { name: "Promote", exact: true }).click();
	await page.getByRole("button", { name: "Play", exact: true }).click();
	const curve = desktop(".graph-promotion.is-current path");
	await page.waitForTimeout(450);
	const offset = await curve.evaluate((element) => Number.parseFloat(getComputedStyle(element).strokeDashoffset));
	const length = await curve.evaluate((element) => element.getTotalLength());
	assert.equal(offset > 0 && offset < length, true, `offset ${offset} of ${length}`);
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await page.waitForFunction(
		() => document.querySelector(".crossing-desktop .graph-promotion.is-current path").getAnimations()[0].playState === "paused",
	);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const pausedAt = await curve.evaluate((element) => element.getAnimations()[0].currentTime);
	await page.waitForTimeout(150);
	assert.equal(await curve.evaluate((element) => element.getAnimations()[0].currentTime), pausedAt);
	assert.equal(await curve.evaluate((element) => getComputedStyle(element.parentElement).opacity), "1");
	await page.screenshot({ path: "dist/ui-checks/homepage-motion-paused.png" });
	await page.getByRole("button", { name: "Play", exact: true }).click();
	await page.waitForFunction(
		(frozen) => {
			const animation = document.querySelector(".crossing-desktop .graph-promotion.is-current path").getAnimations()[0];
			return animation.playState !== "paused" && animation.currentTime > frozen;
		},
		pausedAt,
		{ timeout: 2500 },
	);
});
test("revision tokens ride only their own Git paths and nothing passes between workspaces", async () => {
	await openHomepage();
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const failures = [];
	for (const stage of ["Baseline", "Promote", "Reconcile"]) {
		await page.getByRole("button", { name: stage, exact: true }).click();
		await page.getByRole("button", { name: "Play", exact: true }).click();
		await page.waitForTimeout(60);
		await page.getByRole("button", { name: "Pause", exact: true }).click();
		failures.push(
			...(await page.evaluate(async (stage) => {
				const found = [];
				const tokens = [...document.querySelectorAll(".crossing-desktop .is-current [data-ride]")];
				if (!tokens.length) found.push({ stage, missing: true });
				for (const fraction of [0.1, 0.35, 0.6, 0.9]) {
					for (const token of tokens) {
						const animation = token.getAnimations()[0];
						animation.pause();
						animation.currentTime = Number(token.dataset.delay) + 1500 * fraction;
					}
					await new Promise(requestAnimationFrame);
					for (const token of tokens) {
						const path = document.getElementById(token.dataset.ride);
						const [x, y] = getComputedStyle(token)
							.transform.match(/-?[\d.]+/g)
							.slice(4)
							.map(Number);
						let nearest = Number.POSITIVE_INFINITY;
						for (let d = 0; d <= path.getTotalLength(); d += 1) {
							const point = path.getPointAtLength(d);
							nearest = Math.min(nearest, Math.hypot(point.x - x, point.y - y));
						}
						if (nearest > 1.5) found.push({ stage, ride: token.dataset.ride, fraction, nearest });
					}
				}
				return found;
			}, stage)),
		);
		await page.screenshot({ path: `dist/ui-checks/homepage-token-${stage.toLowerCase()}.png` });
	}
	assert.deepEqual(failures, []);
	assert.equal(await page.locator('[data-ride*="auth"][data-ride*="billing"], .graph-message').count(), 0);
});
test("the stage note fits its reserved space through every moment and controls never shift", async () => {
	await page.clock.install();
	await openHomepage();
	await page.emulateMedia({ reducedMotion: "no-preference" });
	for (const width of [1440, 1024, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.getByRole("button", { name: "Baseline", exact: true }).click();
		await page.getByRole("button", { name: "Play", exact: true }).click();
		await page.locator(".hero-sequence").scrollIntoViewIfNeeded();
		let initial;
		for (const [stage, name] of stageNames.entries()) {
			await page.locator(`.sequence-controls button[aria-label="${name}"][aria-pressed="true"]`).waitFor();
			await page.clock.runFor(250);
			const layout = await page.locator(".hero-sequence").evaluate((root) => {
				const note = root.querySelector(".sequence-note").getBoundingClientRect();
				const fits = [...root.querySelector(".sequence-note").children].every(
					(child) => child.getBoundingClientRect().bottom <= note.bottom + 0.5,
				);
				return { fits, controls: root.querySelector(".sequence-controls").getBoundingClientRect().top - root.getBoundingClientRect().top };
			});
			assert.equal(layout.fits, true, `${width}px ${name}: explanation must fit its reserved space`);
			initial ??= layout.controls;
			assert.equal(layout.controls, initial, `${width}px ${name}: the note must not shift the controls`);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
			if (stage < stageNames.length - 1) await page.clock.runFor(stageDurations[stage] - 250 + 80);
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
	await row.getByText("1 for you", { exact: true }).waitFor();
	await row.getByText("1 to prepare", { exact: true }).waitFor();
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
	await page.getByRole("heading", { name: "People", exact: true }).waitFor();
	assert.equal(await namespaceNav().count(), 0);
	await page.screenshot({ path: "dist/ui-checks/namespace.png", fullPage: true });
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.reload();
	await page.getByRole("heading", { name: "Storage operations", exact: true }).waitFor();
	await page.getByRole("button", { name: "Fernloop", exact: true }).click();
	await page.getByRole("heading", { name: "Fernloop", exact: true, level: 1 }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "Settings", exact: true, level: 1 }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "Fernloop", exact: true, level: 1 }).waitFor();
});
test("empty namespaces inherit installation storage and creation dialogs keep focus contained", async () => {
	await page.goto(server.origin);
	await page.getByRole("button", { name: "Alex Morgan", exact: true }).click();
	await page.getByRole("heading", { name: "No repositories yet", exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "View storage setup", exact: true }).count(), 0);
	// Actions live in the page header; the empty state explains rather than repeating the button.
	assert.equal(await page.getByRole("button", { name: "New repository", exact: true }).count(), 1);
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
	await page.getByRole("heading", { name: "People", exact: true }).waitFor();
	await page.getByRole("heading", { name: "Teams", exact: true }).waitFor();
});
test("prefixed form fields align with ordinary inputs in creation dialogs", async () => {
	for (const width of [1440, 1024, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.goto(`${server.origin}/?namespace=fernloop`);
		await page.getByRole("button", { name: "New repository", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "New repository", exact: true });
		await dialog.getByLabel("Default branch").waitFor();
		await page.evaluate(() => document.fonts.ready);
		if (width >= 720) {
			const boxes = await dialog.evaluate((element) => {
				const prefixed = element.querySelector(".prefixed").getBoundingClientRect();
				const branch = element.querySelector('[name="branch"]').getBoundingClientRect();
				return { top: Math.abs(prefixed.top - branch.top), height: Math.abs(prefixed.height - branch.height) };
			});
			assert.ok(boxes.top < 1 && boxes.height < 1, `Form control alignment at ${width}: ${JSON.stringify(boxes)}`);
		}
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await page.screenshot({ path: `dist/ui-checks/aligned-form-${width}.png`, fullPage: true });
		await page.keyboard.press("Escape");
	}
});
test("a new repository opens on Changes with a way to start local work", async () => {
	await page.goto(`${server.origin}/?namespace=fernloop`);
	await page.getByRole("button", { name: "New repository", exact: true }).click();
	await page.getByLabel("Repository name", { exact: true }).fill("local-tools");
	await page.getByRole("button", { name: "Add repository", exact: true }).click();
	await page.getByRole("heading", { name: "local-tools", exact: true }).waitFor();
	await page.getByRole("heading", { name: "No changes yet", exact: true }).waitFor();
	await page.getByText("Nothing needs attention right now.", { exact: true }).waitFor();
	await page.locator(".changes-screen").getByText("Use Set up locally above to start.", { exact: false }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Set up locally", exact: true }).count(), 1);
	await page.getByRole("button", { name: "Set up locally", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Set up locally", exact: true });
	await dialog.getByRole("link", { name: "Local setup", exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/setup-new-repository.png", fullPage: true });
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
		["Local setup", "Sign out"],
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
	// Focus starts on the selected appearance; Tab reaches Local setup then Sign out, and the next Tab leaves and dismisses the menu.
	assert.equal(await menu.getByRole("radio", { name: "System", exact: true }).evaluate((e) => e === document.activeElement), true);
	await page.keyboard.press("Tab");
	assert.equal(await menu.getByRole("link", { name: "Local setup", exact: true }).evaluate((e) => e === document.activeElement), true);
	await page.keyboard.press("Tab");
	assert.equal(await menu.getByRole("link", { name: "Sign out", exact: true }).evaluate((e) => e === document.activeElement), true);
	await page.keyboard.press("Tab");
	assert.equal(await menu.count(), 0);
});
test("appearance matches the system by default, persists a choice and survives unavailable storage", async () => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
	assert.equal(await theme(), "dark");
	const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	const dark = await background();
	await page.emulateMedia({ colorScheme: "light" });
	await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
	assert.notEqual(await background(), dark);
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	const menu = page.getByRole("region", { name: "Your account", exact: true });
	await menu.getByRole("radio", { name: "Dark", exact: true }).check();
	assert.equal(await theme(), "dark");
	await page.reload();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	assert.equal(await theme(), "dark");
	await page.screenshot({ path: "dist/ui-checks/home-dark.png", fullPage: true });
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await menu.getByRole("radio", { name: "System", exact: true }).check();
	assert.equal(await theme(), "light");
	await page.addInitScript(() => {
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			get() {
				throw new Error("Storage unavailable");
			},
		});
	});
	await page.reload();
	await page.getByRole("heading", { name: "Your repositories", exact: true }).waitFor();
	assert.equal(await theme(), "light");
});
test("the public homepage stays on its light paper whatever the console appearance", async () => {
	await page.emulateMedia({ colorScheme: "dark" });
	await openHomepage();
	assert.equal(await page.locator(".landing").evaluate((e) => getComputedStyle(e).backgroundColor), "rgb(245, 245, 239)");
});
test("the lane map draws each live workspace from its baseline and highlights its row", async () => {
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	const map = page.locator(".lane-map");
	await map.getByText("2 live workspaces from main", { exact: false }).waitFor();
	assert.equal(await map.locator(".lane").count(), 2);
	await workspaceRow("Implement retry policy").hover();
	assert.equal(
		await map.getAttribute("data-focus"),
		(await page.request.get(`${server.origin}/api/namespaces/fernloop/repositories/payments`).then((r) => r.json())).workspaces.find(
			(w) => w.title === "Implement retry policy",
		).id,
	);
	await page.screenshot({ path: "dist/ui-checks/lane-map.png", fullPage: true });
	await page.emulateMedia({ colorScheme: "dark" });
	await page.screenshot({ path: "dist/ui-checks/lane-map-dark.png", fullPage: true });
	await map.locator(".lane").first().click();
	await page.locator(".lane-strip").waitFor();
});
test("home names each decision waiting across repositories and opens it", async () => {
	await page.goto(server.origin);
	const decision = page.locator(".decision-row").filter({ hasText: "Bounded retry policy" });
	await decision.getByText("Needs preparation", { exact: true }).waitFor();
	// The decision names its accountable owner, exact revision and blocker, and the viewer's own next action.
	await decision.getByText(/Owner: Alex Morgan \(you\)/).waitFor();
	await decision.getByText("Required tests evidence missing · 1 more blocker", { exact: true }).waitFor();
	assert.equal(await decision.locator(".decision-action").innerText(), "Prepare revision");
	assert.equal(await page.locator(".waiting").count(), 0);
	await decision.click();
	await page.getByRole("heading", { name: /Bounded retry policy/, level: 1 }).waitFor();
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
	// Personal namespaces have one owner: no People or Teams, just repositories and settings.
	await page.getByRole("heading", { name: "Repositories", exact: true }).waitFor();
	assert.equal(await page.getByRole("heading", { name: "Today", exact: true }).count(), 0);
	assert.equal(await page.getByRole("heading", { name: "People", exact: true }).count(), 0);
	assert.equal(await page.getByRole("heading", { name: "Teams", exact: true }).count(), 0);
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
	await page.getByRole("button", { name: "Set up locally", exact: true }).click();
	assert.equal(
		await page.getByRole("dialog", { name: "Set up locally" }).getByRole("button", { name: "Clone", exact: true }).isDisabled(),
		true,
	);
	await page.keyboard.press("Escape");
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
	await page.getByRole("button", { name: "1 change needs preparation", exact: true }).waitFor();
	await page.getByRole("button", { name: "1 path reported by more than one workspace", exact: true }).click();
	assert.ok(page.url().endsWith("#/workspaces"));
	await page.screenshot({ path: "dist/ui-checks/repository.png", fullPage: true });
	await page.goto(`${root()}#/overview`);
	await page.locator(".change-row").filter({ hasText: "Bounded retry policy" }).waitFor();
	await page.goto(page.url().replace(/#.*$/, "#deployments"));
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	assert.equal(await page.getByRole("heading", { name: "Deployments", exact: true }).count(), 0);
	await page.goto(`${server.origin}/?namespace=fernloop#settings`);
	await page.getByRole("heading", { name: "Storage operations", exact: true }).waitFor();
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
	await facts.getByText("Baseline", { exact: true }).waitFor();
	await facts.getByText(/is also changed in Inspect payment timeout/).waitFor();
	// The accountable person leads; the tool is provenance.
	await page.locator(".change-meta").getByText("Owner: Alex Morgan (you)", { exact: true }).waitFor();
	await page.locator(".change-meta").getByText("Started through Codex", { exact: true }).waitFor();
	await facts.getByText(/^Worktree attached through Codex · since/).waitFor();
	await page.getByText(/Attached to a worktree through Codex/).waitFor();
	const continuation = page.locator(".continuation");
	await continuation.getByText(/Only pushed commits travel/).waitFor();
	await continuation.getByText(/cruce resume --server .* --workspace /).waitFor();
	await continuation.getByText(/does not revoke the previous connection's Git access/).waitFor();
	const start = await facts.locator("dd").nth(2).textContent();
	await page.getByRole("button", { name: "Release checkout", exact: true }).click();
	await page
		.getByText("Not attached to a checkout. Its owner can continue it from another checkout or machine.", { exact: true })
		.waitFor();
	assert.equal(await page.getByRole("button", { name: "Release checkout", exact: true }).count(), 0);
	await page.locator(".change-header").getByText("Detached", { exact: true }).waitFor();
	await facts.getByText("No checkout attached", { exact: true }).waitFor();
	assert.equal(await facts.locator("dd").nth(2).textContent(), start);
});
test("workspaces behind canonical say so and show canonical changes without moving their baseline", async () => {
	await page.request.post(`${server.origin}/__fixture/upstream`);
	await openRepo();
	// The stale change and the workspace behind canonical are both reconciliation work, counted separately.
	await page.getByRole("button", { name: "1 change needs a Git update", exact: true }).waitFor();
	await page.getByRole("button", { name: "1 workspace needs a Git update", exact: true }).click();
	assert.equal(new URL(page.url()).searchParams.get("filter"), "reconcile");
	await page.getByRole("heading", { name: "Matching workspaces", exact: true }).waitFor();
	assert.equal(await page.locator(".workspace-row").count(), 1);
	const row = workspaceRow("Inspect payment timeout");
	await row.getByText("Behind canonical", { exact: true }).waitFor();
	await row.getByText(/^Canonical moved to \w{8} since this baseline · Update from canonical$/).waitFor();
	await row.click();
	const start = await page.locator(".facts dd").nth(2).textContent();
	await page
		.getByText(/Canonical moved to/)
		.first()
		.waitFor();
	await page.getByRole("button", { name: "See what changed on canonical", exact: true }).click();
	await page.getByText("also changed in this workspace", { exact: false }).waitFor();
	assert.equal(await page.locator(".facts dd").nth(2).textContent(), start);
	// Back restores the filtered list.
	await page.goBack();
	await page.getByRole("heading", { name: "Matching workspaces", exact: true }).waitFor();
});
test("a change on a stale base waits for its updated revision before review, and its owner can hand the update over", async () => {
	await page.request.post(`${server.origin}/__fixture/upstream`);
	await openChange();
	const checklist = page.locator(".checklist");
	await checklist.getByText(/Canonical has moved$/).waitFor();
	await checklist.getByText(/Approve the updated revision$/).waitFor();
	await checklist.getByText("Approval waits for the updated revision; this one can't be promoted.", { exact: true }).waitFor();
	// Approving or attesting a revision that can never land would be review spent twice; concerns stay open.
	assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Record checked tests pass", exact: true }).count(), 0);
	await page.getByRole("button", { name: "Raise concern", exact: true }).waitFor();
	const handoff = checklist.locator(".update-handoff");
	await handoff
		.getByText(/^Continue Cruce workspace "Implement retry policy" \(.+\): attach it with attach_workspace, merge canonical \w{40} into it/)
		.waitFor();
	await handoff.getByText(/^cruce resume --server .* --workspace /).waitFor();
	await page
		.locator(".review-panel")
		.getByText(/^Next: Merge canonical \w{8} with Git/)
		.waitFor();
	// The workspace page offers the same handoff once it is behind.
	await page.getByRole("button", { name: "Implement retry policy", exact: true }).click();
	await page.getByRole("heading", { name: "Implement retry policy", exact: true, level: 1 }).waitFor();
	await page
		.locator(".facts .update-handoff")
		.getByText(/^Continue Cruce workspace "Implement retry policy"/)
		.waitFor();
});
test("a reconciled change shows what changed since its last review, with canonical's files set aside", async () => {
	await page.request.post(`${server.origin}/__fixture/reconciled`);
	await openRepo();
	await page.locator(".change-row").filter({ hasText: "Bounded retry policy with jitter" }).click();
	await page.getByRole("heading", { name: /Bounded retry policy with jitter/, level: 1 }).waitFor();
	const compare = page.getByRole("navigation", { name: "Compare with" });
	assert.equal(await compare.getByRole("button", { name: "Since reviewed #1", exact: true }).getAttribute("aria-pressed"), "true");
	const files = page.getByRole("navigation", { name: "Changed files" });
	// The workspace's own edit since review is in front; canonical's file is grouped and closed.
	await files.getByRole("button", { name: /^src\/retry\.ts/ }).waitFor();
	await page.locator(".patch").getByText("+export const jitter = true;", { exact: true }).waitFor();
	const canonical = files.locator(".canonical-files");
	await canonical.getByText("1 file from canonical, already reviewed there", { exact: true }).waitFor();
	assert.equal(await canonical.getAttribute("open"), null);
	await canonical.locator("summary").click();
	await canonical.getByRole("button", { name: /^src\/timeout\.ts/ }).waitFor();
	// The full change against the current canonical base is one click away.
	await compare.getByRole("button", { name: "Full change", exact: true }).click();
	await files.getByRole("button", { name: /^src\/retry\.ts/ }).waitFor();
	assert.equal(await files.locator(".canonical-files").count(), 0);
	assert.equal(await files.getByRole("button", { name: /^src\/timeout\.ts/ }).count(), 0);
});
test("review is a checklist: confirm checks, approve the exact revision, then promote to main", async () => {
	await openChange();
	const promote = page.getByRole("button", { name: "Promote to main", exact: true });
	assert.equal(await promote.isDisabled(), true);
	await page.getByText("Finish the steps above to promote.", { exact: true }).waitFor();
	await page.locator(".patch").waitFor();
	await page.screenshot({ path: "dist/ui-checks/review.png", fullPage: true });
	await page.getByRole("button", { name: "Record checked tests pass", exact: true }).click();
	await page.locator(".checklist").getByText("Tests attested", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Approve", exact: true }).click();
	await page.locator(".change-header").getByText("Ready to promote", { exact: true }).waitFor();
	assert.equal(await promote.isEnabled(), true);
	await promote.click();
	await page.locator(".change-header").getByText("Promoted", { exact: true }).waitFor();
	await page.locator(".canonical-line").getByText(/main/).waitFor();
	await page.getByRole("button", { name: "1 workspace needs a Git update", exact: true }).waitFor();
	// The promotion names the work it left behind, without asking anyone to update it now.
	const behind = page.locator(".change-header .status-detail").filter({ hasText: "Now behind canonical" });
	await behind.getByText(/It needs an update from canonical before its review\.$/).waitFor();
	await behind.getByRole("button", { name: "Inspect payment timeout", exact: true }).click();
	await page.getByRole("heading", { name: "Inspect payment timeout", exact: true, level: 1 }).waitFor();
});
test("concerns and failures ask for a reason and block promotion until resolved", async () => {
	await openChange();
	await page.getByRole("button", { name: "Raise concern", exact: true }).click();
	await page.getByLabel("Raise concern note", { exact: true }).fill("Retry bound needs a jitter test");
	await page.locator(".note-action").getByRole("button", { name: "Raise concern", exact: true }).click();
	await page
		.locator(".review-blockers")
		.getByText(/1 unresolved concern/)
		.waitFor();
	await page.getByText("Retry bound needs a jitter test", { exact: false }).first().waitFor();
	await page.getByRole("button", { name: "Resolve concern", exact: true }).click();
	await page.getByLabel("Resolve concern note", { exact: true }).fill("Covered by the existing bound test");
	await page.locator(".note-action").getByRole("button", { name: "Resolve concern", exact: true }).click();
	await page.locator(".review-blockers").filter({ hasNotText: "unresolved concern" }).waitFor();
	await page.locator(".change-header").getByText("Needs preparation", { exact: true }).waitFor();
});
test("failed promotion preserves canonical source and reuses retry identity", async () => {
	await openChange();
	const before = await page.locator(".canonical-line").innerText();
	await page.getByRole("button", { name: "Record checked tests pass", exact: true }).click();
	await page.locator(".checklist").getByText("Tests attested", { exact: false }).waitFor();
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
test("explicit stored inspection and recovery remain usable when cached source is unavailable", async () => {
	await page.route("**/command", async (route) => {
		const { tool } = route.request().postDataJSON();
		if (["get_source", "get_history", "get_diff", "read_artifact"].includes(tool))
			return route.fulfill({ status: 404, json: { error: "Source cache unavailable; explicitly recover retained source" } });
		return route.continue();
	});
	await openChange();
	await page.getByRole("alert").filter({ hasText: "Source cache unavailable; explicitly recover retained source" }).waitFor();
	await page.getByText("Inspect stored diff", { exact: true }).click();
	await page.getByRole("button", { name: "Load stored diff", exact: true }).click();
	await page.locator(".patch").getByText("export const retries = 3;", { exact: false }).waitFor();
	await page.goto(`${root()}#/history/source`);
	await page.getByRole("button", { name: "Browse files", exact: true }).waitFor();
	await page.getByText("Inspect stored source", { exact: true }).click();
	await page.getByText(/Each request uses cloud storage and one namespace resource operation/).waitFor();
	await page.getByRole("button", { name: "List stored files", exact: true }).click();
	await page
		.getByRole("navigation", { name: "Stored repository files", exact: true })
		.getByRole("button", { name: "src/retry.ts", exact: true })
		.click();
	await page.locator("pre").getByText("export const retries = 3;", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Stored history", exact: true }).click();
	await page.getByText("First-parent history", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Recover source cache", exact: true }).click();
	await page.getByText(/Source recovered/).waitFor();
	await page.evaluate(() => {
		window.scrollTo(0, 0);
		document.activeElement?.blur();
	});
	await page.screenshot({ path: "dist/ui-checks/stored-source-recovery.png", fullPage: true });
	await page.goto(`${root()}#/history/test-report`);
	await page.getByText("Inspect stored evidence", { exact: true }).click();
	await page.getByRole("button", { name: "Load stored evidence", exact: true }).click();
	await page.locator("pre").getByText("Reported tests: 12 passed", { exact: false }).waitFor();
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
		data.readiness[proposal.id].checks.evidence.find((check) => check.kind === "tests").verificationIds = ["linked-check"];
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
	await page.getByRole("button", { name: "New team", exact: true }).click();
	await page.getByLabel("Team name").fill("Platform");
	await page.getByRole("checkbox", { name: "Alex Morgan" }).check();
	await page.getByRole("button", { name: "Create team", exact: true }).click();
	await page.locator("summary").filter({ hasText: "Platform" }).waitFor();
	assert.equal(await page.locator(".inline-panel").count(), 0);
	await page.locator("summary").filter({ hasText: "Platform" }).click();
	assert.equal(await page.locator("details.team-row").getByLabel("Team name").inputValue(), "Platform");
	await page.getByRole("button", { name: "Invite", exact: true }).click();
	await page.getByLabel("Email", { exact: true }).fill("alex@example.com");
	await page.getByRole("button", { name: "Create invitation link" }).click();
	// The link stays beside the form after the namespace refreshes.
	await page.getByRole("status").filter({ hasText: "/invite/fernloop" }).waitFor();
	await page.waitForTimeout(200);
	await page.getByRole("status").filter({ hasText: "/invite/fernloop" }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/namespace-people.png", fullPage: true });
});
test("namespace settings inherit installation storage and set storage operation policy", async () => {
	await page.goto(`${server.origin}/?namespace=fernloop#/settings`);
	await page.getByRole("heading", { name: "Git storage", exact: true }).waitFor();
	await page.getByText("Managed by this Cruce installation.", { exact: false }).waitFor();
	assert.equal(await page.getByRole("progressbar").count(), 0);
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
test("repository clone uses normal Git", async () => {
	await openRepo();
	await page.getByRole("button", { name: "Set up locally", exact: true }).click();
	await page
		.getByRole("dialog", { name: "Set up locally" })
		.getByText(/git clone https?:/)
		.waitFor();
	await page.keyboard.press("Escape");
});
test("deleting a workspace withdraws its change, deletes its fork and moves it to earlier work", async () => {
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	await workspaceRow("Implement retry policy").click();
	await page.getByRole("button", { name: "Delete workspace…", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Delete Implement retry policy" });
	const text = await dialog.innerText();
	assert.match(text, /Ends the workspace and releases its checkout on fixture/);
	assert.match(text, /Withdraws its open change/);
	assert.match(text, /Deletes its cloud fork\. This uses one namespace operation/);
	assert.match(text, /Published revisions and history stay in History under Earlier work/);
	await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();
	await page.waitForFunction(() => location.hash === "#/workspaces");
	await workspaceRow("Inspect payment timeout").waitFor();
	assert.equal(await workspaceRow("Implement retry policy").count(), 0);
	await page.getByRole("button", { name: "History", exact: true }).click();
	const earlier = page.getByRole("region", { name: "Earlier work", exact: true });
	await earlier.getByRole("button", { name: "Show earlier work", exact: true }).click();
	await earlier.getByRole("button", { name: /Implement retry policy/ }).waitFor();
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
	assert.equal(await page.locator(".detached-workspaces").evaluate((e) => e.open), false);
	await page.locator(".detached-workspaces summary").click();
	await workspaceRow("Paused elsewhere").getByText("Detached", { exact: true }).waitFor();
	await page.locator(".workspace-row").getByText("Not reporting", { exact: true }).waitFor();
	assert.equal(await page.locator(".workspace-row").count(), 3);
	await page.getByRole("button", { name: "Set up locally", exact: true }).click();
	assert.equal(
		await page.getByRole("dialog", { name: "Set up locally" }).getByRole("button", { name: "Clone", exact: true }).isDisabled(),
		true,
	);
	await page.keyboard.press("Escape");
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
	await page.locator(".repo-row").getByText("1 to prepare", { exact: true }).waitFor();
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
		["namespace-settings", `${server.origin}/?namespace=fernloop#/settings`, "Storage operations"],
		["account", `${server.origin}/?page=account`, "Your repositories"],
		["setup", `${server.origin}/?page=setup`, "Local setup"],
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
	await page.getByText("A human repository maintainer attests evidence, approves and promotes.", { exact: true }).waitFor();
});

test("published work with no change says so, groups shared scaffold paths once and offers one-click proposals", async () => {
	const proposed = [];
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		const original = data.workspaces[0];
		const names = ["ProductController", "WarehouseController", "StockLevelController", "SupplierController", "PurchaseOrderController"];
		const revision = (i) => `${i}`.repeat(40);
		data.workspaces = names.map((title, i) => ({
			...original,
			id: `scaffold-${i}`,
			title,
			startedAt: i,
			publishedRevision: revision(i + 1),
		}));
		data.proposals = [];
		data.artifacts = names.map((title, i) => ({
			id: `artifact-${i}`,
			workspaceId: `scaffold-${i}`,
			revision: revision(i + 1),
			kind: "source",
			title,
			at: i,
			actor: original.createdBy,
		}));
		data.overlaps = [".gitignore", "pom.xml", "src/main/java/InventoryApplication.java"].map((surface) => ({
			id: `file:${surface}`,
			kind: "file",
			surface,
			workspaces: names.map((_, i) => `scaffold-${i}`),
			evidence: "reported",
			observedAt: 1,
		}));
		data.reconciliation = {
			...data.reconciliation,
			workspaces: names.map((_, i) => ({
				workspaceId: `scaffold-${i}`,
				revision: revision(i + 1),
				basis: "published",
				canonicalRevision: data.sourceHead,
				relation: "ahead",
				report: { state: "fresh" },
				incorporationCounts: { present: 0, missing: 0, unknown: 0 },
				incorporationTruncated: false,
				incorporation: [],
			})),
			proposals: [],
		};
		data.attention = { ...data.attention, items: [], ancestryUnavailable: 0 };
		await route.fulfill({ json: data });
	});
	await page.route("**/command", (route) => {
		const body = route.request().postDataJSON();
		if (body.tool !== "create_proposal") return route.continue();
		proposed.push(body.artifactId);
		return route.fulfill({ json: { id: body.artifactId } });
	});
	await openRepo();
	await page.getByRole("button", { name: "5 workspaces published, not proposed" }).waitFor();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	const brief = page.locator(".workspace-brief");
	await brief.waitFor();
	assert.match(await brief.innerText(), /5 published revisions have no change yet/);
	assert.match(await brief.innerText(), /3 paths are reported by all 5 workspaces/);
	assert.equal(await page.locator(".workspace-row .overlap-note").first().innerText(), "3 reported paths shared with 4 other workspaces");
	assert.equal(await page.locator(".workspace-row").getByText("Not proposed", { exact: true }).count(), 5);
	await page.screenshot({ path: "dist/ui-checks/published-not-proposed.png", fullPage: true });
	await page.getByRole("button", { name: "Propose all 5 for review" }).click();
	await page.waitForFunction(() => !document.querySelector(".workspace-brief button:disabled"));
	assert.equal(proposed.length, 5);
});

test("promoted work rejoins main on the lane map and only promoted work does", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		const original = data.workspaces[0];
		const names = ["ProductController", "WarehouseController", "StockLevelController", "SupplierController", "PurchaseOrderController"];
		const revision = (i) => `${i}`.repeat(40);
		data.workspaces = names.map((title, i) => ({
			...original,
			id: `scaffold-${i}`,
			title,
			startedAt: i,
			publishedRevision: revision(i + 1),
		}));
		data.artifacts = names.map((title, i) => ({
			id: `artifact-${i}`,
			workspaceId: `scaffold-${i}`,
			revision: revision(i + 1),
			kind: "source",
			title,
			at: i,
			actor: original.createdBy,
		}));
		const proposal = (i, state) => ({
			id: `change-${i}`,
			number: i + 1,
			workspaceId: `scaffold-${i}`,
			artifactId: `artifact-${i}`,
			base: data.sourceHead,
			revision: revision(i + 1),
			title: names[i],
			state,
			reviews: [],
			at: i,
		});
		data.proposals = [proposal(0, "promoted"), proposal(1, "promoted"), proposal(2, "open")];
		data.promotions = [0, 1].map((i) => ({
			id: `promotion-${i}`,
			proposalId: `change-${i}`,
			state: "complete",
			from: i ? revision(1) : data.sourceHead,
			to: revision(i + 1),
			at: i + 1,
		}));
		data.overlaps = [];
		data.reconciliation = { ...data.reconciliation, workspaces: [], proposals: [] };
		data.attention = { ...data.attention, items: [], ancestryUnavailable: 0 };
		await route.fulfill({ json: data });
	});
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	const map = page.locator(".lane-map");
	await map.locator(".lane").first().waitFor();
	assert.equal(await map.locator(".lane-return").count(), 2);
	assert.equal(await map.locator(".lane-return-spark").count(), 2);
	// Let the return draw in and a spark start along it, then freeze the frame.
	await page.waitForTimeout(2600);
	await map.getByRole("button", { name: "Pause motion", exact: true }).click();
	await page.screenshot({ path: "dist/ui-checks/lane-map-merged.png", fullPage: true });
});

test("work already in main folds into one pill on the main line and unfolds on request", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		const original = data.workspaces[0];
		const names = ["ProductController", "WarehouseController", "StockLevelController", "SupplierController", "PurchaseOrderController"];
		const revision = (i) => `${i}`.repeat(40);
		data.workspaces = names.map((title, i) => ({
			...original,
			id: `scaffold-${i}`,
			title,
			startedAt: i,
			publishedRevision: revision(i + 1),
			headRevision: i === 2 ? "9".repeat(40) : revision(i + 1),
		}));
		data.artifacts = names.map((title, i) => ({
			id: `artifact-${i}`,
			workspaceId: `scaffold-${i}`,
			revision: revision(i + 1),
			kind: "source",
			title,
			at: i,
			actor: original.createdBy,
		}));
		const proposal = (i, state) => ({
			id: `change-${i}`,
			number: i + 1,
			workspaceId: `scaffold-${i}`,
			artifactId: `artifact-${i}`,
			base: data.sourceHead,
			revision: revision(i + 1),
			title: names[i],
			state,
			reviews: [],
			at: i,
		});
		data.proposals = [proposal(0, "promoted"), proposal(2, "promoted"), proposal(3, "open")];
		data.promotions = [0, 2].map((i) => ({
			id: `promotion-${i}`,
			proposalId: `change-${i}`,
			state: "complete",
			from: data.sourceHead,
			to: revision(i + 1),
			at: i + 1,
		}));
		data.overlaps = [];
		const relation = ["current", "behind", "current", "ahead", "ahead"];
		data.reconciliation = {
			...data.reconciliation,
			workspaces: names.map((_, i) => ({
				workspaceId: `scaffold-${i}`,
				revision: revision(i + 1),
				basis: "published",
				canonicalRevision: data.sourceHead,
				relation: relation[i],
				report: { state: "fresh" },
				incorporationCounts: { present: 0, missing: 0, unknown: 0 },
				incorporationTruncated: false,
				incorporation: [],
			})),
			proposals: [],
		};
		data.attention = { ...data.attention, items: [], ancestryUnavailable: 0 };
		await route.fulfill({ json: data });
	});
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	const map = page.locator(".lane-map");
	await map.locator(".lane").first().waitFor();
	assert.equal(await map.locator(".lane").count(), 3);
	assert.equal(await map.locator(".lane-fold").count(), 1);
	assert.match(
		await map.locator(".lane-map figcaption, figcaption").innerText(),
		/Already in main, folded into the main line: ProductController, WarehouseController \(some arrived through another workspace's promotion\)/,
	);
	assert.equal(await page.locator(".settled-workspaces .workspace-row").count(), 2);
	assert.equal(await page.locator(".settled-workspaces").evaluate((e) => e.open), false);
	await page.locator(".settled-workspaces summary").click();
	await page.locator(".settled-workspaces").getByText("Already in canonical", { exact: true }).first().waitFor();
	await map.getByRole("button", { name: "Show 2 already in main", exact: true }).click();
	assert.equal(await map.locator(".lane").count(), 5);
	assert.equal(await map.locator(".lane-fold").count(), 0);
	assert.equal(await map.locator(".lane-return").count(), 2);
	await map.getByRole("button", { name: "Fold 2 already in main", exact: true }).click();
	assert.equal(await map.locator(".lane").count(), 3);
});

test("deleting a workspace stops at unpublished fork commits and shows them", async () => {
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	await page.getByRole("button", { name: /^Inspect payment timeout/ }).click();
	await page.getByRole("button", { name: "Delete workspace…", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Delete Inspect payment timeout" });
	assert.match(await dialog.innerText(), /never published stop the fork deletion/);
	await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();
	await dialog.getByRole("alert").getByText("Unretained fork refs; publish their commits before cleanup").waitFor();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	const blockers = page.getByRole("region", { name: "Retention blockers" });
	await blockers.waitFor();
	assert.match(await blockers.innerText(), /refs\/heads\/unpublished/);
	assert.match(await blockers.innerText(), /not published/);
	// The workspace ended, so retrying only needs the fork deletion.
	await page.getByRole("button", { name: "Delete workspace…", exact: true }).click();
	assert.doesNotMatch(await page.getByRole("dialog").innerText(), /Ends the workspace/);
	await page.screenshot({ path: "dist/ui-checks/retention-blockers.png", fullPage: true });
});

test("History can inspect retained activity through a read-only page", async () => {
	await openRepo();
	await page.getByRole("button", { name: "History", exact: true }).click();
	await page.getByText("Retained activity", { exact: true }).click();
	await page.getByRole("button", { name: "Browse retained activity", exact: true }).click();
	await page.getByText("End of retained activity.", { exact: true }).waitFor();
});

test("History pages finished work and archived records still open by deep link", async () => {
	await openRepo();
	await page.getByRole("button", { name: "History", exact: true }).click();
	const earlier = page.getByRole("region", { name: "Earlier work", exact: true });
	await earlier.getByRole("button", { name: "Show earlier work", exact: true }).click();
	await earlier.getByRole("button", { name: /Spike: idempotency keys/ }).click();
	await page.getByRole("heading", { name: "Spike: idempotency keys", level: 1 }).waitFor();
	assert.equal(new URL(page.url()).hash, "#/history/archived-spike");
	await page.getByText("Idempotency key spike · published revision", { exact: false }).waitFor();
	// A retired workspace link resolves to the same read-only record, and an unknown one says so.
	await page.goto(`${server.origin}/?namespace=fernloop&repository=payments#/workspaces/archived-spike`);
	await page.getByRole("heading", { name: "Spike: idempotency keys", level: 1 }).waitFor();
	await page.goto(`${server.origin}/?namespace=fernloop&repository=payments#/history/missing-record`);
	await page.getByText("That record is unavailable.", { exact: true }).waitFor();
});

test("reconciliation exposes published ancestry, all proposal blockers and degraded observation without granting authority", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		data.reconciliation.observation = {
			...data.reconciliation.observation,
			enabled: true,
			state: "degraded",
			reason: "Observation checks are overdue",
		};
		data.workspaces[0].lastReportAt = data.asOf - 90000;
		data.reconciliation.workspaces[0].report = { state: "stale", reportedAt: data.asOf - 90000, ageMs: 90000 };
		await route.fulfill({ json: data });
	});
	await openRepo();
	await page.getByRole("button", { name: "Observation degraded", exact: true }).click();
	const panel = page.getByRole("region", { name: "Reconciliation", exact: true });
	await panel.getByText(/Observation checks are overdue/).waitFor();
	await panel.getByText(/Stale report/).waitFor();
	await panel.getByText(/Human approval required for this revision/).waitFor();
	await panel.getByRole("button", { name: /Inspect reconciliation for Implement retry policy/ }).click();
	await page.locator(".change-header").getByRole("heading", { name: "Implement retry policy", exact: true }).waitFor();
	await page.goBack();
	await panel.waitFor();
	await page.screenshot({ path: "dist/ui-checks/reconciliation.png", fullPage: true });
});

test("observation opt-in discloses recurring cost and is absent for read-only viewers", async () => {
	await openRepo();
	await repoNav().getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByText(/Estimated idle checks:/).waitFor();
	await page.getByRole("button", { name: "Enable observation", exact: true }).waitFor();
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		data.permissions = { write: false, maintain: false, human: true, approve: false };
		await route.fulfill({ json: data });
	});
	await page.reload();
	await page.getByText(/Estimated idle checks:/).waitFor();
	assert.equal(await page.getByRole("button", { name: "Enable observation", exact: true }).count(), 0);
});
test("Home separates decisions you can make from work waiting on others and says when a list is capped", async () => {
	await page.request.post(`${server.origin}/__fixture/scenario`, { data: { name: "team" } });
	await page.goto(server.origin);
	const needs = page.getByRole("region", { name: "Needs you", exact: true });
	await needs.locator(".decision-row").first().waitFor();
	// Maya's reported tests are a maintainer decision for Alex; Alex's own change needs his preparation.
	assert.equal(await needs.locator(".decision-row").count(), 3);
	const reported = needs.locator(".decision-row").filter({ hasText: "Session renewal 1" });
	await reported.getByText(/Owner: Maya Reyes/).waitFor();
	await reported.getByText("Tests reported passing; human attestation required · 1 more blocker", { exact: true }).waitFor();
	assert.equal(await reported.locator(".decision-action").innerText(), "Attest evidence");
	// Maya's missing evidence is hers to prepare: visible, but waiting on the owner, and capped with a total.
	const waiting = page.locator("details.waiting");
	await waiting.locator("summary").getByText("Waiting on others · 8", { exact: true }).click();
	assert.equal(await waiting.locator(".decision-row").count(), 5);
	await waiting.locator(".decision-row").first().getByText("Waiting on the owner", { exact: true }).waitFor();
	await waiting.getByText("Showing 5 of 8 in payment-service.", { exact: false }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/home-team.png", fullPage: true });
	await waiting.getByRole("button", { name: "Open the full list", exact: true }).click();
	await page.getByRole("heading", { name: "Needs preparation", exact: true }).waitFor();
	assert.equal(await page.locator(".change-row").filter({ hasText: "Session renewal" }).count(), 10);
	// The Needs you filter lives in the URL and Back restores the full list.
	await page.getByRole("button", { name: "Needs you", exact: true }).click();
	assert.equal(new URL(page.url()).searchParams.get("filter"), "mine");
	await page.getByText("Showing 3 of 11 open changes.", { exact: true }).waitFor();
	assert.equal(await page.locator(".change-row").count(), 3);
	await page.reload();
	await page.getByText("Showing 3 of 11 open changes.", { exact: true }).waitFor();
	await page.goBack();
	await page.getByRole("button", { name: "All open", exact: true, pressed: true }).waitFor();
	assert.equal(await page.locator(".change-row").count(), 11);
});
test("another owner's change leads with its owner and connection, and evidence wording follows its trust", async () => {
	await page.request.post(`${server.origin}/__fixture/scenario`, { data: { name: "team" } });
	await page.goto(`${root()}&filter=review#/changes`);
	await page.getByRole("heading", { name: "Needs human review", exact: true }).waitFor();
	assert.equal(await page.getByRole("heading", { name: "Needs preparation", exact: true }).count(), 0);
	await page.locator(".change-row").filter({ hasText: "Session renewal 1" }).click();
	const meta = page.locator(".change-meta");
	await meta.getByText("Owner: Maya Reyes", { exact: true }).waitFor();
	await meta.getByText(/published through Codex, Maya Reyes's connection/).waitFor();
	await page.getByText("Next: Inspect the reported evidence and attest what you checked", { exact: true }).waitFor();
	await page.locator(".checklist").getByText("Tests reported passing; human attestation required", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Attest tests pass", exact: true }).click();
	await page.locator(".checklist").getByText("Tests attested", { exact: false }).waitFor();
	await page.getByText(`Next: Approve`, { exact: false }).waitFor();
});
test("workspaces filter by owner and Mine, lanes name owners, and only the owner is offered continuation", async () => {
	await page.request.post(`${server.origin}/__fixture/scenario`, { data: { name: "team" } });
	await page.goto(`${root()}#/workspaces`);
	await page.locator(".lane-map").getByText("Owner: Alex Morgan (you)", { exact: false }).first().waitFor();
	await page.locator(".owner-filter select").selectOption({ label: "Maya Reyes" });
	assert.equal(new URL(page.url()).searchParams.get("filter"), "owner:maya");
	await page.getByRole("heading", { name: "Matching workspaces", exact: true }).waitFor();
	assert.equal(await page.locator(".workspace-row").count(), 10);
	await page.getByRole("button", { name: "Mine", exact: true }).click();
	assert.equal(await page.locator(".workspace-row").count(), 2);
	await page.goBack();
	assert.equal(await page.locator(".workspace-row").count(), 10);
	const maya = workspaceRow("Session renewal 1");
	await maya.getByText("Owner: Maya Reyes", { exact: true }).waitFor();
	await maya.getByText("Worktree attached through Codex", { exact: true }).waitFor();
	await maya.click();
	await page
		.locator(".continuation")
		.getByText(/Only Maya Reyes can attach this workspace/)
		.waitFor();
	assert.equal(await page.getByRole("button", { name: "Release checkout", exact: true }).count(), 0);
	assert.equal(await page.locator(".continuation .copy-command").count(), 0);
});
test("History connects each promotion to its approver, promoter, workspace owner and evidence", async () => {
	await openChange();
	await page.getByRole("button", { name: "Record checked tests pass", exact: true }).click();
	await page.locator(".checklist").getByText("Tests attested", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Approve", exact: true }).click();
	await page.getByRole("button", { name: "Promote to main", exact: true }).click();
	await page.locator(".change-header").getByText("Promoted", { exact: true }).waitFor();
	await repoNav()
		.getByRole("button", { name: /^History/ })
		.click();
	const entry = page.locator(".canonical-timeline li").filter({ hasText: "Bounded retry policy #1" });
	await entry.getByText(/promoted by Alex Morgan/).waitFor();
	const facts = entry.locator(".promotion-facts");
	await facts
		.getByText(/^Approved by Alex Morgan · from Implement retry policy, owner Alex Morgan \(you\) · moved from \w{8} · tests attested$/)
		.waitFor();
});
test("unknown ancestry is reported as missing knowledge, never as nothing waiting", async () => {
	await page.route("**/api/namespaces/fernloop", async (route) => {
		const data = await (await route.fetch()).json();
		for (const summary of data.repositorySummaries) summary.attention.ancestryUnavailable = 2;
		await route.fulfill({ json: data });
	});
	await page.goto(server.origin);
	await page
		.locator(".heads-row")
		.getByText(/^Ancestry unavailable for 2 workspaces/)
		.waitFor();
});

test("tool consent allows every repository by default and can narrow to chosen ones", async () => {
	await page.goto(`${server.origin}/__fixture/consent`);
	const connect = page.getByRole("button", { name: "Connect", exact: true });
	assert.equal(await page.getByRole("radio", { name: /All repositories you can access/ }).isChecked(), true);
	assert.equal(await page.locator("#chooser").isVisible(), false);
	assert.equal(await connect.isEnabled(), true);
	await page.getByRole("radio", { name: /Choose repositories/ }).check();
	assert.equal(await connect.isDisabled(), true);
	await page.getByRole("checkbox", { name: "maya hello-world" }).check();
	assert.equal(await connect.isEnabled(), true);
	await page.getByRole("searchbox", { name: "Find a repository" }).fill("fernloop");
	assert.equal(await page.locator(".repository:visible").count(), 1);
	await page.getByRole("checkbox", { name: "fernloop payment-service" }).check();
	assert.equal(await page.getByRole("status").textContent(), "2 repositories selected");
	await page.getByRole("searchbox").fill("no-match");
	await page.getByText("No repositories match your search.").waitFor();
	assert.equal(await connect.isEnabled(), true);
	await page.getByRole("searchbox").fill("");
	await page.getByText("Review permissions", { exact: false }).click();
	await page.getByRole("checkbox", { name: "Publish Git revisions" }).uncheck();
	assert.equal(await page.getByRole("checkbox", { name: "Read repositories and work history" }).isDisabled(), true);
	assert.equal(await page.locator("#permission-count").textContent(), "5 enabled");
	const submissions = [];
	await page.route("**/__fixture/consent", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		submissions.push(new URLSearchParams(route.request().postData()));
		await route.fulfill({ body: "Consent submitted" });
	});
	await connect.click();
	await page.getByText("Consent submitted").waitFor();
	await page.goto(`${server.origin}/__fixture/consent`);
	await connect.click();
	await page.getByText("Consent submitted").waitFor();
	const [chosen, all] = submissions;
	assert.equal(chosen.get("access"), "choose");
	assert.deepEqual(chosen.getAll("repository"), ["hello", "payments"]);
	assert.equal(chosen.get("handle"), "fixture-consent");
	assert.equal(chosen.getAll("scope").includes("revision:publish"), false);
	// The default follows current access, so it submits no repository list.
	assert.equal(all.get("access"), "all");
	assert.deepEqual(all.getAll("repository"), []);
});

test("tool consent stays legible on desktop and mobile and provides empty and expired recovery", async () => {
	await page.goto(`${server.origin}/__fixture/consent`);
	await page.screenshot({ path: "dist/ui-checks/consent-desktop.png", fullPage: true });
	await page.getByRole("radio", { name: /Choose repositories/ }).focus();
	await page.keyboard.press("Space");
	await page.getByRole("checkbox", { name: "maya hello-world" }).focus();
	await page.keyboard.press("Space");
	assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).isEnabled(), true);
	await page.screenshot({ path: "dist/ui-checks/consent-choose.png", fullPage: true });
	await page.setViewportSize({ width: 375, height: 812 });
	await page.getByText("Review permissions", { exact: false }).click();
	await page.screenshot({ path: "dist/ui-checks/consent-mobile.png", fullPage: true });
	await page.setViewportSize({ width: 320, height: 812 });
	await page.getByText("Connection details", { exact: true }).click();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.goto(`${server.origin}/__fixture/consent?empty`);
	// With nothing to choose yet, every repository the person can access later is still a valid approval.
	assert.equal(await page.getByRole("radio", { name: /Choose repositories/ }).isDisabled(), true);
	assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).isEnabled(), true);
	await page.goto(`${server.origin}/__fixture/consent?error`);
	await page.getByRole("link", { name: "Start again" }).click();
	await page.getByRole("heading", { name: "Connect to Cruce" }).waitFor();
});

test("lane motion follows reported revisions, pauses, and honors reduced motion", async () => {
	await page.clock.install();
	let changed = false;
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		const w = data.workspaces.find((workspace) => workspace.execution);
		w.state = "active";
		if (changed) w.headRevision = "f".repeat(40);
		await route.fulfill({ json: data });
	});
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	const map = page.locator(".lane-map");
	await map.locator('.lane[data-presence="connected"]').first().waitFor();
	await page.waitForFunction(() => document.querySelector(".lane-map")?.dataset.motion === "playing");
	assert.equal(await map.locator(".lane-revision-arrival").count(), 0);
	assert.equal(
		await map
			.locator(".lane-presence-pulse")
			.first()
			.evaluate((e) => getComputedStyle(e).animationPlayState),
		"running",
	);
	await map.getByRole("button", { name: "Pause motion", exact: true }).click();
	assert.equal(
		await map
			.locator(".lane-presence-pulse")
			.first()
			.evaluate((e) => getComputedStyle(e).animationPlayState),
		"paused",
	);
	changed = true;
	await page.clock.fastForward(15000);
	await map.locator(".lane-revision-arrival").waitFor();
	await page.screenshot({ path: "dist/ui-checks/lane-map-activity.png", fullPage: true });
	await map.getByRole("button", { name: "Resume motion", exact: true }).click();
	await page.emulateMedia({ reducedMotion: "reduce" });
	assert.equal(
		await map
			.locator(".lane-presence-pulse")
			.first()
			.evaluate((e) => getComputedStyle(e).display),
		"none",
	);
	assert.equal(
		await map
			.locator(".lane-revision-arrival")
			.first()
			.evaluate((e) => getComputedStyle(e).display),
		"none",
	);
});

test("lane maps bound parallel work, fold detached work, and keep every lane reachable", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const data = await (await route.fetch()).json();
		const template = data.workspaces.find((w) => w.execution);
		data.workspaces = Array.from({ length: 17 }, (_, i) => ({
			...template,
			id: `parallel-${i}`,
			title: `Parallel workspace ${i + 1}`,
			startedAt: template.startedAt + i,
			state: i < 10 ? "active" : i < 12 ? "disconnected" : "detached",
			execution: i < 12 ? { ...template.execution, id: `execution-${i}` } : undefined,
		}));
		await route.fulfill({ json: data });
	});
	await openRepo();
	await repoNav()
		.getByRole("button", { name: /^Workspaces/ })
		.click();
	const map = page.locator(".lane-map");
	await map.getByText("10 connected", { exact: false }).waitFor();
	assert.equal(await map.locator(".lane").count(), 12);
	assert.equal(await map.locator(".lane-presence-pulse").count(), 10);
	assert.equal(await page.locator(".detached-workspaces").evaluate((e) => e.open), false);
	assert.equal(await map.locator(".lane-canvas").evaluate((e) => e.clientHeight <= 560 && e.scrollHeight > e.clientHeight), true);
	await map.getByRole("button", { name: "Pause motion", exact: true }).click();
	await page.screenshot({ path: "dist/ui-checks/lane-map-parallel.png", fullPage: true });
	await page.emulateMedia({ colorScheme: "dark" });
	await page.screenshot({ path: "dist/ui-checks/lane-map-parallel-dark.png", fullPage: true });
	await map.getByRole("button", { name: "Show 5 detached", exact: true }).click();
	await map.getByRole("button", { name: "Next lanes", exact: true }).click();
	assert.equal(await map.locator('.lane[data-presence="detached"]').count(), 5);
	assert.equal(await map.locator(".lane-presence-pulse").count(), 0);
	await page.locator(".detached-workspaces summary").click();
	assert.equal(await page.locator(".detached-workspaces .workspace-row").count(), 5);
	await map.getByRole("button", { name: "Hide 5 detached", exact: true }).click();
	assert.equal(await map.locator(".lane").count(), 12);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "dist/ui-checks/lane-map-parallel-mobile.png", fullPage: true });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await map.locator(".lane-canvas").focus();
	assert.equal(await map.locator(".lane-canvas").evaluate((e) => document.activeElement === e), true);
});

test("repository retirement shows blockers and requires exact confirmation after reversible archive", async () => {
	await openRepo();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	assert.equal(await page.getByRole("button", { name: "Archive repository", exact: true }).isDisabled(), true);
	await page.getByText("End all workspaces, including disconnected work.", { exact: true }).waitFor();
	// Deletion ends unfinished work with the repository, and its confirmation says so.
	await page.getByRole("button", { name: "Delete repository…", exact: true }).click();
	const live = page.getByRole("dialog", { name: "Delete repository permanently", exact: true });
	assert.match(await live.getByRole("alert").innerText(), /This also ends \d+ unfinished workspaces?.*attached/);
	await page.screenshot({ path: "dist/ui-checks/delete-repository-live-work.png", fullPage: true });
	await live.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.goto(`${server.origin}/?namespace=fernloop`);
	await page.getByRole("button", { name: "New repository", exact: true }).click();
	await page.getByLabel("Repository name", { exact: true }).fill("retirement-test");
	await page.getByRole("button", { name: "Add repository", exact: true }).click();
	await page.getByRole("heading", { name: "retirement-test", exact: true }).waitFor();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: "Archive repository", exact: true }).click();
	await page.getByRole("button", { name: "Restore repository", exact: true }).waitFor();
	await page.getByText("Archived · Read-only. Restore this repository in Settings.", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Restore repository", exact: true }).click();
	await page.getByRole("button", { name: "Archive repository", exact: true }).waitFor();
	await page.getByRole("button", { name: "Delete repository…", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Delete repository permanently", exact: true });
	const confirm = dialog.getByRole("button", { name: "Delete repository permanently", exact: true });
	assert.equal(await confirm.isDisabled(), true);
	await dialog.getByLabel("Type retirement-test to confirm", { exact: true }).fill("wrong-name");
	assert.equal(await confirm.isDisabled(), true);
	await dialog.getByLabel("Type retirement-test to confirm", { exact: true }).fill("retirement-test");
	await page.screenshot({ path: "dist/ui-checks/delete-repository.png", fullPage: true });
	await confirm.click();
	await page.getByRole("heading", { name: "Fernloop", exact: true }).waitFor();
	assert.equal(await page.getByRole("heading", { name: "retirement-test", exact: true }).count(), 0);
	await page.getByRole("button").filter({ hasText: "retirement-test" }).waitFor({ state: "detached" });
});

test("an unfinished cloud operation blocks deletion until the owner releases it", async () => {
	await page.request.post(`${server.origin}/api/namespaces/fernloop/repositories`, {
		data: { name: "stuck-operation", defaultBranch: "main", idempotencyKey: "stuck-operation" },
	});
	let stuck = true;
	const released = [];
	await page.route("**/api/namespaces/fernloop/repositories/stuck-operation", async (route) => {
		const response = await route.fetch();
		const snapshot = await response.json();
		if (stuck) {
			snapshot.lifecycle.blockers = ["Recover unfinished resource operations."];
			snapshot.lifecycle.deletionBlockers = ["Recover unfinished resource operations."];
			snapshot.lifecycle.operations = [
				{ id: "agent:publish-1", action: "revision.publish", state: "uncertain", at: Date.UTC(2026, 9, 8, 9, 52) },
			];
		}
		await route.fulfill({ response, json: snapshot });
	});
	await page.route("**/api/namespaces/fernloop/repositories/stuck-operation/command", async (route) => {
		const command = route.request().postDataJSON();
		if (command.tool !== "release_resource_operation") return route.continue();
		released.push(command.reservationId);
		stuck = false;
		return route.fulfill({ json: {} });
	});
	await page.goto(`${server.origin}/?namespace=fernloop&repository=stuck-operation#/settings`);
	const operations = page.getByRole("region", { name: "Unfinished cloud operations" });
	await operations.getByText("Publish revision", { exact: false }).waitFor();
	assert.match(await operations.innerText(), /outcome unknown/);
	assert.equal(await page.getByRole("button", { name: "Delete repository…", exact: true }).isDisabled(), true);
	await page.screenshot({ path: "dist/ui-checks/unfinished-operation.png", fullPage: true });
	await operations.getByRole("button", { name: "Release", exact: true }).click();
	await page.getByRole("button", { name: "Delete repository…", exact: true }).and(page.locator(":enabled")).waitFor();
	assert.deepEqual(released, ["agent:publish-1"]);
	assert.equal(await page.getByRole("region", { name: "Unfinished cloud operations" }).count(), 0);
	await page.unroute("**/api/namespaces/fernloop/repositories/stuck-operation");
	await page.unroute("**/api/namespaces/fernloop/repositories/stuck-operation/command");
});

test("partial repository deletion shows its reason and retries the original operation", async () => {
	await page.request.post(`${server.origin}/api/namespaces/fernloop/repositories`, {
		data: { name: "retry-deletion", defaultBranch: "main", idempotencyKey: "retry-deletion" },
	});
	let pending = false;
	const commands = [];
	await page.route("**/api/namespaces/fernloop/repositories/retry-deletion", async (route) => {
		const response = await route.fetch();
		const snapshot = await response.json();
		if (pending) {
			snapshot.lifecycle = {
				state: "deleting",
				owner: true,
				blockers: [],
				deletionBlockers: [],
				unfinished: { workspaces: 0, attached: 0, changes: 0 },
				deletion: {
					idempotencyKey: commands[0].idempotencyKey,
					reason: "Cloudflare is rate limiting requests. Retry the same operation shortly.",
				},
			};
			snapshot.permissions.write = false;
			snapshot.permissions.maintain = false;
			snapshot.permissions.approve = false;
		}
		await route.fulfill({ response, json: snapshot });
	});
	await page.route("**/api/namespaces/fernloop/repositories/retry-deletion/command", async (route) => {
		const command = route.request().postDataJSON();
		if (command.tool !== "delete_repository") return route.continue();
		commands.push(command);
		if (commands.length === 1) {
			pending = true;
			return route.fulfill({ json: { state: "deleting" } });
		}
		pending = false;
		return route.continue();
	});
	await page.goto(`${server.origin}/?namespace=fernloop&repository=retry-deletion#/settings`);
	await page.getByRole("button", { name: "Delete repository…", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Delete repository permanently", exact: true });
	await dialog.getByLabel("Type retry-deletion to confirm", { exact: true }).fill("retry-deletion");
	await dialog.getByRole("button", { name: "Delete repository permanently", exact: true }).click();
	await page.getByRole("alert").filter({ hasText: "Cloudflare is rate limiting requests" }).waitFor();
	await page.getByRole("button", { name: "Retry deletion", exact: true }).click();
	await page.getByRole("heading", { name: "Fernloop", exact: true }).waitFor();
	assert.equal(commands.length, 2);
	assert.equal(commands[0].idempotencyKey, commands[1].idempotencyKey);
	await page.getByRole("button").filter({ hasText: "retry-deletion" }).waitFor({ state: "detached" });
});
