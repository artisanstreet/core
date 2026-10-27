// Ephemeral Ed25519 `cnf` keys + channel ids. One fresh keypair per grant
// (never stored); the public half rides inside the grant JWT, the secret
// signs the Noise transcript binding.

import { Data, Either, pipe, Schema } from "effect";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { b64uDecode, b64uEncode } from "../../vendor/relay/b64u.ts";

export interface CnfKeypair {
  sk: Uint8Array;
  pk: Uint8Array;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
}

/** Fresh ephemeral Ed25519 `cnf` key for one grant (never stored). */
export function newEphemeralCnf(): CnfKeypair {
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  return { sk, pk, jwk: { kty: "OKP", crv: "Ed25519", x: b64uEncode(pk) } };
}

/** Random channel id inside the Relay charset. */
export function newChannelId(): string {
  return `app-${b64uEncode(randomBytes(9))}`;
}

export class GrantJwtError extends Data.TaggedError("GrantJwtError")<{
  readonly reason: string;
}> {}

const GrantJtiPayload = Schema.Struct({
  jti: Schema.String.pipe(Schema.minLength(1)),
});

/**
 * Read the grant `jti` for Relay admission (verified server-side) as a
 * pure Either parse: shape-guarded segments, stdlib JSON+Schema decode,
 * no exceptions. Callers lift the left side into their typed failure.
 */
export const grant_jti = (jwt: string): Either.Either<string, GrantJwtError> => {
  const segment = jwt.split(".")[1];
  if (segment === undefined || segment.length === 0 || segment.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return Either.left(new GrantJwtError({ reason: "unreadable grant" }));
  }
  return pipe(
    Schema.decodeUnknownEither(Schema.parseJson(GrantJtiPayload))(new TextDecoder().decode(b64uDecode(segment))),
    Either.map((payload) => payload.jti),
    Either.mapLeft(() => new GrantJwtError({ reason: "unreadable grant" })),
  );
};
