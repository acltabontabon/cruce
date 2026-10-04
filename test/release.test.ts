import { describe, expect, it } from "vitest";
import { validateRelease } from "../tools/release.ts";

const notes = (version: string) => `## [Unreleased]\n\n## [${version}]\n\n### Added\n\n- Release notes.\n`;

describe("release metadata", () => {
	it.each(["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-beta.1", "0.1.0-rc.1", "0.1.0", "1.2.3+build.01"])(
		"accepts semantic version %s and its exact tag",
		(version) => expect(() => validateRelease(version, notes(version), `v${version}`)).not.toThrow(),
	);
	it.each(["0.1.0.alpha.1", "01.1.0", "0.1.0-alpha.01", "0.1.0-01", "v0.1.0", "0.1"])("rejects invalid version %s", (version) => {
		expect(() => validateRelease(version, notes(version))).toThrow("Invalid semantic version");
	});
	it("rejects a tag that differs from the package version", () => {
		expect(() => validateRelease("0.1.0-alpha.1", notes("0.1.0-alpha.1"), "v0.1.0")).toThrow("Release tag must be");
	});
	it("requires notes for the exact version, not just Unreleased or another version", () => {
		expect(() => validateRelease("0.1.0-alpha.1", notes("0.1.0-alpha.10"))).toThrow("must contain ##");
		expect(() => validateRelease("0.1.0-alpha.1", "## [0.1.0-alpha.1]\n\n## [Unreleased]\n- Future change")).toThrow("release notes");
	});
});
