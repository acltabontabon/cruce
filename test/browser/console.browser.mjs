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
test("first login lands in a personal namespace with honest repository creation", async () => {
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
test("namespace home filters repositories and account navigation survives Back and reload", async () => {
	await page.goto(server.origin);
	await page.getByRole("heading", { name: "Agent work. Shared direction." }).waitFor();
	await page.locator(".home-repo").filter({ hasText: "payment-service" }).waitFor();
	await page.getByRole("heading", { name: "Work in motion", exact: true }).waitFor();
	await page.locator(".motion-row").getByText("2 active workspaces", { exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/namespaces.png", fullPage: true });
	await page.getByLabel("Filter namespaces").fill("payment-service");
	assert.equal(await page.locator(".namespace-card").count(), 1);
	await page.getByRole("button", { name: "Your account", exact: true }).click();
	await page.getByRole("heading", { name: "Your account", exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/account.png", fullPage: true });
	await page.reload();
	await page.getByRole("heading", { name: "Your account", exact: true }).waitFor();
	await page.goBack();
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
test("overview shows human and agent workspaces, reported overlap and source artifact", async () => {
	await openRepo();
	await page.getByRole("heading", { name: "Shared surfaces" }).waitFor();
	await page.getByRole("heading", { name: "Review queue", exact: true }).waitFor();
	await page.getByText("1 agent working", { exact: true }).waitFor();
	await page.getByText("2 active workspaces", { exact: true }).waitFor();
	await page.getByText("Overlap is awareness, not a Git conflict.").waitFor();
	await page.screenshot({ path: "dist/ui-checks/repository.png", fullPage: true });
});
test("repository switcher supports keyboard selection and Back navigation", async () => {
	await openRepo();
	await page.keyboard.press("Meta+k");
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("textbox").fill("fernloop/payment");
	await dialog.getByRole("button", { name: "fernloop/payment-service", exact: true }).waitFor();
	await page.screenshot({ path: "dist/ui-checks/finder.png", fullPage: true });
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await page.getByRole("navigation", { name: "Repository navigation" }).getByRole("button", { name: "work", exact: true }).click();
	await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
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
	await page.getByText(/#1 Bounded retry policy/).click();
	await page.getByLabel("Reason", { exact: true }).fill("Inspected exact commit");
	await page.getByRole("button", { name: "Submit review" }).click();
	await page.getByLabel("What you inspected").fill("Verified local test run against this commit");
	await page.getByRole("button", { name: "Attest verification" }).click();
	await page.getByText("Ready for human promotion").waitFor();
	assert.equal(await page.getByRole("button", { name: "Promote source", exact: true }).isEnabled(), true);
});
test("artifact lineage links the exact commit and originating workspace", async () => {
	await openRepo();
	await page.getByRole("button", { name: /Bounded retry policy.*source/ }).click();
	await page.getByRole("button", { name: "Trace lineage" }).click();
	await page.locator(".lineage").filter({ hasText: "Implement retry policy" }).waitFor();
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
	await page.getByRole("heading", { name: "Your account", exact: true }).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.getByRole("button", { name: "Switch namespace" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Alex Morgan", exact: false }).click();
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
	await page.getByRole("button", { name: /Codex.*Implement retry policy/ }).click();
	await page.getByText("Artifacts fork · ready", { exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "Clean up retained fork" }).isDisabled(), true);
});
