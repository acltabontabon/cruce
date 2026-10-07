import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { clientDownloadPlugin } from "./tools/client-package.ts";

export default defineConfig({
	plugins: [react(), clientDownloadPlugin(), cloudflare()],
	server: { port: 5173 },
});
