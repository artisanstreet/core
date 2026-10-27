// Transport behavior against a window-enforcing fake Relay link (no WS):
// real Noise XX sessions, real grants (self-minted), real chunk framing,
// real ack pacing — only the socket is fake, enforcing the 64-frame /
// 1 MiB window with async peer acks like the real room. A 2 MiB upload
// paces through and succeeds; nothing is ever silently dropped.

import { describe, expect, it } from "vitest";
import { importJWK, SignJWT } from "jose";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { NoiseChannel, staticKeypairFromSecret, type VerifyChannelJwt } from "../vendor/relay/channel.ts";
import { b64uDecode, b64uEncode } from "../vendor/relay/b64u.ts";
import { ChunkReassembly, SINGLE_FRAME_BYTES, chunkBytes } from "../src/forge.ts";
import { CoreApi } from "../src/api.ts";
import {
  ForgeSession,
  type ChannelEvents,
  type RelayLinkLike,
} from "../src/relay-forge.ts";
import type { GrantMaterial } from "../vendor/relay/client.ts";
import { createStreamFeed } from "../src/live.ts";

const MOCK_ISS = "https://transport-test.invalid";

async function mintJwt(cnfPk: Uint8Array, coreSk: Uint8Array, sub: string, mid: string): Promise<string> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", d: b64uEncode(coreSk), x: b64uEncode(ed25519.getPublicKey(coreSk)) }, "EdDSA");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    v: 1, sub, mid, role: "client", scope: ["relay:connect", "forge:execute"],
    cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: b64uEncode(cnfPk) } }, jti: `t-${Math.random()}`,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "t1" })
    .setIssuer(MOCK_ISS).setAudience("ast-relay").setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300)
    .sign(key);
}

/** Fake Relay link: real responder NoiseChannel, real window accounting. */
class FakeLink implements RelayLinkLike {
  events: ChannelEvents | null = null;
  sentBodies: Uint8Array[] = [];
  dropped = 0;
  private responder: NoiseChannel | null = null;
  private channel = "";
  private seq = 0;
  private readonly asm = new Map<string, ChunkReassembly>();

  constructor(
    private readonly forgeSk: Uint8Array,
    private readonly forgePk: Uint8Array,
    private readonly ctx: { account: string; machine: string },
  ) {}

  async connect(): Promise<{ role: string; forgeOnline: boolean }> {
    return { role: "client", forgeOnline: true };
  }

  open(channel: string): void {
    this.channel = channel;
    // Lenient grant read (admission is Relay's job, covered elsewhere);
    // the Noise binding signature is still verified for real.
    const verify: VerifyChannelJwt = async (jwt) => {
      const payload = JSON.parse(new TextDecoder().decode(b64uDecode(jwt.split(".")[1] ?? ""))) as {
        sub?: unknown; mid?: unknown; cnf?: { jwk?: { x?: unknown } };
      };
      if (payload.sub !== this.ctx.account || payload.mid !== this.ctx.machine) throw new Error("binding");
      const x = payload.cnf?.jwk?.x;
      if (typeof x !== "string") throw new Error("no cnf");
      return b64uDecode(x);
    };
    this.responder = new NoiseChannel({
      initiator: false,
      staticKeypair: staticKeypairFromSecret(randomBytes(32)),
      cnfSignKey: this.forgeSk,
      verifyChannelJwt: verify,
      ctx: { ...this.ctx, channel },
    });
    setTimeout(() => this.events?.onChannelOpened?.(channel, "forge"), 0);
  }

  private pump(): void {
    const n = this.responder;
    if (!n) return;
    for (const out of n.takeOutbound()) this.emit(out);
    // Responder handshake turn: takeOutbound never produces handshake
    // messages; emit our reply when it is our turn.
    if (n.getPhase() === "handshake") {
      try {
        this.emit(n.nextHandshakeMessage());
        for (const out of n.takeOutbound()) this.emit(out);
      } catch {
        // Not our turn yet; the next inbound message triggers us.
      }
    }
  }

  /** When true, peer acks are withheld (tests WouldBlock + retry). */
  holdAcks = false;
  private unacked: Array<{ seq: number; bytes: number; resolve: () => void; timer: ReturnType<typeof setTimeout> | null }> = [];
  private queued: Array<{ body: Uint8Array; encoded: number; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }> = [];
  private peerSeq = 0;

  private windowHas(encodedBytes: number): boolean {
    const frames = this.unacked.length;
    const bytes = this.unacked.reduce((n, u) => n + u.bytes, 0);
    return frames < 64 && bytes + encodedBytes <= 1_048_576;
  }

  willFit(_channel: string, encodedBytes: number): boolean {
    return this.windowHas(encodedBytes);
  }

  sendOpaque(channel: string, body: Uint8Array): "sent" | "dropped-window-full" {
    if (channel !== this.channel || !this.responder) return "dropped-window-full";
    const encoded = b64uEncode(body).length;
    if (!this.windowHas(encoded)) {
      this.dropped += 1;
      setTimeout(() => this.events?.onError?.("backpressure", "recipient window full; frame dropped"), 0);
      return "dropped-window-full";
    }
    this.route(body, encoded, () => undefined, () => undefined);
    return "sent";
  }

  sendAcked(channel: string, body: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      if (channel !== this.channel || !this.responder) {
        reject(new Error("not connected"));
        return;
      }
      const encoded = b64uEncode(body).length;
      const timer = timeoutMs > 0 ? setTimeout(() => reject(new Error("ack timeout")), timeoutMs) : null;
      const entry = { body, encoded, resolve, reject, timer };
      if (this.windowHas(encoded)) {
        this.routeEntry(entry);
        return;
      }
      if (this.queued.length >= 256) {
        if (timer) clearTimeout(timer);
        reject(new Error("send queue full"));
        return;
      }
      this.queued.push(entry);
    });
  }

  private routeEntry(entry: { body: Uint8Array; encoded: number; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }): void {
    const wrapped = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve();
    };
    this.route(entry.body, entry.encoded, wrapped, entry.reject);
  }

  private route(body: Uint8Array, encoded: number, resolve: () => void, _reject: (e: Error) => void): void {
    const n = this.responder;
    if (!n) return;
    this.sentBodies.push(body);
    const seq = this.peerSeq++;
    const tracked = { seq, bytes: encoded, resolve, timer: null as ReturnType<typeof setTimeout> | null };
    this.unacked.push(tracked);
    setImmediate(() => {
      try {
        if (n.getPhase() === "handshake") {
          n.receiveHandshakeMessage(body);
        } else {
          const app = n.receiveTransport(body);
          if (app) this.onRequest(app);
        }
        this.pump();
      } catch {
        // Real channel would break here too (fail-closed cipher stream).
      }
    });
    // Compliant-forge ack: prompt but asynchronous — then drain the queue.
    const ack = () => {
      this.unacked = this.unacked.filter((u) => {
        if (u.seq <= seq) {
          if (u.timer) clearTimeout(u.timer);
          u.resolve();
          return false;
        }
        return true;
      });
      // Forward the cumulative ack like the room does, so the sender's
      // window slides (and WouldBlock waiters wake).
      this.events?.onAck?.(this.channel, seq);
      while (this.queued.length > 0) {
        const next = this.queued[0]!;
        if (!this.windowHas(next.encoded)) break;
        this.queued.shift();
        this.routeEntry(next);
      }
    };
    if (this.holdAcks) {
      this.heldAcks.push(ack);
    } else {
      setImmediate(ack);
    }
    // The responder confirm emits asynchronously (JWT verify inside the
    // Noise confirm); flush again on short delays so the handshake
    // completes without polling the relay.
    setTimeout(() => this.pump(), 10);
    setTimeout(() => this.pump(), 100);
  }

  private heldAcks: Array<() => void> = [];

  /** Release all withheld acks (WouldBlock-retry tests). */
  releaseAcks(): void {
    for (const ack of this.heldAcks.splice(0, this.heldAcks.length)) ack();
  }

  private emit(body: Uint8Array): void {
    this.events?.onData?.(this.channel, this.seq++, body);
  }

  private answer(value: unknown): void {
    const raw = new TextEncoder().encode(JSON.stringify(value));
    const n = this.responder;
    if (!n) return;
    if (raw.length > SINGLE_FRAME_BYTES) {
      for (const chunk of chunkBytes(`t-${this.seq}-${raw.length}`, raw)) {
        const { ct } = n.seal(new TextEncoder().encode(JSON.stringify(chunk)));
        this.emit(ct);
      }
      return;
    }
    this.emit(n.seal(raw).ct);
  }

  private onRequest(app: Uint8Array): void {
    const json = JSON.parse(new TextDecoder().decode(app)) as Record<string, unknown>;
    if (typeof json.transfer === "string" && typeof json.bytes_b64u === "string") {
      let asm = this.asm.get(json.transfer);
      if (!asm) {
        asm = new ChunkReassembly();
        this.asm.set(json.transfer, asm);
      }
      try {
        const out = asm.feed(json as never);
        if (!out.done) return;
        this.asm.delete(json.transfer);
        const full = JSON.parse(new TextDecoder().decode(out.bytes)) as { id?: unknown };
        this.answer({ id: full.id ?? "?", status: 200, body: { ok: true, bytes: out.bytes.length } });
      } catch {
        // Incomplete/gapped transfer: no answer (mirrors a broken Forge).
      }
      return;
    }
    const r = json as { id?: unknown; method?: unknown; path?: unknown };
    if (r.method === "SUBSCRIBE") {
      this.answer({ id: r.id, status: 200, body: { $stream: { stream: "st-fake-1" } } });
      return;
    }
    if (r.method === "UNSUBSCRIBE") {
      this.answer({ id: r.id, status: 200, body: { ok: true } });
      return;
    }
    this.answer({ id: r.id ?? "?", status: 200, body: { ok: true } });
  }

  closeChannel(): void {}
  close(): void {}
}

function stubCore(coreSk: Uint8Array, sub: string, mid: string): CoreApi {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/v1/grants/issue") {
      // Mint per request against the caller-supplied cnf, like real Core:
      // the session always proves possession of the exact granted key.
      const raw_body = init.body;
      const body = JSON.parse((typeof raw_body === "string" ? raw_body : new TextDecoder().decode(raw_body as Uint8Array)) ?? "{}") as { cnf?: { x?: unknown } };
      const x = body.cnf?.x;
      if (typeof x !== "string") throw new Error("mock: cnf required");
      const jwt = await mintJwt(b64uDecode(x), coreSk, sub, mid);
      return new Response(JSON.stringify({ token: jwt, expiresAt: new Date(Date.now() + 300_000).toISOString() }), { status: 200 });
    }
    throw new Error(`unexpected ${u.pathname}`);
  }) as typeof fetch;
  return new CoreApi("", { fetchImpl });
}

async function connectedSession(): Promise<{ session: ForgeSession; link: FakeLink; cnfX: string }> {
  const coreSk = ed25519.utils.randomSecretKey();
  const forgeSk = ed25519.utils.randomSecretKey();
  const forgePk = ed25519.getPublicKey(forgeSk);
  const sub = `acct_01K${"A".repeat(23)}`;
  const mid = `mch_01K${"A".repeat(23)}`;
  const api = stubCore(coreSk, sub, mid);
  const cnfX = b64uEncode(forgePk);
  let linkRef: FakeLink | null = null;
  const session = new ForgeSession({
    core: api,
    relayWsUrl: "wss://relay.test",
    relayHttpUrl: "https://relay.test",
    accountId: sub,
    machineId: mid,
    forgeCnfX: cnfX,
    createLink: (_url: string, _grant: GrantMaterial, events: ChannelEvents) => {
      const link = new FakeLink(forgeSk, forgePk, { account: sub, machine: mid });
      link.events = events;
      linkRef = link;
      return link;
    },
  });
  await session.connect();
  if (!linkRef) throw new Error("no link");
  return { session, link: linkRef, cnfX };
}

describe("ordered transport + window", () => {
  it("small calls round-trip in order", async () => {
    const { session, link } = await connectedSession();
    try {
      const r1 = await session.call({ method: "GET", path: "/state" });
      const r2 = await session.call({ method: "GET", path: "/threads" });
      expect((r1.body as { ok: boolean }).ok).toBe(true);
      expect((r2.body as { ok: boolean }).ok).toBe(true);
      expect(link.dropped).toBe(0);
    } finally {
      session.close();
    }
  });

  it("a 2 MiB upload paces through the window and succeeds (sendAcked)", async () => {
    const { session, link } = await connectedSession();
    try {
      const big = "x".repeat(2 * 1024 * 1024);
      const res = await session.call({ method: "POST", path: "/threads/t/messages", body: { id: "big-1", text: big } });
      expect((res.body as { ok: boolean }).ok).toBe(true);
      expect((res.body as { bytes: number }).bytes).toBeGreaterThan(2 * 1024 * 1024);
      expect(link.dropped).toBe(0);
    } finally {
      session.close();
    }
  });

  it("WouldBlock pauses for acks without consuming, then retries in order", async () => {
    const { PacedSender } = await import("../src/relay-forge.ts");
    const order: string[] = [];
    let fits = false;
    const link: RelayLinkLike = {
      connect: async () => ({ role: "client", forgeOnline: true }),
      open: () => undefined,
      sendOpaque: () => "sent" as const,
      sendAcked: async (_c: string, _b: Uint8Array) => undefined,
      willFit: () => {
        order.push("fit-check");
        return fits;
      },
      closeChannel: () => undefined,
      close: () => undefined,
    };
    const fakeSecure = { noise: { seal: (pt: Uint8Array) => ({ ct: pt }) } };
    const sender = new PacedSender(() => link, "ch", () => false);
    const done = sender.send(fakeSecure as never, "hello");
    await new Promise((r) => setTimeout(r, 10));
    // Blocked on the full window: nothing sealed, nothing sent.
    expect(order).toEqual(["fit-check"]);
    fits = true;
    sender.onAck();
    await done;
    expect(order).toEqual(["fit-check", "fit-check"]);
  });
});
