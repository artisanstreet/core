// Vetted-primitive crypto only: WebCrypto SHA-256 / AES-GCM / Ed25519 /
// getRandomValues, constant-time comparison. No custom constructions.
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  const t = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer));
}

export interface MasterKey {
  readonly raw: Uint8Array;
  readonly isDevDefault: boolean;
}

const DEV_DEFAULT_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function loadMasterKey(env: Record<string, string | undefined>): MasterKey {
  const raw = env.CORE_MASTER_KEY;
  if (!raw) throw new Error("CORE_MASTER_KEY is not set");
  const bytes = base64urlDecode(raw);
  if (bytes.length !== 32) throw new Error("CORE_MASTER_KEY must be 32 bytes base64url");
  const isDevDefault = raw === DEV_DEFAULT_B64;
  if (env.CORE_ENV === "production" && isDevDefault) {
    throw new Error("refusing dev default CORE_MASTER_KEY in production");
  }
  return { raw: bytes, isDevDefault };
}

// Envelope: nonce(12) || ciphertext. Associated data binds a purpose string.
export async function encryptWithKey(
  key: Uint8Array,
  plaintext: Uint8Array,
  purpose: string,
): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const k = await crypto.subtle.importKey("raw", key.buffer as ArrayBuffer, "AES-GCM", false, [
    "encrypt",
  ]);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer, additionalData: new TextEncoder().encode(purpose) },
    k,
    plaintext.buffer as ArrayBuffer,
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

export async function decryptWithKey(
  key: Uint8Array,
  envelope: Uint8Array,
  purpose: string,
): Promise<Uint8Array> {
  if (envelope.length < 12 + 16) throw new Error("ciphertext too short");
  const nonce = envelope.slice(0, 12);
  const ct = envelope.slice(12);
  const k = await crypto.subtle.importKey("raw", key.buffer as ArrayBuffer, "AES-GCM", false, [
    "decrypt",
  ]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer, additionalData: new TextEncoder().encode(purpose) },
    k,
    ct.buffer as ArrayBuffer,
  );
  return new Uint8Array(pt);
}
