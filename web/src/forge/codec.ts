// Tunnel request/response codec. Authoritative shape mirrors
// editor/crates/artisan-api/src/tunnel.rs (`TunnelRequest {id,method,path,
// body?}`, `TunnelResponse {id,status,body}`) plus wire-doc unary rules:
// requests encode STRICT (unknown fields rejected), responses decode
// forward-compatibly (unknown fields ignored). Relay sees opaque bodies.

import { Either, Schema } from "effect";

export const TunnelMethod = Schema.Literal("GET", "POST", "PUT", "PATCH", "DELETE", "SUBSCRIBE", "UNSUBSCRIBE");
export type TunnelMethod = typeof TunnelMethod.Type;

/** Origin-form path: starts with `/`, no scheme, no `..` segments. */
export const TunnelPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(2048),
  Schema.pattern(/^\/[^ ]*$/),
  Schema.filter((p) => !p.split("?")[0]!.split("/").includes(".."), {
    message: () => "tunnel path must not contain .. segments",
  }),
);

export const TunnelRequest = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  method: TunnelMethod,
  path: TunnelPath,
  body: Schema.optional(Schema.Unknown),
});
export type TunnelRequest = typeof TunnelRequest.Type;

export const TunnelResponse = Schema.Struct({
  id: Schema.String,
  status: Schema.Number.pipe(
    Schema.filter((n) => Number.isInteger(n) && n >= 100 && n <= 599, {
      message: () => "tunnel status must be an HTTP-style status",
    }),
  ),
  body: Schema.Unknown,
  content_type: Schema.optional(Schema.String),
});
export type TunnelResponse = typeof TunnelResponse.Type;

export const TunnelBytes = Schema.Struct({
  content_type: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  b64u: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]*$/)),
});
export type TunnelBytes = typeof TunnelBytes.Type;

export const BYTES_ENVELOPE_KEY = "$bytes";

/** A binary body inside request/response `body`: `{"$bytes": {...}}`. */
export function asTunnelBytes(body: unknown): TunnelBytes | null {
  if (typeof body !== "object" || body === null) return null;
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 1 || keys[0] !== BYTES_ENVELOPE_KEY) return null;
  return Either.getOrNull(Schema.decodeUnknownEither(TunnelBytes)(fields[BYTES_ENVELOPE_KEY]));
}

const B64U_RE = /^[A-Za-z0-9_-]*$/;

export function base64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  if (!B64U_RE.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const strict_encode = { onExcessProperty: "error" } as const;

/** Encode a tunnel request strictly; unknown fields are rejected. */
export function encodeTunnelRequest(req: TunnelRequest): string {
  const encoded = Schema.encodeUnknownSync(TunnelRequest, strict_encode)(req);
  return JSON.stringify(encoded);
}

/** Decode a tunnel response forward-compatibly (unknown fields ignored). */
export function decodeTunnelResponse(input: unknown): TunnelResponse {
  return Schema.decodeUnknownSync(TunnelResponse)(input);
}

export function throwIfTunnelError(res: TunnelResponse): TunnelResponse {
  if (res.status < 200 || res.status >= 300) {
    const msg =
      typeof res.body === "object" && res.body !== null && "error" in res.body
        ? String((res.body as { error: { message?: unknown } }).error?.message ?? `Forge answered ${res.status}`)
        : `Forge answered ${res.status}`;
    const err = new Error(msg);
    (err as { tunnelStatus?: number }).tunnelStatus = res.status;
    throw err;
  }
  return res;
}

/** Largest single JSON frame emitted without chunking. */
export const SINGLE_FRAME_BYTES = 59_000;

/** Random caller-made id for tunnel requests (not a secret). */
export function newRequestId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
