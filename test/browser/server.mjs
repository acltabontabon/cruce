import { pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
/** Explicitly local fixture. Never imported by the production Worker. */
export async function startFixtureServer() {
	let handle;
	const server = await createServer({
		configFile: false,
		plugins: [
			react(),
			{
				name: "cruce-fixture",
				configureServer(server) {
					server.middlewares.use((req, res, next) => {
						if (req.url === "/" || req.url?.startsWith("/?") || req.url?.startsWith("/invite/") || /^\/sign-in(\?|$)/.test(req.url ?? ""))
							req.url = "/test/browser/index.html";
						return handle ? handle(req, res, next) : next();
					});
				},
			},
		],
		server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 0), watch: { ignored: ["**/.cloudflare/**", "**/dist/**"] } },
		appType: "spa",
	});
	const { fixture } = await server.ssrLoadModule("/test/browser/fixture.ts");
	let data = await fixture();
	handle = async (req, res, next) => {
		if (req.url === "/__fixture/reset") {
			data = await fixture();
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ base: data.base, head: data.head }));
			return;
		}
		return data.handle(req, res, next);
	};
	await server.listen();
	return { origin: server.resolvedUrls.local[0].replace(/\/$/, ""), close: () => server.close() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const server = await startFixtureServer();
	console.log(`Cruce deterministic local demo: ${server.origin}`);
}
