import { defineConfig } from "vite-plus";

// Dev proxy: the browser UI talks same-origin `/v1/*` (session cookies are
// HttpOnly + SameSite=Lax, so cross-origin fetch would drop them). In dev,
// forward those paths to a running Core worker. Production serves this
// bundle from Core itself (wiring owned by Core author; see docs/browser.md).
const CORE_DEV_URL = process.env.CORE_DEV_URL ?? "http://127.0.0.1:8787";

// Optional dev parity with the production shell CSP: set
// VITE_DEV_CSP_RELAY_ORIGIN=http(s)://relay-host[:port] to emit the same
// connect-src/img-src allowlist shape the Core shell sends in production.
// script-src always carries 'wasm-unsafe-eval' (no 'unsafe-eval'): the
// bundled sodium-javascript compiles Wasm at startup. Unset by default
// (dev serves without CSP, like an unconfigured deploy).
function devCsp(): Record<string, string> | undefined {
  const raw = (process.env.VITE_DEV_CSP_RELAY_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!raw) return undefined;
  let allow = "";
  try {
    const u = new URL(raw);
    if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname && !u.username && !u.password) {
      const host = u.hostname.toLowerCase();
      const defPort = u.protocol === "https:" ? "443" : "80";
      const port = u.port && u.port !== defPort ? `:${u.port}` : "";
      const secure = u.protocol === "https:";
      allow = ` ${secure ? "https" : "http"}://${host}${port} ${secure ? "wss" : "ws"}://${host}${port}`;
    }
  } catch {
    return undefined;
  }
  if (!allow) return undefined;
  return {
    "Content-Security-Policy":
      `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;` +
      ` connect-src 'self'${allow}; frame-ancestors 'none'; base-uri 'none'`,
  };
}

const devHeaders = devCsp();
const serverHeaders = {
  ...(devHeaders ? { headers: devCsp() as Record<string, string> } : {}),
};

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: CORE_DEV_URL, changeOrigin: false },
      "/.well-known": { target: CORE_DEV_URL, changeOrigin: false },
    },
    ...serverHeaders,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
