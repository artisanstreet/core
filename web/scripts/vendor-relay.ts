// Vendors the vetted Relay browser transport into web/vendor/relay/.
//
// The deployed web runtime MUST NOT import `../../relay/src` (a sibling
// repo). This script copies the exact release files from a Relay checkout
// into a versioned vendor directory and records the source commit + file
// hashes, so the vendored code is a traceable release artifact instead of
// a live cross-repo import. Re-run whenever root announces a new Relay
// handoff commit.
//
// Vendored set (browser-safe client/channel closure ONLY):
// - schema/b64u/e2e: pure codecs (Effect Schema, base64url, Ed25519 PoP).
// - channel.ts + channel/: Noise XX framing/session/context + barrels.
// - client.ts + client/: RelaySocket/EditorLink + SecureChannel.
// Explicitly NOT vendored: Relay server graph (jwt server Effect adapter,
// channel-verify Forge authorizer, services/*, do/*, room/*, handlers,
// config). The browser never verifies grants (Forge/Relay do); it only
// mints via Core, parses its own grant jti, and checks scopes locally.
//
// Source of truth for the crypto contract: relay/contracts/e2e.md —
// Noise_XX_25519_ChaChaPoly_BLAKE2b via the pinned `noise-handshake`
// library, initiator JWT inside the encrypted confirm, Ed25519 `cnf`
// binding signatures over the transcript hash. No custom crypto.

import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const web_root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const relay_root = path.resolve(web_root, "..", "..", "relay");
const vendor_dir = path.join(web_root, "vendor", "relay");

// Relay-repo-relative source → vendor-relative destination (structure
// preserved so the vendored relative imports resolve unchanged).
const RELAY_FILES: ReadonlyArray<readonly [string, string]> = [
  ["src/schema.ts", "schema.ts"],
  ["src/b64u.ts", "b64u.ts"],
  ["src/e2e.ts", "e2e.ts"],
  ["src/channel.ts", "channel.ts"],
  ["src/channel/context.ts", "channel/context.ts"],
  ["src/channel/framing.ts", "channel/framing.ts"],
  ["src/channel/session.ts", "channel/session.ts"],
  ["src/client.ts", "client.ts"],
  ["src/client/relay-socket.ts", "client/relay-socket.ts"],
  ["src/client/secure-channel.ts", "client/secure-channel.ts"],
  ["types/noise-handshake.d.ts", "noise-handshake.d.ts"],
];

// Previously vendored files that left the browser-safe closure (Relay
// server graph now): remove after copying so no stale server adapter
// ships in the bundle.
const RETIRED_FILES: ReadonlyArray<string> = [
  "jwt.ts",
  "channel-verify.ts",
];

const expected_commit: string | null = process.argv[2] ?? null;

function relay_commit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: relay_root, encoding: "utf8" }).trim();
  } catch {
    return "unknown (sibling checkout has no git)";
  }
}

const commit = relay_commit();
if (expected_commit && commit !== expected_commit) {
  console.error(`relay checkout is at ${commit}, expected ${expected_commit}; refusing to vendor`);
  process.exit(1);
}

await mkdir(vendor_dir, { recursive: true });
const manifest: { commit: string; files: Record<string, string> } = { commit, files: {} };
for (const [rel, dst] of RELAY_FILES) {
  const src = path.join(relay_root, rel);
  const out = path.join(vendor_dir, dst);
  await mkdir(path.dirname(out), { recursive: true });
  await copyFile(src, out);
  const bytes = await readFile(out);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.files[dst] = sha256;
  console.log(`vendored ${rel} sha256=${sha256.slice(0, 16)}…`);
}
for (const retired of RETIRED_FILES) {
  await rm(path.join(vendor_dir, retired), { force: true });
  console.log(`retired ${retired} (Relay server graph, no longer browser-safe)`);
}
await writeFile(path.join(vendor_dir, "VERSION"), `${commit}\n`);
await writeFile(path.join(vendor_dir, "INTEGRITY.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`relay client vendored at commit ${commit}`);
