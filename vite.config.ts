import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { bootSplashPlugin } from "./tools/boot-splash.ts";
import { clientDownloadPlugin } from "./tools/client-package.ts";

export default defineConfig({
	plugins: [react(), bootSplashPlugin(), clientDownloadPlugin(), cloudflare()],
	server: { port: 5173 },
});
