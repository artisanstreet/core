import { describe, expect, it } from "vitest";
import {
  base64url_decode,
  base64url_encode,
  decrypt_with_key,
  encrypt_with_key,
  random_bytes,
  sha256_bytes,
  sha256_hex,
} from "../src/crypto.ts";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("vetted crypto primitives", () => {
  it("sha256 matches known vectors and respects subarray views", () => {
    expect(sha256_hex("abc")).toBe(ABC_SHA256);
    expect(sha256_hex(new Uint8Array([]))).toBe(EMPTY_SHA256);
    // Subarray view with a nonzero offset must hash only its bytes,
    // not the whole backing buffer (old .buffer bug).
    const big = new Uint8Array([0x00, 0x61, 0x62, 0x63, 0x00]);
    const sub = big.subarray(1, 4);
    expect(sha256_hex(sub)).toBe(ABC_SHA256);
    const sub_bytes = sha256_bytes(sub);
    const fresh = new Uint8Array([0x61, 0x62, 0x63]);
    expect(sha256_hex(fresh)).toBe(ABC_SHA256);
    expect(Array.from(sub_bytes)).toEqual(Array.from(sha256_bytes(fresh)));
  });

  it("base64url roundtrips binary and rejects non-canonical inputs", () => {
    const original = random_bytes(64);
    const encoded = base64url_encode(original);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(Array.from(base64url_decode(encoded))).toEqual(Array.from(original));
    expect(base64url_encode(new Uint8Array([]))).toBe("");
    expect(base64url_decode("").length).toBe(0);
    expect(() => base64url_decode("A")).toThrow();
    expect(() => base64url_decode("====")).toThrow();
    expect(() => base64url_decode("ab+c")).toThrow();
    expect(() => base64url_decode("ab/c")).toThrow();
    expect(() => base64url_decode("ab==")).toThrow();
    expect(() => base64url_decode("ab c")).toThrow();
    expect(() => base64url_decode("ab\nc")).toThrow();
  });

  it("aead envelope is nonce12 || ct+tag16 with purpose aad and fresh csprng", () => {
    const key = random_bytes(32);
    const plaintext = new TextEncoder().encode("vault secret bytes");
    const purpose = "provider-secret v1";
    const first = encrypt_with_key(key, plaintext, purpose);
    const second = encrypt_with_key(key, plaintext, purpose);
    expect(first.length).toBe(12 + plaintext.length + 16);
    expect(second.length).toBe(12 + plaintext.length + 16);
    expect(Array.from(first)).not.toEqual(Array.from(second));
    expect(Array.from(decrypt_with_key(key, first, purpose))).toEqual(Array.from(plaintext));
    expect(() => decrypt_with_key(key, first, "engine-artifact v1")).toThrow();
    const tampered = new Uint8Array(first);
    tampered[20]! ^= 0xff;
    expect(() => decrypt_with_key(key, tampered, purpose)).toThrow();
    expect(() => decrypt_with_key(key, first.subarray(0, 12 + 15), purpose)).toThrow();
    expect(() => encrypt_with_key(random_bytes(16), plaintext, purpose)).toThrow();
  });

  it("aead interops with platform webcrypto (persisted byte compat)", async () => {
    const key = random_bytes(32);
    const purpose = "engine-artifact v1";
    const plaintext = new TextEncoder().encode("persisted envelope bytes");
    const purpose_bytes = new TextEncoder().encode(purpose);

    const noble_envelope = encrypt_with_key(key, plaintext, purpose);
    const noble_nonce = noble_envelope.subarray(0, 12);
    const noble_ct = noble_envelope.subarray(12);
    const web_key = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
    const web_plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(noble_nonce), additionalData: purpose_bytes },
      web_key,
      new Uint8Array(noble_ct),
    );
    expect(Array.from(new Uint8Array(web_plaintext))).toEqual(Array.from(plaintext));

    const web_nonce = random_bytes(12);
    const web_ct_buf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(web_nonce), additionalData: purpose_bytes },
      web_key,
      plaintext,
    );
    const web_ct = new Uint8Array(web_ct_buf);
    const web_envelope = new Uint8Array(12 + web_ct.length);
    web_envelope.set(web_nonce, 0);
    web_envelope.set(web_ct, 12);
    expect(Array.from(decrypt_with_key(key, web_envelope, purpose))).toEqual(Array.from(plaintext));
  });
});
