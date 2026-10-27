import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import reylo from "reylo/vite";

// Reylo turns relative `.sql` imports into typed query modules (dev + build).
// Import `.sql` files by relative path only: the Cloudflare plugin's text
// rule would otherwise claim alias imports before Reylo resolves them.
export default defineConfig(({ mode }) => ({
  plugins: mode === "test" ? [reylo()] : [reylo(), cloudflare()],
  build: {
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      CORE_ENV: "test",
    },
  },
}));
