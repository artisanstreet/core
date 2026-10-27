// Tunnel codec: strict requests, lenient responses, $bytes bodies,
// chunked transfers (the >60 KiB path long transcripts need), and the
// exact answer shapes the Forge expects.

import { describe, expect, it } from "vitest";
import {
  approvalAnswer,
  asItemsPage,
  asLiveEnvelope,
  asStreamEvent,
  asStreamStart,
  asThreadsPage,
  asTunnelBytes,
  base64urlDecode,
  base64urlEncode,
  BYTES_ENVELOPE_KEY,
  ChunkReassembly,
  chunkBytes,
  decodeTunnelResponse,
  encodeTunnelRequest,
  firstText,
  isChunkFrame,
  pendingApproval,
  pendingQuestions,
  questionAnswer,
  sendMessageBody,
  SINGLE_FRAME_BYTES,
  textOf,
  throwIfTunnelError,
  TRANSFER_MAX_BYTES,
} from "../src/forge.ts";

describe("request codec (strict)", () => {
  it("encodes a minimal GET", () => {
    const json = encodeTunnelRequest({ id: "r1", method: "GET", path: "/state" });
    expect(JSON.parse(json)).toEqual({ id: "r1", method: "GET", path: "/state" });
  });

  it("rejects unknown fields", () => {
    expect(() => encodeTunnelRequest({ id: "r1", method: "GET", path: "/state", bogus: 1 } as never)).toThrow();
  });

  it("rejects non-origin paths, .. segments, and bad methods", () => {
    expect(() => encodeTunnelRequest({ id: "r1", method: "GET", path: "https://x/state" })).toThrow();
    expect(() => encodeTunnelRequest({ id: "r1", method: "GET", path: "/a/../b" })).toThrow();
    expect(() => encodeTunnelRequest({ id: "r1", method: "FETCH" as never, path: "/state" })).toThrow();
    expect(() => encodeTunnelRequest({ id: "", method: "GET", path: "/state" })).toThrow();
  });

  it("keeps query strings on paths", () => {
    const json = encodeTunnelRequest({ id: "r1", method: "GET", path: "/threads/abc/transcript?after=5&limit=100" });
    expect(JSON.parse(json).path).toContain("after=5");
  });
});

describe("response codec (forward-compatible)", () => {
  it("ignores additive fields and keeps content_type", () => {
    const res = decodeTunnelResponse({ id: "r1", status: 200, body: { items: [] }, content_type: "application/json", addedLater: 1 });
    expect(res.status).toBe(200);
    expect(res.content_type).toBe("application/json");
  });

  it("rejects malformed responses", () => {
    expect(() => decodeTunnelResponse({ id: "r1", status: 99, body: null })).toThrow();
    expect(() => decodeTunnelResponse({ status: 200, body: null })).toThrow();
  });

  it("throwIfTunnelError surfaces Forge messages with status", () => {
    const err = (() => {
      try {
        throwIfTunnelError(decodeTunnelResponse({ id: "r1", status: 404, body: { error: { code: "not_found", message: "nope" } } }));
        return null;
      } catch (e) {
        return e as Error & { tunnelStatus?: number };
      }
    })();
    expect(err?.tunnelStatus).toBe(404);
    expect(err?.message).toBe("nope");
  });
});

describe("$bytes envelope", () => {
  it("detects the single-key envelope and rejects lookalikes", () => {
    const body = { [BYTES_ENVELOPE_KEY]: { content_type: "image/webp", b64u: "aGk" } };
    expect(asTunnelBytes(body)?.content_type).toBe("image/webp");
    expect(asTunnelBytes({ [BYTES_ENVELOPE_KEY]: { content_type: "image/webp" }, other: 1 })).toBeNull();
    expect(asTunnelBytes({ items: [] })).toBeNull();
  });

  it("round-trips binary through base64url", () => {
    const raw = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64urlDecode(base64urlEncode(raw))).toEqual(raw);
  });
});

describe("chunked transfers", () => {
  it("splits a 140 KiB answer and reassembles it exactly", () => {
    const body = { id: "r-big", status: 200 as number, body: { text: "x".repeat(140 * 1024) } };
    void body.status;
    const raw = new TextEncoder().encode(JSON.stringify({ id: "r-big", status: 200, body: body.body }));
    const chunks = chunkBytes("r-big", raw);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(60_000);
      expect(isChunkFrame(c)).toBe(true);
    }
    const asm = new ChunkReassembly();
    let done: { done: false } | { done: true; bytes: Uint8Array } = { done: false };
    for (const c of chunks) done = asm.feed(c);
    if (!done.done) throw new Error("expected completion");
    const res = decodeTunnelResponse(JSON.parse(new TextDecoder().decode(done.bytes)));
    expect(res.id).toBe("r-big");
    expect((res.body as { text: string }).text).toHaveLength(140 * 1024);
  });

  it("single small frames stay single (under the cap)", () => {
    const raw = new TextEncoder().encode(encodeTunnelRequest({ id: "r1", method: "GET", path: "/state" }));
    expect(raw.length).toBeLessThan(SINGLE_FRAME_BYTES);
  });

  it("refuses oversize transfers instead of truncating", () => {
    expect(() => chunkBytes("r-huge", new Uint8Array(TRANSFER_MAX_BYTES + 1))).toThrow(/ceiling/i);
    const asm = new ChunkReassembly();
    expect(() =>
      asm.feed({ transfer: "t", index: 0, total: 1, total_bytes: TRANSFER_MAX_BYTES + 1, bytes_b64u: "" }),
    ).toThrow(/ceiling/i);
  });

  it("detects gaps, reordered parts, and length mismatches", () => {
    const raw = new TextEncoder().encode("x".repeat(100_000));
    const chunks = chunkBytes("t-gap", raw);
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
    const start = asStreamStart({ $stream: { stream: "st-1" }, future: 1 });
    expect(start?.$stream.stream).toBe("st-1");
    const ev = asStreamEvent({ $event: { stream: "st-1", envelope: { seq: 4, type: "item", item: { id: "i1" } } } });
    expect(asLiveEnvelope(ev?.$event.envelope)?.type).toBe("item");
    expect(asLiveEnvelope(ev?.$event.envelope)?.seq).toBe(4);
    expect(asStreamStart({ id: "r1", status: 200 })).toBeNull();
    expect(asStreamEvent({ id: "r1", status: 200 })).toBeNull();
  });

  it("Reset envelopes are recognizable for re-subscribe", () => {
    const env = asLiveEnvelope({ seq: 10, type: "Reset", lagged: true });
    expect(env?.type).toBe("Reset");
    expect(env?.seq).toBe(10);
  });

  it("a chunked $event envelope reassembles through the same path", () => {
    const big = { $event: { stream: "st-9", envelope: { seq: 7, type: "item", item: { id: "big", text: "z".repeat(70 * 1024) } } } };
    const raw = new TextEncoder().encode(JSON.stringify(big));
    const chunks = chunkBytes("t-ev-1", raw);
    expect(chunks.length).toBeGreaterThan(1);
    const asm = new ChunkReassembly();
    let done: { done: false } | { done: true; bytes: Uint8Array } = { done: false };
    for (const c of chunks) done = asm.feed(c);
    if (!done.done) throw new Error("expected completion");
    const back = asStreamEvent(JSON.parse(new TextDecoder().decode(done.bytes)));
    expect(asLiveEnvelope(back?.$event.envelope)?.seq).toBe(7);
  });
});

describe("Forge display shapes", () => {
  it("finds pending approvals and skips decided ones", () => {
    const kind = { type: "tool", approval: { request: { type: "action", description: "run it" }, reason: "risky", options: ["allow_once", "deny_once"], decision: null } };
    expect(pendingApproval(kind)?.options).toEqual(["allow_once", "deny_once"]);
    expect(pendingApproval({ ...kind, approval: { ...kind.approval, decision: "allow_once" } })).toBeNull();
    expect(pendingApproval({ type: "tool", approval: null })).toBeNull();
  });

  it("finds unanswered questions with options", () => {
    const kind = {
      type: "question",
      blocking: true,
      questions: [{ id: "q1", header: "Pick", text: "Which?", multi_select: false, options: [{ id: "a", label: "A", description: null }] }],
      answers: null,
    };
    const p = pendingQuestions(kind);
    expect(p?.blocking).toBe(true);
    expect(p?.questions[0]?.options[0]?.label).toBe("A");
    expect(pendingQuestions({ ...kind, answers: [null] })).toBeNull();
  });

  it("builds the exact Answer bodies the Forge validates", () => {
    expect(approvalAnswer("allow_once")).toEqual({ type: "approval", decision: "allow_once" });
    expect(questionAnswer([["a", "b"], { text: "free" }, null])).toEqual({
      type: "question",
      answers: [{ kind: "choices", ids: ["a", "b"] }, { kind: "text", text: "free" }, null],
    });
  });

  it("sends messages with client-made ids", () => {
    const body = sendMessageBody("id-1", "hello");
    expect(body).toEqual({ id: "id-1", text: "hello", images: [] });
  });

  it("reads untagged TextContent and never renders stored refs as text", () => {
    expect(textOf("plain")).toBe("plain");
    expect(textOf({ id: "abc", bytes: 12 })).toBeNull();
    // A bare {text} object is not valid TextContent (inline is a plain
    // string); the generic digger handles display, not textOf.
    expect(textOf({ text: "nested" })).toBeNull();
    expect(firstText({ text: "nested" })).toBe("nested");
  });

  it("tolerates additive thread/item fields", () => {
    const threads = asThreadsPage({ threads: [{ id: "t1", title: "Hi", brandNew: true }], extra: 1 });
    expect(threads.threads[0]?.id).toBe("t1");
    const items = asItemsPage({ items: [{ id: "i1", position: 3, kind: { type: "notice", brandNew: 1 } }], more: false });
    expect(items.items).toHaveLength(1);
    expect(asThreadsPage({ threads: [{ nope: 1 }] }).threads).toEqual([]);
  });
});
