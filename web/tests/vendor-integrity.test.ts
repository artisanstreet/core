// The vendored Relay client is a traceable release artifact: every file
// must match the recorded INTEGRITY.json from the vendored commit, or the
// deployment bundles unknown crypto.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const vendor = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "relay");

describe("vendored relay client integrity", () => {
  it("every vendored file matches INTEGRITY.json", () => {
    const manifest = JSON.parse(readFileSync(join(vendor, "INTEGRITY.json"), "utf8")) as {
      commit: string;
      files: Record<string, string>;
    };
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    const version = readFileSync(join(vendor, "VERSION"), "utf8").trim();
    expect(version).toBe(manifest.commit);
    for (const [name, sha] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(vendor, name));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
    }
    const onDisk = readdirSync(vendor).filter((f) => f.endsWith(".ts"));
    expect(new Set(onDisk)).toEqual(new Set(Object.keys(manifest.files).filter((f) => f.endsWith(".ts"))));
  });

  it("vendor commit is the announced Relay handoff", () => {
    const version = readFileSync(join(vendor, "VERSION"), "utf8").trim();
    expect(version).toBe("f50958dacdaa68c139035ce431cbdb21d38cbae0");
  });
});
