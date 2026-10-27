import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { bucket_name } from "./config.ts";

// R2 bucket for Core config blobs (content-addressed, re-publishable).
// Stage-aware physical name; forceDestroy stays false (data safety:
// non-empty bucket destroy fails instead of emptying).
export const ConfigBucket = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  return yield* Cloudflare.R2.Bucket("ConfigBucket", {
    name: bucket_name(stage) });
});
