import { defineConfig } from "vitest/config";
import reylo from "reylo/vite";

// Node-environment behavioral tests. `.sql` imports resolve through Reylo;
// the database is PGlite (in-process Postgres) with db/schema.sql applied.
export default defineConfig({
  plugins: [reylo()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      CORE_ENV: "test",
    },
  },
});
