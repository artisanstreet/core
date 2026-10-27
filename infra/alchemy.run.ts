import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { STACK_NAME } from "./src/config.ts";
import { ConfigBucket } from "./src/storage.ts";
import { CoreHyperdrive } from "./src/hyperdrive.ts";
import { make_core_worker } from "./src/worker.ts";

// Composition root — export default the Stack.
// Stack name is fixed (`ast-core`, distinct from Relay's `ast-relay`);
// stage comes from the Alchemy CLI (--stage / ALCHEMY_STAGE).
// State is Cloudflare-backed remote (account default `alchemy-state-store`),
// so all stages share one account backend with stage-consistent,
// stage-isolated state. No sibling source imports.
// Single declaration: bucket/hyperdrive yielded once here and passed to the
// Worker factory (no duplicate resource declarations).
export default Alchemy.Stack(
  STACK_NAME,
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stack = yield* Alchemy.Stack;
    const bucket = yield* ConfigBucket;
    const hd = yield* CoreHyperdrive;
    const worker = yield* make_core_worker({ bucket, hyperdrive: hd });

    // Useful public outputs only. No secret outputs.
    return {
      url: worker.url,
      urls: worker.urls,
      workerName: worker.workerName,
      bucketName: bucket.bucketName,
      hyperdriveId: hd.hyperdriveId,
      stage: stack.stage,
    };
  }),
);
