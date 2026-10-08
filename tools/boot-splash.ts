import type { Plugin } from "vite";
import { SPLASH_CSS, SPLASH_INNER, SPLASH_SCRIPT } from "../src/ui/splash.ts";

/** Puts the cold-start splash into every HTML entry, so the console page and the browser fixture start the same way. */
export function bootSplashPlugin(): Plugin {
	return {
		name: "cruce-boot-splash",
		transformIndexHtml: {
			order: "pre",
			handler: () => [
				{ tag: "script", children: SPLASH_SCRIPT, injectTo: "head-prepend" },
				{ tag: "style", children: SPLASH_CSS, injectTo: "head" },
				{ tag: "div", attrs: { id: "boot", class: "boot", role: "status" }, children: SPLASH_INNER, injectTo: "body-prepend" },
			],
		},
	};
}
