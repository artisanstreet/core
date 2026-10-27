// Forge tunnel application framing.
//
// Authoritative shape: editor/crates/artisan-api/src/tunnel.rs —
// `TunnelRequest { id, method, path, body? }` and
// `TunnelResponse { id, status, body }` as JSON inside an open Noise data
// channel. Relay sees only opaque bodies. This file mirrors that envelope
// (unary JSON calls; SSE event streams are NOT tunneled — relay-mode
// Editors poll) plus the small subset of Forge DTOs this UI reads.
// Unknown Forge fields are ignored on receipt so additive Rust changes
// never break this client; requests are validated before sending.
//
// Status: the envelope exists in the Rust tree (`tunnel.rs`). Whether a
// reachable Forge build actually serves HTTP-over-tunnel on its relay
// link is owned by the Rust integration author (Vilde); until that lands,
// this client talks to the same shapes via direct Forge HTTP in local
// development and via the tunnel against fixture peers in tests. The UI
// reports which transport a Forge view is actually using.

// Forge tunnel application framing.
//
// Authoritative shape: editor/crates/artisan-api/src/tunnel.rs plus the
// published wire doc editor/docs/plans/ast-account-wire.md (v1: unary JSON
// calls + $bytes bodies + chunked transfers + polling; SSE is NOT tunneled).
// Relay sees only opaque bodies.
//
// Codec rules mirror the Rust side: requests encode STRICT (unknown fields
// rejected — here via Effect Schema, the same library the Core contracts
// use), responses decode forward-compatibly (unknown fields ignored).
// Chunking: Noise plaintext cap is 60_000 bytes per frame. Bodies above it
// arrive as TunnelChunk frames reassembled by transfer id; oversize past
// 32 MiB is an explicit error, never silent truncation.

import { Schema } from "effect";

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
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== 1 || keys[0] !== BYTES_ENVELOPE_KEY) return null;
  try {
    return Schema.decodeUnknownSync(TunnelBytes)(b[BYTES_ENVELOPE_KEY]);
  } catch {
    return null;
  }
}

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
/** Raw bytes per chunk we SEND: 40 KiB base64url-framed stays under the
 *  60 KiB Noise plaintext cap with room for JSON framing, whatever the
 *  Rust sender's final constant is. Receivers accept any sane part size. */
export const CHUNK_SEND_RAW_BYTES = 40 * 1024;
/** Largest single JSON frame we will emit without chunking. */
export const SINGLE_FRAME_BYTES = 59_000;

const strictEncode = { onExcessProperty: "error" } as const;

/** Encode a tunnel request strictly; unknown fields are rejected. */
export function encodeTunnelRequest(req: TunnelRequest): string {
  const encoded = Schema.encodeUnknownSync(TunnelRequest, strictEncode)(req);
  return JSON.stringify(encoded);
}

/** Decode a tunnel response forward-compatibly (unknown fields ignored). */
export function decodeTunnelResponse(input: unknown): TunnelResponse {
  return Schema.decodeUnknownSync(TunnelResponse)(input);
}

/** True when an app-plaintext frame is a transfer chunk, not a response. */
export function isChunkFrame(input: unknown): input is TunnelChunk {
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
export function chunkBytes(transfer: string, bytes: Uint8Array): TunnelChunk[] {
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
    out.push({ transfer, index: i, total, total_bytes: bytes.length, bytes_b64u: base64urlEncode(part) });
  }
  return out;
}

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

/**
 * Incremental chunk reassembly for one direction. Parts must arrive in
 * Noise order (guaranteed); any gap, mismatch, or oversize destroys the
 * transfer with an explicit error. One transfer per instance; the caller
 * keys instances by `transfer`.
 */
export class ChunkReassembly {
  private index = 0;
  private total: number | null = null;
  private totalBytes: number | null = null;
  private parts: Uint8Array[] = [];
  private received = 0;

  feed(frame: TunnelChunk): { done: false } | { done: true; bytes: Uint8Array } {
    if (frame.total_bytes > TRANSFER_MAX_BYTES) {
      throw new Error(`Transfer declares ${frame.total_bytes} bytes, past the 32 MiB ceiling; refusing instead of truncating.`);
    }
    if (this.total === null) {
      this.total = frame.total;
      this.totalBytes = frame.total_bytes;
    } else {
      if (frame.total !== this.total || frame.total_bytes !== this.totalBytes) {
        throw new Error("Chunk transfer changed shape mid-stream; discarding.");
      }
    }
    if (frame.index !== this.index) throw new Error(`Chunk ${frame.index} arrived out of order (want ${this.index}); discarding transfer.`);
    const raw = base64urlDecode(frame.bytes_b64u);
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
      if (out.length !== (this.totalBytes ?? -1)) throw new Error("Reassembled length does not match total_bytes; discarding.");
      return { done: true, bytes: out };
    }
    return { done: false };
  }
}

// -- Live event streams (wire doc §6) --------------------------------------
// SUBSCRIBE opens a dedicated channel with its own Noise session; the Forge
// answers {"$stream": {"stream": id}}, then emits one DATA frame per
// envelope: {"$event": {"stream": id, "envelope": {...}}} (oversized
// envelopes chunked per §4). End: {"$event": {"stream": id, "end": reason}}.
// UNSUBSCRIBE ends one stream without closing the channel. Receivers ignore
// unknown envelope fields; Reset envelopes trigger re-subscribe from the
// last seen seq.

export const StreamStart = Schema.Struct({
  $stream: Schema.Struct({ stream: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)) }),
});
export type StreamStart = typeof StreamStart.Type;

export const StreamEvent = Schema.Struct({
  $event: Schema.Struct({
    stream: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
    envelope: Schema.optional(Schema.Unknown),
    end: Schema.optional(Schema.String),
  }),
});
export type StreamEvent = typeof StreamEvent.Type;

export function asStreamStart(input: unknown): StreamStart | null {
  if (typeof input !== "object" || input === null) return null;
  if (!("$stream" in input)) return null;
  try {
    return Schema.decodeUnknownSync(StreamStart)(input);
  } catch {
    return null;
  }
}

export function asStreamEvent(input: unknown): StreamEvent | null {
  if (typeof input !== "object" || input === null) return null;
  if (!("$event" in input)) return null;
  try {
    return Schema.decodeUnknownSync(StreamEvent)(input);
  } catch {
    return null;
  }
}

/** Minimal SSE envelope shape the live feed consumes (tolerant reads). */
export interface LiveEnvelope {
  seq: number | null;
  type: string;
  event: Record<string, unknown>;
}

export function asLiveEnvelope(input: unknown): LiveEnvelope | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : null;
  if (!type) return null;
  const seq = typeof o.seq === "number" && Number.isInteger(o.seq) && o.seq >= 0 ? o.seq : null;
  return { seq, type, event: o };
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

// -- Forge DTO subset (editor/crates/artisan-api/src/request.rs) ------------
// Lenient: every field optional at the boundary; pages check what they show.

export interface ForgeThread {
  id: string;
  project_id?: string;
  title?: string | null;
  archived?: boolean;
  activity_seq?: number;
}

export interface ForgeThreadsPage {
  threads: ForgeThread[];
  next?: { activity_seq: number; id: string } | null;
  newer?: boolean;
}

export interface ForgeItem {
  id: string;
  thread_id?: string;
  position?: number;
  kind?: unknown;
}

export interface ForgeItemsPage {
  items: ForgeItem[];
  more: boolean;
}

export function asThreadsPage(body: unknown): ForgeThreadsPage {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const threads = Array.isArray(b.threads)
    ? (b.threads as Array<Record<string, unknown>>)
        .filter((t) => typeof t?.id === "string")
        .map((t) => ({
          id: t.id as string,
          project_id: typeof t.project_id === "string" ? t.project_id : undefined,
          title: typeof t.title === "string" ? t.title : null,
          archived: typeof t.archived === "boolean" ? t.archived : undefined,
          activity_seq: typeof t.activity_seq === "number" ? t.activity_seq : undefined,
        }))
    : [];
  return { threads, next: null, newer: false };
}

export function asItemsPage(body: unknown): ForgeItemsPage {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const items = Array.isArray(b.items)
    ? (b.items as Array<Record<string, unknown>>)
        .filter((i) => typeof i?.id === "string")
        .map((i) => ({ id: i.id as string, thread_id: typeof i.thread_id === "string" ? i.thread_id : undefined, position: typeof i.position === "number" ? i.position : undefined, kind: i.kind }))
    : [];
  return { items, more: b.more === true };
}

export interface ForgeState {
  forge_version?: string;
  protocol?: number;
  projects?: Array<{ id: string; name?: string | null; path?: string }>;
  threads?: ForgeThread[];
  head?: number;
}

/** One-line summary of an item's kind for the transcript list. */
export function itemSummary(item: ForgeItem): { kind: string; text: string } {
  const kind = item.kind;
  if (typeof kind === "string") return { kind, text: "" };
  if (typeof kind === "object" && kind !== null) {
    const k = kind as Record<string, unknown>;
    const tag = tagOf(k);
    const text = firstText(k);
    return { kind: tag, text };
  }
  return { kind: "item", text: "" };
}

function tagOf(k: Record<string, unknown>): string {
  // Serde-tagged enums arrive as {type: "...", ...} or {Variant: {...}}.
  if (typeof k.type === "string") return k.type;
  const keys = Object.keys(k);
  if (keys.length === 1 && typeof keys[0] === "string") return keys[0] as string;
  if (typeof k.kind === "string") return k.kind;
  return "item";
}

/**
 * Forge `TextContent`: untagged inline string or a stored-source ref
 * (content.rs). Stored sources need an explicit /content range load;
 * this returns the inline text, or null for stored refs AND for any other
 * shape. It deliberately does NOT dig into arbitrary objects: item kinds
 * carry their own `type` tag, which must never render as body text.
 */
export function textOf(tc: unknown): string | null {
  if (typeof tc === "string") return tc;
  if (typeof tc === "object" && tc !== null) {
    const o = tc as Record<string, unknown>;
    // Stored refs have an id + byte count; never render the id as text.
    if (typeof o.id === "string" && (typeof o.bytes === "number" || typeof o.content === "string")) return null;
  }
  return null;
}

export interface PendingApproval {
  request: unknown;
  reason: string | null;
  options: string[];
}

/** A tool/plan approval still waiting on the user (`decision: null`). */
export function pendingApproval(kind: unknown): PendingApproval | null {
  if (typeof kind !== "object" || kind === null) return null;
  const k = kind as Record<string, unknown>;
  if (k.type !== "tool" && k.type !== "plan") return null;
  const approval = k.approval as Record<string, unknown> | null | undefined;
  if (typeof approval !== "object" || approval === null) return null;
  if (approval.decision !== null && approval.decision !== undefined) return null;
  const options = Array.isArray(approval.options) ? (approval.options as unknown[]).filter((o): o is string => typeof o === "string") : [];
  return { request: approval.request ?? null, reason: textOf(approval.reason), options };
}

export interface PendingQuestion {
  blocking: boolean;
  questions: Array<{ id: string; header: string | null; text: string | null; multiSelect: boolean; options: Array<{ id: string; label: string; description: string | null }> }>;
}

/** A question item with no answers yet. */
export function pendingQuestions(kind: unknown): PendingQuestion | null {
  if (typeof kind !== "object" || kind === null) return null;
  const k = kind as Record<string, unknown>;
  if (k.type !== "question") return null;
  if (k.answers !== null && k.answers !== undefined) return null;
  const list = inlineCollection(k.questions);
  if (!list) return null;
  return {
    blocking: k.blocking === true,
    questions: list
      .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null && typeof (q as Record<string, unknown>).id === "string")
      .map((q) => ({
        id: q.id as string,
        header: typeof q.header === "string" ? q.header : null,
        text: textOf(q.text),
        multiSelect: q.multi_select === true,
        options: inlineCollection(q.options)
          ?.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
          .map((o) => ({
            id: typeof o.id === "string" ? o.id : "",
            label: typeof o.label === "string" ? o.label : "",
            description: textOf(o.description),
          })) ?? [],
      })),
  };
}

/** Forge `Collection<T>`: untagged inline array or a stored ref. Inline only. */
function inlineCollection(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  return null;
}

/** `Answer` bodies for POST /items/{id}/answer (request.rs). */
export function approvalAnswer(decision: string): { type: string; decision: string } {
  return { type: "approval", decision };
}

export function questionAnswer(answers: Array<Array<string> | { text: string } | null>): { type: string; answers: unknown[] } {
  return {
    type: "question",
    answers: answers.map((a) => (a === null ? null : Array.isArray(a) ? { kind: "choices", ids: a } : { kind: "text", text: a.text })),
  };
}

/** `SendMessage` body for POST /threads/{id}/messages (request.rs). */
export function sendMessageBody(id: string, text: string): { id: string; text: string; images: string[] } {
  return { id, text, images: [] };
}

/** Best-effort text extraction for display; never throws, never invents.
 * `cap` bounds a single item (default 500 for summaries). Transcript
 * bodies pass a large cap: long threads must render whole, never silently
 * cut. When the cap hits, the caller must say so explicitly. */
export function firstText(value: unknown, depth = 0, cap = 500): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value.length > cap ? `${value.slice(0, cap)}…` : value;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 8)) {
      const t = firstText(v, depth + 1, cap);
      if (t) return t;
    }
    return "";
  }
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    for (const key of ["text", "body", "content", "message", "summary", "label"]) {
      const t = firstText(o[key], depth + 1, cap);
      if (typeof o[key] === "string" && t) return t;
    }
    for (const v of Object.values(o).slice(0, 12)) {
      const t = firstText(v, depth + 1, cap);
      if (t) return t;
    }
  }
  return "";
}

// -- Transcript extractor (contract-faithful, wire doc §5) ------------------
// Reads the actual Forge ItemKind shapes (editor/crates/artisan-api/src/
// item.rs: tagged `type` variants, TextContent inline-or-Stored,
// Collections inline-or-Stored) in defined order and preserves ALL text
// parts — no 8-item cap, no depth cap, no first-result shortcut. Unknown
// future variants fall back to the generic digger so additive Rust fields
// still show something. Summaries for lists keep using firstText.

/** Cap for rendered transcript bodies: whole threads, no silent cut. */
export const TRANSCRIPT_BODY_CAP = 2_000_000;

export interface StoredRef {
  id: string;
  bytes: number;
  label: string;
}

export interface TranscriptText {
  /** Complete text in defined order (may exceed the render cap). */
  text: string;
  /** Stored sources needing explicit /content range loads. */
  stored: StoredRef[];
  /** Notes about genuinely unavailable bytes (omitted server-side). */
  notices: string[];
}

function tcInto(tc: unknown, label: string, out: TranscriptText): void {
  if (typeof tc === "string") {
    out.text += tc;
    return;
  }
  if (typeof tc === "object" && tc !== null) {
    const o = tc as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.bytes === "number") {
      out.stored.push({ id: o.id, bytes: o.bytes, label });
      return;
    }
    // Unknown TextContent shape: show something rather than nothing.
    const fallback = firstText(tc);
    if (fallback) out.text += fallback;
  }
}

function collInto<T>(value: unknown, label: string, out: TranscriptText, each: (record: T, out: TranscriptText) => void): void {
  if (Array.isArray(value)) {
    for (const record of value) each(record as T, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    const src = o.source as Record<string, unknown> | undefined;
    if (src && typeof src.content === "string") {
      out.stored.push({ id: src.content, bytes: typeof o.count === "number" ? o.count : 0, label });
      return;
    }
    if (typeof o.count === "number") {
      out.notices.push(`${label}: ${o.count} stored records (not fetched in this view)`);
    }
  }
}

function approvalInto(approval: unknown, out: TranscriptText): void {
  if (typeof approval !== "object" || approval === null) return;
  const a = approval as Record<string, unknown>;
  if (typeof a.decision === "string") out.text += `\nDecision: ${a.decision}`;
  if (Array.isArray(a.options)) out.text += `\nOffered: ${(a.options as unknown[]).map(String).join(", ")}`;
}

function toolInto(tool: unknown, out: TranscriptText): void {
  if (typeof tool !== "object" || tool === null) return;
  const t = tool as Record<string, unknown>;
  const kind = typeof t.kind === "string" ? t.kind : "";
  switch (kind) {
    case "agent_message": {
      tcInto((t.text as Record<string, unknown> | undefined), "message", out);
      if (typeof t.recipient === "string") out.text += `\nTo: ${t.recipient}`;
      break;
    }
    case "shell": {
      tcInto(t.command, "command", out);
      if (typeof t.cwd === "string" && t.cwd) out.text += `\nIn ${t.cwd}`;
      break;
    }
    case "read": {
      if (typeof t.path === "string") out.text += t.path;
      if (Array.isArray(t.range)) out.text += ` @${(t.range as unknown[]).map(String).join("..")}`;
      break;
    }
    case "edit": {
      collInto(t.changes, "edits", out, (ch: Record<string, unknown>, o2) => {
        if (typeof ch.path === "string") o2.text += `\n${ch.path} `;
        if (typeof ch.op === "string") o2.text += `(${ch.op})`;
        tcInto(ch.diff, "diff", o2);
      });
      break;
    }
    case "search": {
      if (typeof t.pattern === "string") out.text += t.pattern;
      if (typeof t.path === "string" && t.path) out.text += ` in ${t.path}`;
      break;
    }
    case "web_fetch": {
      if (typeof t.url === "string") out.text += t.url;
      break;
    }
    case "web_search": {
      if (typeof t.query === "string") out.text += t.query;
      break;
    }
    case "mcp": {
      if (typeof t.server === "string") out.text += `${t.server}.`;
      if (typeof t.tool === "string") out.text += t.tool;
      tcInto(t.input, "input", out);
      break;
    }
    case "view_image": {
      if (typeof t.path === "string") out.text += t.path;
      break;
    }
    default: {
      if (typeof t.name === "string") out.text += t.name;
      tcInto(t.input, "input", out);
      break;
    }
  }
}

/**
 * Full transcript text for one item kind, in the contract's defined order.
 * Every message part is preserved; nothing is capped here (rendering
 * caps with explicit Show-rest/download expansion instead).
 */
export function transcriptText(kind: unknown): TranscriptText {
  const out: TranscriptText = { text: "", stored: [], notices: [] };
  if (typeof kind !== "object" || kind === null) return out;
  const k = kind as Record<string, unknown>;
  const type = typeof k.type === "string" ? k.type : "";
  const push = (s: string) => {
    out.text += s;
  };
  switch (type) {
    case "user_message": {
      tcInto(k.text, "message", out);
      if (typeof k.sender === "object" && k.sender !== null) {
        const s = k.sender as Record<string, unknown>;
        if (typeof s.title === "string" && s.title) push(`\n— ${s.title}`);
      }
      break;
    }
    case "assistant_message": {
      tcInto(k.text, "reply", out);
      break;
    }
    case "tool": {
      if (typeof k.title === "string" && k.title) push(`${k.title}\n`);
      toolInto(k.tool, out);
      const output = k.output as Record<string, unknown> | null | undefined;
      if (output && typeof output === "object") {
        tcInto(output.text, "output", out);
        if (typeof output.omitted_bytes === "number" && output.omitted_bytes > 0) {
          out.notices.push(`${output.omitted_bytes} output bytes omitted server-side`);
        }
      }
      if (typeof k.exit_code === "number") push(`\nexit ${k.exit_code}`);
      approvalInto(k.approval, out);
      break;
    }
    case "agent": {
      if (typeof k.label === "string" && k.label) push(`${k.label}\n`);
      else if (typeof k.name === "string" && k.name) push(`${k.name}\n`);
      tcInto(k.description, "task", out);
      tcInto(k.prompt, "prompt", out);
      tcInto(k.result, "result", out);
      if (typeof k.model === "string" && k.model) push(`\nModel: ${k.model}`);
      break;
    }
    case "question": {
      if (k.blocking) push("[blocking]\n");
      collInto(k.questions, "questions", out, (q: Record<string, unknown>, o2) => {
        if (typeof q.header === "string" && q.header) o2.text += `\n${q.header}\n`;
        tcInto(q.text, "question", o2);
        collInto(q.options, "options", out, (o: Record<string, unknown>, o3) => {
          if (typeof o.label === "string") o3.text += `\n- ${o.label}`;
          tcInto(o.description, "option", o3);
        });
      });
      const answers = k.answers;
      if (Array.isArray(answers)) {
        answers.forEach((a: unknown, i: number) => {
          if (a === null || a === undefined) return;
          const r = a as Record<string, unknown>;
          if (r.kind === "text" && typeof r.text === "string") out.text += `\nAnswer ${i + 1}: ${r.text}`;
          else if (r.kind === "choices" && Array.isArray(r.ids)) out.text += `\nAnswer ${i + 1}: ${(r.ids as unknown[]).map(String).join(", ")}`;
        });
      }
      tcInto(k.answer_text, "answers", out);
      break;
    }
    case "plan": {
      collInto(k.steps, "steps", out, (s: Record<string, unknown>, o2) => {
        tcInto(s.text, "step", o2);
        if (typeof s.status === "string") o2.text += ` [${s.status}]`;
        o2.text += "\n";
      });
      tcInto(k.proposal, "proposal", out);
      approvalInto(k.approval, out);
      break;
    }
    case "image": {
      tcInto(k.caption, "caption", out);
      break;
    }
    case "compaction": {
      tcInto(k.summary, "summary", out);
      const sw = k.switch as Record<string, unknown> | undefined;
      if (sw && typeof sw === "object") {
        const from = sw.from as Record<string, unknown> | undefined;
        const to = sw.to as Record<string, unknown> | undefined;
        const name = (m: Record<string, unknown> | undefined) => (typeof m?.name === "string" ? m.name : "?");
        out.text += `\nModel switch: ${name(from)} → ${name(to)}`;
      }
      break;
    }
    case "notice": {
      tcInto(k.text, "notice", out);
      break;
    }
    case "error": {
      tcInto(k.message, "error", out);
      break;
    }
    default: {
      const fallback = firstText(k);
      if (fallback) out.text += fallback;
      break;
    }
  }
  return out;
}

/** Random caller-made id for tunnel requests (not a secret). */
export function newRequestId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
