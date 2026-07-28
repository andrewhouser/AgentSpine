/**
 * Build config for the web client.
 *
 * The SERVER has no build step and keeps none — `node src/*.ts` still just runs, and its
 * runtime dependencies are still `openai` and `playwright-core`. This applies to `web/`
 * only, and its whole toolchain lives in devDependencies so `npm audit --omit=dev` stays
 * at zero. (SPEC §8 records the distinction.)
 *
 * Output goes to ./public, which server.ts already serves — so a built client needs no
 * new plumbing, and `npm run dashboard` alone is still the whole thing.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  build: {
    // Relative to `root` (./web), so this is the repo-level ./public that server.ts serves.
    emptyOutDir: true,
    outDir: "../public",
  },
  plugins: [react()],
  root: "web",
  server: {
    port: 5173,
    // Proxying keeps the dev client same-origin with the API, so a dashboard token in
    // localStorage and an EventSource connection behave exactly as they do in production.
    proxy: {
      "/api": {
        changeOrigin: true,
        target: API_TARGET,
        // SSE must not be buffered or the tool cards all arrive at once, at the end.
        ws: false,
      },
    },
  },
});
