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
	await page.goto(`${server.origin}/?workspace=maya&repository=payments`);
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
}
test("first login lands in a personal workspace with honest repository creation", async () => {
	await page.goto(server.origin);
	await page.getByText("No repositories yet.", { exact: false }).waitFor();
	await page.getByText("New repository", { exact: true }).click();
	await page.getByLabel("Repository name", { exact: true }).fill("local-tools");
	await page.getByRole("button", { name: "Add repository", exact: true }).click();
	await page.getByRole("heading", { name: "local-tools", exact: true }).waitFor();
	await page.getByText("No active sessions.", { exact: false }).waitFor();
	assert.equal(await page.getByText("Production Healthy").count(), 0);
});
test("overview shows human and agent sessions, reported overlap and source artifact", async () => {
	await openRepo();
	await page.getByRole("heading", { name: "Shared surfaces" }).waitFor();
	await page.getByText("2 active sessions", { exact: true }).waitFor();
	await page.getByText("Overlap is awareness, not a Git conflict.").waitFor();
	await page.screenshot({ path: "dist/ui-checks/repository.png", fullPage: true });
});
test("repository switcher supports keyboard selection and Back navigation", async () => {
	await openRepo();
	await page.keyboard.press("Meta+k");
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("textbox").fill("maya/payment");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await page.getByRole("navigation", { name: "Repository navigation" }).getByRole("button", { name: "work", exact: true }).click();
	await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
	await page.goBack();
	await page.getByRole("heading", { name: "payment-service", exact: true }).waitFor();
});
test("session detail preserves base, actor and execution provenance", async () => {
	await openRepo();
	await page.getByRole("button", { name: /Codex.*Implement retry policy/ }).click();
	await page.getByRole("heading", { name: "Implement retry policy", exact: true }).waitFor();
	await page.getByText("Started from", { exact: false }).waitFor();
	await page.getByText("Execution details", { exact: true }).click();
	await page.getByText(/worktree · fixture-/).waitFor();
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
	await page.getByText("After approval, merge and push with normal Git.", { exact: false }).waitFor();
});
test("artifact lineage links the exact commit and originating session", async () => {
	await openRepo();
	await page.getByRole("button", { name: /Bounded retry policy.*source/ }).click();
	await page.getByRole("button", { name: "Trace lineage" }).click();
	await page.locator(".lineage").filter({ hasText: "Implement retry policy" }).waitFor();
});
test("teams and invitation links are functional", async () => {
	await page.goto(`${server.origin}/?workspace=maya`);
	await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "teams", exact: true }).click();
	await page.locator("summary").filter({ hasText: "Create team" }).click();
	await page.getByLabel("Team name").fill("Platform");
	await page.getByRole("checkbox", { name: "Cris" }).check();
	await page.getByRole("button", { name: "Create team", exact: true }).click();
	await page.locator("summary").filter({ hasText: "Platform" }).waitFor();
	await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "members", exact: true }).click();
	await page.getByLabel("Email", { exact: true }).fill("maya@example.com");
	await page.getByRole("button", { name: "Create invitation link" }).click();
	await page.getByRole("status").filter({ hasText: "/invite/maya" }).waitFor();
});
test("mobile view has no horizontal page overflow", async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openRepo();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
	await page.screenshot({ path: "dist/ui-checks/mobile.png", fullPage: true });
});
