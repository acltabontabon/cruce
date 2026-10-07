import { pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { clientDownloadPlugin } from "../../tools/client-package.ts";
/** Explicitly local fixture. Never imported by the production Worker. */
export async function startFixtureServer() {
	let handle;
	const server = await createServer({
		configFile: false,
		plugins: [
			react(),
			clientDownloadPlugin(),
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
	const { consentPage, consentErrorPage } = await server.ssrLoadModule("/src/worker/consent-page.ts");
	let data = await fixture();
	handle = async (req, res, next) => {
		if (req.url?.startsWith("/__fixture/consent")) {
			const response = req.url.includes("error")
				? consentErrorPage("This connection request has expired. Start again from your tool.", "/__fixture/consent")
				: consentPage(
						{
							clientName: "Cruce git bridge",
							email: "maya@example.test",
							handle: "fixture-consent",
							redirectUri: "http://127.0.0.1:53605/callback",
							boundRepository: req.url.includes("bound"),
							repositories: req.url.includes("bound")
								? [{ id: "hello", label: "maya/hello-world" }]
								: req.url.includes("empty")
									? []
									: [
											{ id: "hello", label: "maya/hello-world" },
											{ id: "payments", label: "fernloop/payment-service" },
											{ id: "gateway", label: "gateway-check-20261006/gateway-reconciliation" },
											{
												id: "long",
												label:
													"a-very-long-namespace-name-for-narrow-screens/a-very-long-repository-name-that-must-wrap-instead-of-overflow",
											},
										],
							preset: ["cruce:read", "workspace:write", "revision:publish", "artifact:publish", "change:write", "promotion:request"],
						},
						new Headers(),
					);
			res.statusCode = response.status;
			response.headers.forEach((value, key) => {
				res.setHeader(key, value);
			});
			res.end(await response.text());
			return;
		}
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
