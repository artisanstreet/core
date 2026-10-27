import * as Effect from "effect/Effect";
import { layer as NodeLayer } from "@effect/platform-node/NodeServices";
import { readPrebuiltWorkerBundle } from "../node_modules/@alchemy.run/cloudflare/lib/Workers/Sources/Prebuilt.js";
import { pathToFileURL } from "node:url";
import * as Path from "node:path";

const CORE_ROOT = Path.resolve(import.meta.dirname, "../..");
const ENTRY_ABS = Path.join(CORE_ROOT, "dist/ast_core/index.js");

const program = Effect.gen(function* () {
  const out = yield* readPrebuiltWorkerBundle({ main: ENTRY_ABS });
  return out;
});

const out = await Effect.runPromise(program.pipe(Effect.provide(NodeLayer)));

console.log(`modules=${out.files.length} hash=${out.hash.slice(0, 12)}…`);
for (const f of out.files) console.log(` - ${f.path} (${typeof f.content === "string" ? f.content.length : f.content.byteLength} bytes)`);

const names = out.files.map((f) => f.path);
if (names[0] !== "index.js") throw new Error(`entry must be index.js, got ${names[0]}`);
if (names.some((n) => n.endsWith(".map"))) throw new Error("source maps must not be uploaded");

// Import execution (not substring): the prebuilt entry must export a Worker
// with fetch + scheduled handlers.
const mod = await import(pathToFileURL(ENTRY_ABS).href);
if (typeof mod.default?.fetch !== "function") throw new Error("prebuilt default export must have fetch()");
if (typeof mod.default?.scheduled !== "function") throw new Error("prebuilt default export must have scheduled()");
console.log("entry exports: fetch + scheduled OK");
console.log("OFFLINE BUNDLE VERIFY OK (deploy exact collector, no cloud state)");
