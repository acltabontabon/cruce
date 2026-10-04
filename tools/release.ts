// SemVer 2.0.0: numeric identifiers cannot have leading zeroes.
const semver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function validateRelease(version: string, changelog: string, tag?: string): void {
	if (!semver.test(version)) throw new Error(`Invalid semantic version: ${version}`);
	if (tag !== undefined && tag !== `v${version}`) throw new Error(`Release tag must be v${version}; received ${tag}`);
	const heading = `## [${version}]`;
	const lines = changelog.split(/\r?\n/);
	const index = lines.findIndex((line) => line === heading || line.startsWith(`${heading} - `));
	if (index === -1) throw new Error(`CHANGELOG.md must contain ${heading}`);
	const next = lines.findIndex((line, i) => i > index && line.startsWith("## "));
	const notes = lines.slice(index + 1, next === -1 ? undefined : next).filter((line) => line.startsWith("- "));
	if (notes.length === 0) throw new Error(`CHANGELOG.md must contain release notes for ${version}`);
}
