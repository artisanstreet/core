import { Context, Effect, Layer } from "effect";
import { internal } from "../errors.ts";
import type { R2Like } from "../db.ts";

export class StorageTag extends Context.Tag("Storage")<StorageTag, { readonly r2: R2Like }>() {}

// R2 in production (binding injected by the Worker entry), in-memory in
// tests and local dev without R2. Manifests are content-addressed blobs.
export const memoryR2 = (): { r2: R2Like; layer: Layer.Layer<StorageTag> } => {
  const store = new Map<string, Uint8Array>();
  const r2: R2Like = {
    put: (key, body) =>
      Promise.resolve(void store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)),
    get: (key) => Promise.resolve(store.get(key) ?? null),
  };
  return { r2, layer: Layer.succeed(StorageTag, { r2 }) };
};

export function putBlob(key: string, body: Uint8Array | string) {
  return Effect.gen(function* () {
    const { r2 } = yield* StorageTag;
    yield* Effect.tryPromise({
      try: () => r2.put(key, body),
      catch: () => internal("storage unavailable"),
    });
  });
}

export function getBlob(key: string) {
  return Effect.gen(function* () {
    const { r2 } = yield* StorageTag;
    return yield* Effect.tryPromise({
      try: () => r2.get(key),
      catch: () => internal("storage unavailable"),
    });
  });
}
