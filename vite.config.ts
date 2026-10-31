import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import reylo from "reylo/vite";

export default defineConfig(({ mode }) => ({
  plugins: mode === "test" ? [reylo()] : [reylo(), cloudflare()],
  server: {
    cors: false,
  },
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
