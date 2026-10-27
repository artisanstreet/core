import { base64urlnopad as base64url_nopad } from "@scure/base";
import { sha256 as noble_sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as bytes_to_hex, randomBytes as noble_random_bytes, utf8ToBytes as utf8_to_bytes } from "@noble/hashes/utils.js";
import { gcm as noble_gcm } from "@noble/ciphers/aes.js";
import { equalBytes as equal_bytes } from "@noble/ciphers/utils.js";

export { randomBytes as random_bytes } from "@noble/hashes/utils.js";

export const base64url_encode = base64url_nopad.encode;
export const base64url_decode = base64url_nopad.decode;

export function constant_time_equal(a: string, b: string): boolean {
  return equal_bytes(utf8_to_bytes(a), utf8_to_bytes(b));
}

export function sha256_hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? utf8_to_bytes(data) : data;
  return bytes_to_hex(noble_sha256(bytes));
}

export function sha256_bytes(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? utf8_to_bytes(data) : data;
  return noble_sha256(bytes);
}

export interface MasterKey {
  readonly raw: Uint8Array;
  readonly is_dev_default: boolean;
}

const DEV_DEFAULT_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function load_master_key(env: Record<string, string | undefined>): MasterKey {
  const raw = env.CORE_MASTER_KEY;
  if (!raw) throw new Error("CORE_MASTER_KEY is not set");
  const bytes = base64url_decode(raw);
  if (bytes.length !== 32) throw new Error("CORE_MASTER_KEY must be 32 bytes base64url");
  const is_dev_default = raw === DEV_DEFAULT_B64;
  if (env.CORE_ENV === "production" && is_dev_default) {
    throw new Error("refusing dev default CORE_MASTER_KEY in production");
  }
  return { raw: bytes, is_dev_default };
}

// Envelope: nonce(12) || ciphertext+tag(16). AAD binds a purpose string.
export function encrypt_with_key(
  key: Uint8Array,
  plaintext: Uint8Array,
  purpose: string,
): Uint8Array {
  if (key.length !== 32) throw new Error("key must be 32 bytes (AES-256)");
  const nonce = noble_random_bytes(12);
  const cipher = noble_gcm(key, nonce, utf8_to_bytes(purpose));
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 12);
  return out;
}

export function decrypt_with_key(
  key: Uint8Array,
  envelope: Uint8Array,
  purpose: string,
): Uint8Array {
  if (key.length !== 32) throw new Error("key must be 32 bytes (AES-256)");
  if (envelope.length < 12 + 16) throw new Error("ciphertext too short");
  const nonce = envelope.subarray(0, 12);
  const ct = envelope.subarray(12);
  const cipher = noble_gcm(key, nonce, utf8_to_bytes(purpose));
  return cipher.decrypt(ct);
}
