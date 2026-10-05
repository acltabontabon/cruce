import { describe, expect, it } from "vitest";
import { installationConfig } from "../../tools/installation-config.mjs";

const live = {
	CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
	CRUCE_PUBLIC_ORIGIN: "https://cruce.example.org",
	CRUCE_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
	CRUCE_ACCESS_AUD: "audience",
};
describe("portable installation configuration", () => {
	it("builds offline without a personal account or domain", () => {
		expect(installationConfig({})).toMatchObject({
			accountId: undefined,
			domain: undefined,
			origin: "http://localhost:5173",
			artifactsNamespace: "cruce",
		});
	});
	it("uses the installer's configured account, domain and stable storage namespace", () => {
		expect(installationConfig({ ...live, CRUCE_ARTIFACTS_NAMESPACE: "team-source", CRUCE_WORKER_NAME: "team-cruce" }, true)).toMatchObject({
			accountId: live.CLOUDFLARE_ACCOUNT_ID,
			domain: "cruce.example.org",
			artifactsNamespace: "team-source",
			workerName: "team-cruce",
		});
	});
	it.each(["CLOUDFLARE_ACCOUNT_ID", "CRUCE_PUBLIC_ORIGIN", "CRUCE_ACCESS_ISSUER", "CRUCE_ACCESS_AUD"])(
		"fails live setup when %s is missing",
		(key) => {
			expect(() => installationConfig({ ...live, [key]: undefined }, true)).toThrow();
		},
	);
	it.each([
		"https://user:secret@example.org",
		"https://example.org/path",
		"https://example.org?token=secret",
		"file:///tmp",
		"https://localhost",
	])("rejects an invalid public origin %s", (origin) => {
		expect(() => installationConfig({ ...live, CRUCE_PUBLIC_ORIGIN: origin }, true)).toThrow();
	});
});
