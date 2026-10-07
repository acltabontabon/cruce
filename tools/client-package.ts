import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Plugin } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
export const CLIENT_DOWNLOAD = "downloads/cruce-client.tgz";

/** Explicit allowlist: never ship installation configuration, fixtures or credentials. */
export async function clientArchive() {
	const staging = await mkdtemp(join(tmpdir(), "cruce-client-"));
	try {
		const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		const dependencies = Object.fromEntries(
			await Promise.all(
				["@modelcontextprotocol/client", "@modelcontextprotocol/server", "zod", "tsx"].map(async (name) => {
					const installed = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
					return [name, installed.version];
				}),
			),
		);
		const directory = join(staging, "package");
		await mkdir(directory);
		for (const path of ["runner", "src/core", "src/shared", "LICENSE"]) {
			await cp(join(root, path), join(directory, path), { recursive: true });
		}
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({
				name: "@cruce/client",
				version: metadata.version,
				type: "module",
				license: metadata.license,
				engines: metadata.engines,
				bin: { cruce: "runner/cruce.mjs", "cruce-git-credential": "runner/git-credential.mjs" },
				files: ["runner", "src/core", "src/shared", "LICENSE"],
				dependencies,
			}),
		);
		const { stdout } = await promisify(execFile)("npm", ["pack", "--json", "--ignore-scripts", "--cache", join(staging, "cache")], {
			cwd: directory,
		});
		const [{ filename }] = JSON.parse(stdout);
		return await readFile(join(directory, filename));
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** Ship the matching client with the console, without requiring registry publication. */
export function clientDownloadPlugin(): Plugin {
	let archive: Promise<Buffer> | undefined;
	const get = () => (archive ??= clientArchive());
	return {
		name: "cruce-client-download",
		applyToEnvironment: (environment) => environment.name === "client",
		async generateBundle() {
			this.emitFile({ type: "asset", fileName: CLIENT_DOWNLOAD, source: await get() });
		},
		configureServer(server) {
			server.middlewares.use(`/${CLIENT_DOWNLOAD}`, async (_req, res, next) => {
				try {
					res.setHeader("content-type", "application/gzip");
					res.end(await get());
				} catch (error) {
					next(error);
				}
			});
		},
	};
}
