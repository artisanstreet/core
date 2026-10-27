import { defineConfig } from "vite";

// Dev proxy: the browser UI talks same-origin `/v1/*` (session cookies are
// HttpOnly + SameSite=Lax, so cross-origin fetch would drop them). In dev,
// forward those paths to a running Core worker. Production serves this
// bundle from Core itself (wiring owned by Core author; see docs/browser.md).
const CORE_DEV_URL = process.env.CORE_DEV_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: CORE_DEV_URL, changeOrigin: false },
      "/.well-known": { target: CORE_DEV_URL, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
});
