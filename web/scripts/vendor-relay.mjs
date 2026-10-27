// Vendors the vetted Relay browser transport into web/vendor/relay/.
//
// The deployed web runtime MUST NOT import `../../relay/src` (a sibling
// repo). This script copies the exact release files from a Relay checkout
// into a versioned vendor directory and records the source commit + file
// hashes, so the vendored code is a traceable release artifact instead of
// a live cross-repo import. Long term this should consume a versioned
// `@artisanstreet/relay-client` npm package; until root publishes one,
// re-run this script whenever root announces a new Relay handoff commit
// and paste the new commit into RELAY_COMMIT below (or pass it as
// `node scripts/vendor-relay.mjs <commit>` after checking that commit
// out in the sibling checkout).
//
// Source of truth for the crypto contract: relay/contracts/e2e.md —
// Noise_XX_25519_ChaChaPoly_BLAKE2b via the pinned `noise-handshake`
// library, initiator JWT inside the encrypted confirm, Ed25519 `cnf`
// binding signatures over the transcript hash. No custom crypto, no
// ephemeral-key registry (stale CnfDirectory assumptions are explicitly
// NOT implemented).

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const relayRoot = path.resolve(webRoot, "..", "..", "relay");
const vendorDir = path.join(webRoot, "vendor", "relay");

const RELAY_FILES = [
  "src/schema.ts",
  "src/jwt.ts",
  "src/b64u.ts",
  "src/e2e.ts",
  "src/channel.ts",
  "src/channel-verify.ts",
  "src/client.ts",
  "types/noise-handshake.d.ts",
];

const expectedCommit = process.argv[2] ?? null;

function relayCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: relayRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown (sibling checkout has no git)";
  }
}

const commit = relayCommit();
if (expectedCommit && commit !== expectedCommit) {
  console.error(`relay checkout is at ${commit}, expected ${expectedCommit}; refusing to vendor`);
  process.exit(1);
}

await mkdir(vendorDir, { recursive: true });
const manifest = { commit, files: {} };
for (const rel of RELAY_FILES) {
  const src = path.join(relayRoot, rel);
  const dst = path.join(vendorDir, path.basename(rel));
  await copyFile(src, dst);
  const bytes = await readFile(dst);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.files[path.basename(rel)] = sha256;
  console.log(`vendored ${rel} sha256=${sha256.slice(0, 16)}…`);
}
await writeFile(path.join(vendorDir, "VERSION"), `${commit}\n`);
await writeFile(path.join(vendorDir, "INTEGRITY.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`relay client vendored at commit ${commit}`);
