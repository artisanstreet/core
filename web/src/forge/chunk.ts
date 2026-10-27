// Chunked transfers for oversized tunnel frames. Noise plaintext caps at
// 60_000 bytes per frame, so bodies above it arrive as `TunnelChunk`
// frames reassembled by transfer id. Oversize past 32 MiB is an explicit
// error, never silent truncation.

import { Schema } from "effect";
import { base64urlnopad as base64url_nopad } from "@scure/base";

const B64U_RE = /^[A-Za-z0-9_-]*$/;

export const TunnelChunk = Schema.Struct({
  transfer: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  index: Schema.Int.pipe(Schema.filter((n) => n >= 0, { message: () => "chunk index must be >= 0" })),
  total: Schema.Int.pipe(Schema.filter((n) => n >= 1, { message: () => "chunk total must be >= 1" })),
  total_bytes: Schema.Int.pipe(Schema.filter((n) => n >= 0, { message: () => "chunk total_bytes must be >= 0" })),
  bytes_b64u: Schema.String.pipe(Schema.pattern(B64U_RE)),
});
export type TunnelChunk = typeof TunnelChunk.Type;

/** 32 MiB of raw bytes per transfer (matches Forge blob/source ceilings). */
export const TRANSFER_MAX_BYTES = 32 * 1024 * 1024;
/** Raw bytes per chunk SENT: 40 KiB base64url-framed stays under the
 *  60 KiB Noise plaintext cap with room for JSON framing. Receivers accept
 *  any sane part size. */
export const CHUNK_SEND_RAW_BYTES = 40 * 1024;

/** True when an app-plaintext frame is a transfer chunk, not a response. */
export function is_chunk_frame(input: unknown): input is TunnelChunk {
  if (typeof input !== "object" || input === null) return false;
  const o = input as Record<string, unknown>;
  return (
    typeof o.transfer === "string" &&
    typeof o.bytes_b64u === "string" &&
    typeof o.index === "number" &&
    typeof o.total === "number"
  );
}

/** Split bytes into chunk frames for one transfer (receiver-agnostic). */
export function chunk_bytes(transfer: string, bytes: Uint8Array): TunnelChunk[] {
  if (bytes.length > TRANSFER_MAX_BYTES) {
    throw new Error(`Transfer of ${bytes.length} bytes exceeds the 32 MiB ceiling; refusing instead of truncating.`);
  }
  if (bytes.length === 0) {
    return [{ transfer, index: 0, total: 1, total_bytes: 0, bytes_b64u: "" }];
  }
  const total = Math.ceil(bytes.length / CHUNK_SEND_RAW_BYTES);
  const out: TunnelChunk[] = [];
  for (let i = 0; i < total; i++) {
    const part = bytes.subarray(i * CHUNK_SEND_RAW_BYTES, (i + 1) * CHUNK_SEND_RAW_BYTES);
    out.push({ transfer, index: i, total, total_bytes: bytes.length, bytes_b64u: base64url_nopad.encode(part) });
  }
  return out;
}

/**
 * Incremental chunk reassembly for one direction. Parts must arrive in
 * Noise order (guaranteed); any gap, mismatch, or oversize destroys the
 * transfer with an explicit error. One transfer per instance; the caller
 * keys instances by `transfer`.
 */
export class ChunkReassembly {
  private index = 0;
  private total: number | null = null;
  private total_bytes: number | null = null;
  private parts: Uint8Array[] = [];
  private received = 0;

  feed(frame: TunnelChunk): { done: false } | { done: true; bytes: Uint8Array } {
    if (frame.total_bytes > TRANSFER_MAX_BYTES) {
      throw new Error(`Transfer declares ${frame.total_bytes} bytes, past the 32 MiB ceiling; refusing instead of truncating.`);
    }
    if (this.total === null) {
      this.total = frame.total;
      this.total_bytes = frame.total_bytes;
    } else {
      if (frame.total !== this.total || frame.total_bytes !== this.total_bytes) {
        throw new Error("Chunk transfer changed shape mid-stream; discarding.");
      }
    }
    if (frame.index !== this.index) throw new Error(`Chunk ${frame.index} arrived out of order (want ${this.index}); discarding transfer.`);
    const raw = base64url_nopad.decode(frame.bytes_b64u);
    this.received += raw.length;
    if (this.received > TRANSFER_MAX_BYTES) throw new Error("Transfer exceeds the 32 MiB ceiling; discarding.");
    // Copy: the Noise layer may alias and later zero handshake-adjacent
    // buffers; reassembled parts must be immune to caller-side mutation.
    this.parts.push(Uint8Array.from(raw));
    this.index++;
    if (this.index === this.total) {
      const out = new Uint8Array(this.received);
      let o = 0;
      for (const p of this.parts) {
        out.set(p, o);
        o += p.length;
      }
      if (out.length !== (this.total_bytes ?? -1)) throw new Error("Reassembled length does not match total_bytes; discarding.");
      return { done: true, bytes: out };
    }
    return { done: false };
  }
}
