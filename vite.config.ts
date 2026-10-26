import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import reylo from "reylo/vite";

// Reylo turns relative `.sql` imports into typed query modules (dev + build).
// Import `.sql` files by relative path only: the Cloudflare plugin's text
// rule would otherwise claim alias imports before Reylo resolves them.
export default defineConfig({
  plugins: [reylo(), cloudflare()],
});
