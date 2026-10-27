// The vendored Relay client is a traceable release artifact: every file
// must match the recorded INTEGRITY.json from the vendored commit, or the
// deployment bundles unknown crypto. The vendor set is the browser-safe
// client/channel closure only (schema/b64u/e2e + channel/* + client/*);
// Relay server graph (jwt adapter, channel-verify, services/*) is never
// vendored — the browser never verifies grants.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const vendor = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "relay");

/** Vendored source files, relative to vendor/, forward slashes. */
function vendored_sources(dir: string, out: Array<string> = []): Array<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      vendored_sources(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(relative(vendor, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

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
    expect(vendored_sources(vendor)).toEqual(Object.keys(manifest.files).filter((f) => f.endsWith(".ts")).sort());
  });

  it("vendor commit is the announced Relay handoff", () => {
    const version = readFileSync(join(vendor, "VERSION"), "utf8").trim();
    expect(version).toBe("22623884d650908fd30be2c167c78c05163376ad");
  });

  it("contains no Relay server graph", () => {
    const sources = vendored_sources(vendor);
    for (const name of ["jwt.ts", "channel-verify.ts", "services/", "do/", "room.ts", "router.ts"]) {
      expect(sources.some((s) => s === name || s.startsWith(name.replace(/\/$/, "") + "/"))).toBe(false);
    }
    expect(sources).toContain("client/relay-socket.ts");
    expect(sources).toContain("client/secure-channel.ts");
    expect(sources).toContain("channel/session.ts");
    expect(sources).toContain("channel/framing.ts");
    expect(sources).toContain("channel/context.ts");
  });
});
