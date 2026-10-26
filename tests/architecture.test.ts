import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Ecosystem split, enforced: shared modules (services, contracts, db
// helpers) must never import Editor product code. Products depend on
// shared, never the reverse. The central HTTP router composes product
// routers (products/*/routes.ts registered from http.ts).
async function sourceFiles(dir: URL, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const u = new URL(e.name, dir);
    if (e.isDirectory()) await sourceFiles(new URL(`${e.name}/`, dir), out);
    else if (e.name.endsWith(".ts")) out.push(u.pathname);
  }
  void out;
  return out;
}

describe("ecosystem split", () => {
  it("shared modules never import product code", async () => {
    const root = new URL("../src/", import.meta.url);
    const bad: string[] = [];
    for (const dir of ["services/", "contracts/"]) {
      const files = await sourceFiles(new URL(dir, root));
      for (const f of files) {
        const text = await readFile(f, "utf8");
        for (const line of text.split("\n")) {
          const t = line.trim();
          if ((t.startsWith("import ") || t.includes("from ")) && t.includes("products/")) {
            bad.push(`${f}: ${t}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("product code lives under src/products/*", async () => {
    const editor = await sourceFiles(new URL("../src/products/editor/", import.meta.url));
    expect(editor.length).toBeGreaterThan(0);
    const names = editor.map((f) => f.split("/").pop());
    expect(names).toContain("routes.ts");
    expect(names).toContain("config.ts");
    expect(names).toContain("artifacts.ts");
    expect(names).toContain("providers.ts");
  });
});
