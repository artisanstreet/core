// Ephemeral Ed25519 `cnf` keys + channel ids. One fresh keypair per grant
// (never stored); the public half rides inside the grant JWT, the secret
// signs the Noise transcript binding.

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

/** Read the grant `jti` for Relay admission (verified server-side). */
export function grantJti(jwt: string): string {
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(jwt.split(".")[1] ?? ""))) as { jti?: unknown };
    if (typeof payload.jti === "string" && payload.jti.length > 0) return payload.jti;
  } catch {
    // fall through to the throw below
  }
  throw new Error("Unreadable grant: cannot admit to Relay.");
}
