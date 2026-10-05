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
	await page?.close();
	await browser?.close();
	await server?.close();
});
beforeEach(async () => {
	await page?.close();
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(7000);
	await page.request.post(`${server.origin}/__fixture/reset`);
});
async function openRepo() {
	await page.goto(`${server.origin}/?namespace=fernloop&repository=payments`);
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
}
test("home lets the user choose a namespace before honest repository creation", async () => {
	await page.goto(server.origin);
	await page.getByRole("button", { name: "Alex Morgan", exact: true }).click();
	await page.getByText("No repositories yet.", { exact: false }).waitFor();
	await page.getByText("New repository", { exact: true }).click();
	await page.getByLabel("Repository name", { exact: true }).fill("local-tools");
	await page.getByRole("button", { name: "Add repository", exact: true }).click();
	await page.getByRole("heading", { name: "local-tools", exact: true }).waitFor();
	await page.getByText("No active workspaces.", { exact: false }).waitFor();
	assert.equal(await page.getByText("Production Healthy").count(), 0);
});
test("namespace home retains its filter while the avatar menu opens, and scoped navigation survives Back and reload", async () => {
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
	await page.locator(".home-repo").filter({ hasText: "payment-service" }).waitFor();
	await page.getByRole("heading", { name: "Work in motion", exact: true }).waitFor();
	await page.locator(".motion-row").getByText("2 active workspaces", { exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/namespaces.png", fullPage: true });
	await page.getByLabel("Filter namespaces").fill("payment-service");
	assert.equal(await page.locator(".namespace-card").count(), 1);
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("region", { name: "Your account", exact: true }).waitFor();
	assert.equal(new URL(page.url()).search, "");
	assert.equal(await page.getByLabel("Filter namespaces").inputValue(), "payment-service");
	await page.screenshot({ path: "dist/ui-checks/account.png", fullPage: true });
	await page.keyboard.press("Escape");
	await page.reload();
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
	await page.getByRole("button", { name: "Fernloop", exact: true }).click();
	await page.getByRole("navigation", { name: "Namespace navigation" }).getByRole("button", { name: "teams", exact: true }).click();
	await page.reload();
	await page.getByRole("heading", { name: "Teams", exact: true, level: 1 }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "Repositories", exact: true }).waitFor();
});
test("creation dialogs keep focus contained and explain unavailable cloud setup", async () => {
	await page.goto(server.origin);
	await page.getByRole("button", { name: "Alex Morgan", exact: true }).click();
	await page.screenshot({ path: "dist/ui-checks/empty-namespace.png", fullPage: true });
	const trigger = page.getByRole("button", { name: "New repository", exact: true });
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "New repository", exact: true });
	assert.equal(await dialog.getByRole("radio").count(), 0);
	await dialog.getByText("Creates canonical Git storage", { exact: false }).waitFor();
	await dialog.getByText("Connect Cloudflare in namespace settings before creating a repository.").waitFor();
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
	await page.getByRole("navigation", { name: "Namespace navigation" }).getByRole("button", { name: "members", exact: true }).waitFor();
});
test("brand navigation reaches an unscoped Home and Back restores the repository", async () => {
	await openRepo();
	await page.getByRole("link", { name: "Cruce home", exact: true }).click();
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
	assert.equal(new URL(page.url()).search, "");
	await page.getByRole("navigation", { name: "Current location" }).getByText("Home", { exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Switch namespace", exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "All namespaces", exact: true }).count(), 0);
	assert.equal(await page.getByRole("navigation", { name: "Namespace navigation" }).count(), 0);
	await page.reload();
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
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
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
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
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
	assert.equal(new URL(page.url()).search, "");
	assert.equal(await page.getByRole("button", { name: "Switch namespace", exact: true }).count(), 0);
	await page.reload();
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
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
	await page.getByRole("heading", { name: "Repositories", exact: true }).waitFor();
	await trigger.filter({ hasText: "Alex Morgan" }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Switch repository", exact: true }).count(), 0);
	assert.deepEqual(
		(await page.getByRole("navigation", { name: "Namespace navigation" }).getByRole("button").allTextContents()).map((text) => text.trim()),
		["repositories", "settings"],
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
	await page.getByRole("heading", { name: "Repositories", exact: true }).waitFor();
	assert.equal(new URL(page.url()).searchParams.has("repository"), false);
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
});
test("overview shows human and agent workspaces, reported overlap and published revision", async () => {
	await openRepo();
	await page.getByRole("heading", { name: "Shared surfaces" }).waitFor();
	await page.getByRole("heading", { name: "Review queue", exact: true }).waitFor();
	await page.getByText("1 agent working", { exact: true }).waitFor();
	await page.getByText("2 active workspaces", { exact: true }).waitFor();
	await page.getByText("Overlap is awareness, not a Git conflict.").waitFor();
	await page.screenshot({ path: "dist/ui-checks/repository.png", fullPage: true });
});
test("repository navigation ends at source coordination and removed routes use the normal fallback", async () => {
	await openRepo();
	const navigation = page.getByRole("navigation", { name: "Repository navigation" });
	assert.deepEqual(
		(await navigation.getByRole("button").allTextContents()).map((text) => text.trim().toLowerCase()),
		["overview", "code", "work", "settings"],
	);
	assert.equal(await page.getByRole("heading", { name: "Environments", exact: true }).count(), 0);
	await navigation.getByRole("button", { name: "work", exact: true }).click();
	await page.goto(page.url().replace(/#.*$/, "#deployments"));
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	assert.equal(await page.getByRole("heading", { name: "Deployments", exact: true }).count(), 0);
	await page.goBack();
	await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
	await page.goto(`${server.origin}/?namespace=fernloop#settings`);
	await page.getByRole("heading", { name: "Shared resource budgets", exact: true }).waitFor();
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
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/finder.png", fullPage: true });
	await page.screenshot({ path: "dist/ui-checks/search-header.png", clip: { x: 0, y: 0, width: 1440, height: 250 } });
	await page.keyboard.press("ArrowDown");
	assert.equal(await search.evaluate((element) => element === document.activeElement), true);
	assert.ok(await search.getAttribute("aria-activedescendant"));
	await page.keyboard.press("Enter");
	assert.equal(await page.getByRole("region", { name: "Repository search", exact: true }).count(), 0);
	await page.getByRole("navigation", { name: "Repository navigation" }).getByRole("button", { name: "work", exact: true }).click();
	await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
});
test("search shortcuts focus the same field, Escape and Tab dismiss results, and empty matches do not navigate", async () => {
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
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
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).click();
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
test("workspace detail preserves base, actor and execution provenance", async () => {
	await openRepo();
	await page.getByRole("button", { name: /Codex.*Implement retry policy/ }).click();
	await page.getByRole("heading", { name: "Implement retry policy", exact: true }).waitFor();
	await page.getByText("Started from", { exact: false }).waitFor();
	await page.getByText("Execution details", { exact: true }).click();
	await page.getByText(/worktree · fixture-/).waitFor();
});
test("workspaces disclose upstream updates and inspect advisory overlap without changing their starting revision", async () => {
	await page.request.post(`${server.origin}/__fixture/upstream`);
	await openRepo();
	await page.getByRole("button", { name: /Codex.*Implement retry policy/ }).click();
	await page.getByRole("heading", { name: "Implement retry policy", exact: true }).waitFor();
	const start = await page.getByText("Started from", { exact: false }).textContent();
	await page.getByText("Upstream updates available", { exact: false }).last().waitFor();
	await page.getByRole("button", { name: "Inspect upstream changes", exact: true }).click();
	await page.getByText("overlaps reported workspace work", { exact: false }).waitFor();
	assert.equal(await page.getByText("Started from", { exact: false }).textContent(), start);
});
test("exact revision review and attestation update readiness", async () => {
	await openRepo();
	await page.getByRole("navigation", { name: "Repository navigation" }).getByRole("button", { name: "work", exact: true }).click();
	await page.getByRole("button", { name: /#1.*Bounded retry policy/ }).click();
	await page.getByLabel("Reason", { exact: true }).fill("Inspected exact commit");
	await page.getByRole("button", { name: "Submit review" }).click();
	await page.getByLabel("What you inspected").fill("Verified local test run against this commit");
	await page.getByRole("button", { name: "Attest verification" }).click();
	await page.getByText("Ready for human promotion").waitFor();
	assert.equal(await page.getByRole("button", { name: "Promote source", exact: true }).isEnabled(), true);
});
test("published revision lineage links the exact commit and originating workspace", async () => {
	await openRepo();
	await page.getByRole("button", { name: /Bounded retry policy.*Published revision/ }).click();
	await page.getByRole("button", { name: "Trace lineage" }).click();
	await page.locator(".lineage").filter({ hasText: "Implement retry policy" }).waitFor();
});
test("Code lists source publications and keeps exact revision, diff and review links through reload and Back", async () => {
	const data = await (await page.request.get(`${server.origin}/api/namespaces/fernloop/repositories/payments`)).json();
	const source = data.artifacts.find((a) => a.kind === "source");
	await openRepo();
	await page.getByText("1 published revision", { exact: true }).waitFor();
	await page.getByRole("navigation", { name: "Repository navigation" }).getByRole("button", { name: "code", exact: true }).click();
	await page.getByRole("heading", { name: "Published revisions", exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: /Retry policy test report/ }).count(), 0);
	await page.getByRole("button", { name: /Bounded retry policy.*Published revision/ }).click();
	assert.ok(page.url().endsWith(`#/code/${source.id}`));
	assert.equal(await page.getByLabel("Revision", { exact: true }).inputValue(), source.revision);
	await page.getByText("Review base", { exact: true }).waitFor();
	await page.getByText("Storage details", { exact: true }).click();
	await page.getByText(source.contentHash, { exact: true }).waitFor();
	await page.getByRole("button", { name: "Browse source", exact: true }).click();
	await page.getByRole("navigation", { name: "Repository files" }).getByRole("button", { name: "src/retry.ts", exact: true }).click();
	await page.locator(".source-browser pre").getByText("export const retries = 3;", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Change diff", exact: true }).click();
	await page
		.getByRole("navigation", { name: "Changed files" })
		.getByRole("button", { name: /src\/retry.ts/ })
		.click();
	await page.locator(".patch").waitFor();
	await page.reload();
	assert.equal(await page.getByLabel("Revision", { exact: true }).inputValue(), source.revision);
	await page.getByRole("button", { name: "View change #1 →", exact: true }).click();
	await page.getByRole("heading", { name: "Bounded retry policy", exact: true, level: 1 }).waitFor();
	await page.getByRole("button", { name: "View revision →", exact: true }).click();
	await page.getByRole("heading", { name: "Code", exact: true }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "Bounded retry policy", exact: true, level: 1 }).waitFor();
});
test("saved inspection links resolve into Code or Work without adding a Back history entry", async () => {
	await openRepo();
	const root = `${server.origin}/?namespace=fernloop&repository=payments`;
	await page.goto(`${root}#/artifacts/source`);
	await page.getByRole("heading", { name: "Code", exact: true }).waitFor();
	await page.getByRole("heading", { name: "Bounded retry policy", exact: true }).waitFor();
	assert.ok(page.url().endsWith("#/code/source"));
	await page.reload();
	await page.getByRole("heading", { name: "Bounded retry policy", exact: true }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	await page.goto(`${root}#/artifacts/test-report`);
	await page.getByRole("heading", { name: "Retry policy test report", exact: true }).waitFor();
	assert.ok(page.url().endsWith("#/work/test-report"));
	await page.goto(`${root}#/artifacts`);
	await page.getByRole("heading", { name: "Published revisions", exact: true }).waitFor();
	assert.ok(page.url().endsWith("#/code"));
});
test("stored evidence is readable beside its change and discoverable from Work and its workspace", async () => {
	await openRepo();
	await page.getByRole("button", { name: /#1.*Bounded retry policy/ }).click();
	await page.getByRole("button", { name: /Retry policy test report.*Evidence/ }).click();
	assert.ok(page.url().endsWith("#/work/test-report"));
	await page.getByRole("button", { name: "Read evidence", exact: true }).click();
	await page.locator("pre").getByText("Reported tests: 12 passed", { exact: false }).waitFor();
	await page.getByRole("button", { name: "Trace lineage", exact: true }).click();
	await page.locator(".lineage").getByText("Implement retry policy", { exact: true }).waitFor();
	await page.reload();
	await page.getByRole("heading", { name: "Retry policy test report", exact: true }).waitFor();
	await page.getByRole("button", { name: "View change #1 →", exact: true }).click();
	assert.equal(await page.getByRole("button", { name: "Promote source", exact: true }).isDisabled(), true);
	await page.getByRole("button", { name: "← All work", exact: true }).click();
	await page.getByRole("heading", { name: "Revision evidence", exact: true }).waitFor();
	await page.getByRole("button", { name: /Retry policy test report.*Evidence/ }).click();
	await page.getByRole("button", { name: "Implement retry policy", exact: true }).click();
	await page.getByRole("heading", { name: "Implement retry policy", exact: true }).waitFor();
	await page.getByRole("button", { name: /Bounded retry policy.*Published revision/ }).waitFor();
	await page.getByRole("button", { name: /Retry policy test report.*Evidence/ }).waitFor();
});
test("changes exclude stale and unrelated reports while preserving explicitly linked evidence and unproposed reports", async () => {
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
			summary: "Linked reported check",
		});
		await route.fulfill({ json: data });
	});
	await openRepo();
	await page.getByRole("button", { name: /#1.*Bounded retry policy/ }).click();
	await page.getByRole("button", { name: /Explicitly linked report/ }).waitFor();
	assert.equal(await page.getByRole("button", { name: /Earlier revision report|Unrelated workspace report/ }).count(), 0);
	await page.getByRole("button", { name: /Explicitly linked report/ }).click();
	await page.getByRole("button", { name: "View change #1 →", exact: true }).waitFor();
	await page.getByRole("button", { name: "← All work", exact: true }).click();
	await page.getByRole("button", { name: /Earlier revision report/ }).click();
	assert.equal(await page.getByRole("button", { name: "View change #1 →", exact: true }).count(), 0);
	await page.route("**/command", async (route) =>
		route.request().postDataJSON().tool === "read_artifact" ? route.fulfill({ json: {} }) : route.continue(),
	);
	await page.getByRole("button", { name: "Read evidence", exact: true }).click();
	await page.getByText("Evidence content is unavailable.", { exact: true }).waitFor();
});
test("late evidence responses cannot appear after navigating to a published revision", async () => {
	await page.goto(`${server.origin}/?namespace=fernloop&repository=payments#/work/test-report`);
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
	await page.getByRole("heading", { name: "Code", exact: true }).waitFor();
	const response = page.waitForResponse((r) => r.request().postData()?.includes("read_artifact"));
	release();
	await response;
	await page.getByRole("button", { name: "Trace lineage", exact: true }).click();
	await page.locator(".lineage").waitFor();
	assert.equal(await page.getByText("STALE EVIDENCE RESPONSE", { exact: true }).count(), 0);
});
test("teams and invitation links are functional", async () => {
	await page.goto(`${server.origin}/?namespace=fernloop`);
	await page.getByRole("navigation", { name: "Namespace navigation" }).getByRole("button", { name: "teams", exact: true }).click();
	await page.locator("summary").filter({ hasText: "Create team" }).click();
	await page.getByLabel("Team name").fill("Platform");
	await page.getByRole("checkbox", { name: "Alex Morgan" }).check();
	await page.getByRole("button", { name: "Create team", exact: true }).click();
	await page.locator("summary").filter({ hasText: "Platform" }).waitFor();
	await page.getByRole("navigation", { name: "Namespace navigation" }).getByRole("button", { name: "members", exact: true }).click();
	await page.getByLabel("Email", { exact: true }).fill("alex@example.com");
	await page.getByRole("button", { name: "Create invitation link" }).click();
	await page.getByRole("status").filter({ hasText: "/invite/fernloop" }).waitFor();
});
test("mobile view has no horizontal page overflow", async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openRepo();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.screenshot({ path: "dist/ui-checks/mobile.png", fullPage: true });
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
	await page.getByRole("button", { name: "Alex Morgan", exact: true }).click();
	await page.getByRole("button", { name: "New repository", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "New repository" });
	await dialog.getByLabel("Repository name", { exact: true }).fill("mobile-tools");
	await page.screenshot({ path: "dist/ui-checks/create-mobile.png", fullPage: true });
	await dialog.getByRole("button", { name: "Add repository", exact: true }).click();
	await page.getByRole("heading", { name: "mobile-tools", exact: true }).waitFor();
});

test("repository clone uses normal Git and workspace fork cleanup is unavailable while active", async () => {
	await openRepo();
	await page.getByText("Clone", { exact: true }).click();
	await page.getByText(`git clone ${server.origin}/mcp/git/fernloop/payments/canonical.git`, { exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: /Codex.*Implement retry policy/ }).click();
	await page.getByText("Execution details", { exact: true }).click();
	await page.getByText("Workspace fork · ready", { exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Clean up retained fork" }).isDisabled(), true);
});

test("surface selection and keyboard focus preserve independent workspace identities", async () => {
	await openRepo();
	const surface = page.getByRole("button", { name: "src/retry.ts 2 workspaces" });
	await surface.focus();
	await page.keyboard.press("Enter");
	assert.equal(await surface.getAttribute("aria-expanded"), "true");
	assert.equal(await page.locator(".topology-lane.highlighted").count(), 2);
	await page.locator(".surface-detail").getByRole("button", { name: "Implement retry policy" }).click();
	await page.getByRole("heading", { name: "Implement retry policy", exact: true }).waitFor();
	assert.equal(await page.locator(".workspace-list").count(), 0);
	await page.reload();
	await page.getByText("Started from", { exact: false }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	const lane = page.getByRole("button", { name: /Codex.*Implement retry policy/ });
	await lane.focus();
	assert.equal(await page.locator(".surface-button.highlighted").count(), 1);
});

test("failed promotion preserves canonical source and reuses retry identity", async () => {
	await openRepo();
	const before = await page.locator(".canonical-track").innerText();
	await page.getByRole("button", { name: /#1.*Bounded retry policy/ }).click();
	await page.getByLabel("Reason", { exact: true }).fill("Exact revision inspected");
	await page.getByRole("button", { name: "Submit review" }).click();
	await page.getByText("Trusted passing tests evidence required", { exact: false }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Promote source", exact: true }).isDisabled(), true);
	await page.getByLabel("What you inspected").fill("Checked the exact source");
	await page.getByRole("button", { name: "Attest verification" }).click();
	await page.getByText("Ready for human promotion").waitFor();
	const keys = [];
	await page.route("**/command", async (route) => {
		const body = route.request().postDataJSON();
		if (body.tool !== "promote_proposal") return route.continue();
		keys.push(body.idempotencyKey);
		await route.fulfill({ status: 503, json: { error: "Canonical update unavailable" } });
	});
	await page.getByRole("button", { name: "Promote source", exact: true }).click();
	await page.getByRole("alert").filter({ hasText: "Canonical update unavailable" }).waitFor();
	await page.getByRole("button", { name: "Promote source", exact: true }).click();
	await page.getByRole("alert").filter({ hasText: "Canonical update unavailable" }).waitFor();
	assert.equal(keys.length, 2);
	assert.equal(keys[0], keys[1]);
	await page.getByRole("navigation", { name: "Repository navigation" }).getByRole("button", { name: "overview", exact: true }).click();
	assert.equal(await page.locator(".canonical-track").innerText(), before);
	assert.equal(await page.locator(".promotion-link").count(), 0);
});

test("unknown canonical and disconnected writers stay distinct from accepted source", async () => {
	await page.route("**/api/namespaces/fernloop/repositories/payments", async (route) => {
		const response = await route.fetch(),
			data = await response.json();
		delete data.sourceHead;
		data.refs = [{ ref: "main", revision: "d".repeat(40), trust: "reported" }];
		data.workspaces[0].state = "disconnected";
		data.workspaces.push({
			...data.workspaces[0],
			id: "observer",
			mode: "read",
			state: "active",
			actor: { ...data.workspaces[0].actor, name: "Read-only participant" },
		});
		await route.fulfill({ json: data });
	});
	await openRepo();
	await page.locator(".canonical-track").getByText("Unavailable", { exact: true }).waitFor();
	assert.equal(await page.locator(".topology-lane.disconnected").count(), 1);
	assert.equal(await page.locator(".topology-lane").count(), 2);
	await page.locator(".observers").getByText("Observers · Read-only participant").waitFor();
	assert.equal(await page.getByRole("button", { name: "Clone", exact: true }).isDisabled(), true);
});

test("namespace failures remain unavailable and retry restores actual topology", async () => {
	let fail = true;
	await page.route("**/api/namespaces/fernloop", async (route) =>
		fail ? route.fulfill({ status: 503, json: { error: "Namespace temporarily unavailable" } }) : route.continue(),
	);
	await page.goto(server.origin);
	await page.getByRole("alert").filter({ hasText: "Namespace temporarily unavailable" }).waitFor();
	assert.equal(await page.locator(".motion-row").count(), 0);
	fail = false;
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await page.locator(".motion-row").getByText("2 active workspaces", { exact: true }).waitFor();
	assert.equal(await page.locator(".mini-topology .crossing").count(), 1);
});

test("late source responses cannot overwrite a newer history inspection", async () => {
	await openRepo();
	await page.getByRole("navigation", { name: "Repository navigation" }).getByRole("button", { name: "code", exact: true }).click();
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
	await page.getByRole("button", { name: "Browse source", exact: true }).click();
	await ready;
	await page.getByRole("button", { name: "Commit history", exact: true }).click();
	await page.locator(".commit-history").waitFor();
	const response = page.waitForResponse((r) => r.request().postData()?.includes("get_source"));
	release();
	await response;
	await page.getByRole("heading", { name: "Code", exact: true }).waitFor();
	assert.equal(await page.locator(".source-browser").count(), 0);
	assert.equal(await page.locator(".commit-history").count(), 1);
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
			.locator(".topology-lane")
			.first()
			.evaluate((e) => getComputedStyle(e).transitionDuration),
		"0s",
	);
});

test("screen families remain readable across desktop, tablet, mobile and 200 percent zoom", async () => {
	const data = await (await page.request.get(`${server.origin}/api/namespaces/fernloop/repositories/payments`)).json();
	const root = `${server.origin}/?namespace=fernloop&repository=payments`;
	const routes = [
		["home", server.origin, "Agent work. Shared direction."],
		["overview", root, "payment-service"],
		["work", `${root}#/work`, "Work"],
		["review", `${root}#/work/${data.proposals[0].id}`, "Bounded retry policy"],
		["workspace", `${root}#/work/${data.workspaces[0].id}`, data.workspaces[0].title],
		["revision", `${root}#/code/${data.artifacts[0].id}`, "Bounded retry policy"],
		["evidence", `${root}#/work/test-report`, "Retry policy test report"],
		["code", `${root}#/code`, "Code"],
		["repository-settings", `${root}#/settings`, "Repository settings"],
		["members", `${server.origin}/?namespace=fernloop#/members`, "Members"],
		["teams", `${server.origin}/?namespace=fernloop#/teams`, "Teams"],
		["namespace-settings", `${server.origin}/?namespace=fernloop#/settings`, "Settings"],
		["account", `${server.origin}/?page=account`, "Agent work. Shared direction."],
	];
	for (const width of [1440, 1024, 390]) {
		await page.setViewportSize({ width, height: 1000 });
		for (const [name, url, title] of routes) {
			await page.goto(url);
			await page.getByRole("heading", { name: title, exact: true }).waitFor();
			if (name === "account") {
				await page.getByRole("region", { name: "Your account", exact: true }).waitFor();
			}
			if (name === "code") {
				await page.getByRole("button", { name: "Browse source", exact: true }).click();
				await page.locator(".source-browser").waitFor();
			}
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
	await page.goto(root);
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
	await page.evaluate(() => {
		document.documentElement.style.zoom = "2";
	});
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	assert.equal(await page.getByRole("button", { name: "Switch namespace" }).isVisible(), true);
	assert.ok((await page.locator(".topology-panel").boundingBox()).width >= 500);
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

test("many writers, long paths and read-only authority keep a usable bounded overview", async () => {
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
	assert.equal(await page.locator(".topology-lane").count(), 6);
	await page.getByRole("button", { name: "View all work · 2 more writers" }).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	await page.screenshot({ path: "dist/ui-checks/many-writers-mobile.png", fullPage: true });
	await page.getByRole("button", { name: /#1.*Bounded retry policy/ }).click();
	assert.equal(await page.getByRole("button", { name: "Submit review" }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Promote source" }).count(), 0);
	await page.getByRole("button", { name: "← All work" }).click();
	assert.equal(await page.locator(".workspace-list > button").count(), 9);
});
