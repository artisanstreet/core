// Tunnel codec: strict requests, lenient responses, $bytes bodies,
// chunked transfers (the >60 KiB path long transcripts need), and the
// exact answer shapes the Forge expects.

import { describe, expect, it } from "vitest";
import { base64urlnopad as base64url_nopad } from "@scure/base";
import {
  approval_answer,
  as_items_page,
  as_live_envelope,
  as_stream_event,
  as_stream_start,
  as_threads_page,
  as_tunnel_bytes,
  BYTES_ENVELOPE_KEY,
  ChunkReassembly,
  chunk_bytes,
  decode_tunnel_response,
  encode_tunnel_request,
  first_text,
  is_chunk_frame,
  pending_approval,
  pending_questions,
  question_answer,
  send_message_body,
  SINGLE_FRAME_BYTES,
  text_of,
  throw_if_tunnel_error,
  TRANSFER_MAX_BYTES,
} from "../src/forge.ts";

describe("request codec (strict)", () => {
  it("encodes a minimal GET", () => {
    const json = encode_tunnel_request({ id: "r1", method: "GET", path: "/state" });
    expect(JSON.parse(json)).toEqual({ id: "r1", method: "GET", path: "/state" });
  });

  it("rejects unknown fields", () => {
    expect(() => encode_tunnel_request({ id: "r1", method: "GET", path: "/state", bogus: 1 } as never)).toThrow();
  });

  it("rejects non-origin paths, .. segments, and bad methods", () => {
    expect(() => encode_tunnel_request({ id: "r1", method: "GET", path: "https://x/state" })).toThrow();
    expect(() => encode_tunnel_request({ id: "r1", method: "GET", path: "/a/../b" })).toThrow();
    expect(() => encode_tunnel_request({ id: "r1", method: "FETCH" as never, path: "/state" })).toThrow();
    expect(() => encode_tunnel_request({ id: "", method: "GET", path: "/state" })).toThrow();
  });

  it("keeps query strings on paths", () => {
    const json = encode_tunnel_request({ id: "r1", method: "GET", path: "/threads/abc/transcript?after=5&limit=100" });
    expect(JSON.parse(json).path).toContain("after=5");
  });
});

describe("response codec (forward-compatible)", () => {
  it("ignores additive fields and keeps content_type", () => {
    const res = decode_tunnel_response({ id: "r1", status: 200, body: { items: [] }, content_type: "application/json", added_later: 1 });
    expect(res.status).toBe(200);
    expect(res.content_type).toBe("application/json");
  });

  it("rejects malformed responses", () => {
    expect(() => decode_tunnel_response({ id: "r1", status: 99, body: null })).toThrow();
    expect(() => decode_tunnel_response({ status: 200, body: null })).toThrow();
  });

  it("throw_if_tunnel_error surfaces Forge messages with status", () => {
    const err = (() => {
      try {
        throw_if_tunnel_error(decode_tunnel_response({ id: "r1", status: 404, body: { error: { code: "not_found", message: "nope" } } }));
        return null;
      } catch (e) {
        return e as Error & { tunnel_status?: number };
      }
    })();
    expect(err?.tunnel_status).toBe(404);
    expect(err?.message).toBe("nope");
  });
});

describe("$bytes envelope", () => {
  it("detects the single-key envelope and rejects lookalikes", () => {
    const body = { [BYTES_ENVELOPE_KEY]: { content_type: "image/webp", b64u: "a_gk" } };
    expect(as_tunnel_bytes(body)?.content_type).toBe("image/webp");
    expect(as_tunnel_bytes({ [BYTES_ENVELOPE_KEY]: { content_type: "image/webp" }, other: 1 })).toBeNull();
    expect(as_tunnel_bytes({ items: [] })).toBeNull();
  });

  it("round-trips binary through base64url", () => {
    const raw = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64url_nopad.decode(base64url_nopad.encode(raw))).toEqual(raw);
  });

  it("preserves empty blobs and canonical url encoding", () => {
    expect(base64url_nopad.encode(new Uint8Array([]))).toBe("");
    expect(base64url_nopad.decode("")).toEqual(new Uint8Array([]));
    const raw = new Uint8Array([0, 1, 2, 250, 255]);
    const enc = base64url_nopad.encode(raw);
    expect(enc).not.toContain("+");
    expect(enc).not.toContain("/");
    expect(enc).not.toContain("=");
    expect(enc).toBe(Buffer.from(raw).toString("base64url"));
  });

  it("rejects non-canonical inputs", () => {
    expect(() => base64url_nopad.decode("a")).toThrow();
    expect(() => base64url_nopad.decode("!!!")).toThrow();
    expect(() => base64url_nopad.decode("Eqs=")).toThrow();
  });

  it("handles subarray views without copying the whole buffer", () => {
    const big = new Uint8Array([9, 9, 0, 1, 2, 250, 255, 8, 8]);
    const view = big.subarray(2, 7);
    expect(view.length).toBe(5);
    const enc = base64url_nopad.encode(view);
    expect(base64url_nopad.decode(enc)).toEqual(new Uint8Array([0, 1, 2, 250, 255]));
    const chunks = chunk_bytes("t-view", view);
    const asm = new ChunkReassembly();
    let done: { done: false } | { done: true; bytes: Uint8Array } = { done: false };
    for (const c of chunks) done = asm.feed(c);
    if (!done.done) throw new Error("expected completion");
    expect(done.bytes).toEqual(new Uint8Array([0, 1, 2, 250, 255]));
  });
});

describe("chunked transfers", () => {
  it("splits a 140 KiB answer and reassembles it exactly", () => {
    const body = { id: "r-big", status: 200 as number, body: { text: "x".repeat(140 * 1024) } };
    void body.status;
    const raw = new TextEncoder().encode(JSON.stringify({ id: "r-big", status: 200, body: body.body }));
    const chunks = chunk_bytes("r-big", raw);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(60_000);
      expect(is_chunk_frame(c)).toBe(true);
    }
    const asm = new ChunkReassembly();
    let done: { done: false } | { done: true; bytes: Uint8Array } = { done: false };
    for (const c of chunks) done = asm.feed(c);
    if (!done.done) throw new Error("expected completion");
    const res = decode_tunnel_response(JSON.parse(new TextDecoder().decode(done.bytes)));
    expect(res.id).toBe("r-big");
    expect((res.body as { text: string }).text).toHaveLength(140 * 1024);
  });

  it("single small frames stay single (under the cap)", () => {
    const raw = new TextEncoder().encode(encode_tunnel_request({ id: "r1", method: "GET", path: "/state" }));
    expect(raw.length).toBeLessThan(SINGLE_FRAME_BYTES);
  });

  it("refuses oversize transfers instead of truncating", () => {
    expect(() => chunk_bytes("r-huge", new Uint8Array(TRANSFER_MAX_BYTES + 1))).toThrow(/ceiling/i);
    const asm = new ChunkReassembly();
    expect(() =>
      asm.feed({ transfer: "t", index: 0, total: 1, total_bytes: TRANSFER_MAX_BYTES + 1, bytes_b64u: "" }),
    ).toThrow(/ceiling/i);
  });

  it("detects gaps, reordered parts, and length mismatches", () => {
    const raw = new TextEncoder().encode("x".repeat(100_000));
    const chunks = chunk_bytes("t-gap", raw);
    expect(chunks.length).toBeGreaterThan(1);
    const asm = new ChunkReassembly();
    expect(() => asm.feed(chunks[1]!)).toThrow(/order/i);
    const asm2 = new ChunkReassembly();
    asm2.feed(chunks[0]!);
    const tampered = { ...chunks[1]!, total_bytes: raw.length + 5 };
    expect(() => asm2.feed(tampered)).toThrow(/shape/i);
  });
});

describe("stream codec (wire doc §6)", () => {
  it("parses $stream starts and $event frames, ignores unknown additions", () => {
    const start = as_stream_start({ $stream: { stream: "st-1" }, future: 1 });
    expect(start?.$stream.stream).toBe("st-1");
    const ev = as_stream_event({ $event: { stream: "st-1", envelope: { seq: 4, type: "item", item: { id: "i1" } } } });
    expect(as_live_envelope(ev?.$event.envelope)?.type).toBe("item");
    expect(as_live_envelope(ev?.$event.envelope)?.seq).toBe(4);
    expect(as_stream_start({ id: "r1", status: 200 })).toBeNull();
    expect(as_stream_event({ id: "r1", status: 200 })).toBeNull();
  });

  it("Reset envelopes are recognizable for re-subscribe", () => {
    const env = as_live_envelope({ seq: 10, type: "Reset", lagged: true });
    expect(env?.type).toBe("Reset");
    expect(env?.seq).toBe(10);
  });

  it("a chunked $event envelope reassembles through the same path", () => {
    const big = { $event: { stream: "st-9", envelope: { seq: 7, type: "item", item: { id: "big", text: "z".repeat(70 * 1024) } } } };
    const raw = new TextEncoder().encode(JSON.stringify(big));
    const chunks = chunk_bytes("t-ev-1", raw);
    expect(chunks.length).toBeGreaterThan(1);
    const asm = new ChunkReassembly();
    let done: { done: false } | { done: true; bytes: Uint8Array } = { done: false };
    for (const c of chunks) done = asm.feed(c);
    if (!done.done) throw new Error("expected completion");
    const back = as_stream_event(JSON.parse(new TextDecoder().decode(done.bytes)));
    expect(as_live_envelope(back?.$event.envelope)?.seq).toBe(7);
  });
});

describe("Forge display shapes", () => {
  it("finds pending approvals and skips decided ones", () => {
    const kind = { type: "tool", approval: { request: { type: "action", description: "run it" }, reason: "risky", options: ["allow_once", "deny_once"], decision: null } };
    expect(pending_approval(kind)?.options).toEqual(["allow_once", "deny_once"]);
    expect(pending_approval({ ...kind, approval: { ...kind.approval, decision: "allow_once" } })).toBeNull();
    expect(pending_approval({ type: "tool", approval: null })).toBeNull();
  });

  it("finds unanswered questions with options", () => {
    const kind = {
      type: "question",
      blocking: true,
      questions: [{ id: "q1", header: "Pick", text: "Which?", multi_select: false, options: [{ id: "a", label: "A", description: null }] }],
      answers: null,
    };
    const p = pending_questions(kind);
    expect(p?.blocking).toBe(true);
    expect(p?.questions[0]?.options[0]?.label).toBe("A");
    expect(pending_questions({ ...kind, answers: [null] })).toBeNull();
  });

  it("builds the exact Answer bodies the Forge validates", () => {
    expect(approval_answer("allow_once")).toEqual({ type: "approval", decision: "allow_once" });
    expect(question_answer([["a", "b"], { text: "free" }, null])).toEqual({
      type: "question",
      answers: [{ kind: "choices", ids: ["a", "b"] }, { kind: "text", text: "free" }, null],
    });
  });

  it("sends messages with client-made ids", () => {
    const body = send_message_body("id-1", "hello");
    expect(body).toEqual({ id: "id-1", text: "hello", images: [] });
  });

  it("reads untagged TextContent and never renders stored refs as text", () => {
    expect(text_of("plain")).toBe("plain");
    expect(text_of({ id: "abc", bytes: 12 })).toBeNull();
    // A bare {text} object is not valid TextContent (inline is a plain
    // string); the generic digger handles display, not text_of.
    expect(text_of({ text: "nested" })).toBeNull();
    expect(first_text({ text: "nested" })).toBe("nested");
  });

  it("tolerates additive thread/item fields", () => {
    const threads = as_threads_page({ threads: [{ id: "t1", title: "Hi", brand_new: true }], extra: 1 });
    expect(threads.threads[0]?.id).toBe("t1");
    const items = as_items_page({ items: [{ id: "i1", position: 3, kind: { type: "notice", brand_new: 1 } }], more: false });
    expect(items.items).toHaveLength(1);
    expect(as_threads_page({ threads: [{ nope: 1 }] }).threads).toEqual([]);
  });
});
