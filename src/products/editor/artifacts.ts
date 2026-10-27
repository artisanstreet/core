import { Effect, Either, Schema } from "effect";
import { base64urlDecode, sha256Hex } from "../../crypto.ts";
import { badRequest } from "../../errors.ts";
import { EngineArtifactEnvelope } from "../../contracts/v1.ts";

const MAX_ENVELOPE_BYTES = 262144;

// Editor product: engine credential artifact envelope rules.
//
// Opaque envelopes exported by Forge AFTER the user completed the harness's
// own local login (subscription or key). Core performs NO OAuth for
// engines: this layer validates the envelope SHAPE, and the generic vault
// (services/vault.ts) encrypts it at rest and releases it only to assigned
// live machines of the same account, where Forge imports the files.
//
// Verified local adapters (per forge-engines SignIn): claude (claude.ai
// subscription/API), codex (ChatGPT device flow), opencode (console/key).
// Unverified engines are rejected: kind/engine are closed enums.
// Inner file bytes stay opaque to Core (never parsed, never logged).

export type ValidatedEnvelope = typeof EngineArtifactEnvelope.Type;

export const validateEnvelope = (input: unknown) =>
  Effect.gen(function* () {
    const env = yield* Schema.decodeUnknown(EngineArtifactEnvelope, { onExcessProperty: "error" })(input).pipe(
      Effect.mapError(() => badRequest("invalid artifact envelope")),
    );
    if (env.files.length > 8) return yield* Effect.fail(badRequest("too many files"));
    let total = 0;
    for (const f of env.files) {
      if (f.path.length === 0 || f.path.length > 256 || f.path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(f.path)) {
        return yield* Effect.fail(badRequest("invalid artifact path"));
      }
      const decoded = Either.try(() => base64urlDecode(f.contentBase64));
      if (Either.isLeft(decoded)) return yield* Effect.fail(badRequest("invalid artifact encoding"));
      const bytes = decoded.right;
      total += bytes.length;
      if (total > MAX_ENVELOPE_BYTES) return yield* Effect.fail(badRequest("envelope too large"));
      const digest = yield* Effect.promise(() => sha256Hex(bytes));
      if (digest !== f.sha256) return yield* Effect.fail(badRequest("artifact hash mismatch"));
    }
    if (env.note && env.note.length > 280) return yield* Effect.fail(badRequest("note too long"));
    return env;
  });
