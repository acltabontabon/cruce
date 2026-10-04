import { readFile } from "node:fs/promises";
import { validateRelease } from "./release.ts";

const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
validateRelease(metadata.version, changelog, process.argv[2]);
console.log(`Release metadata valid: v${metadata.version}`);
