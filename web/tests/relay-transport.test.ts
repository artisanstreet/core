// Transport behavior against a window-enforcing fake Relay link (no WS):
// real Noise XX sessions, real grants (self-minted), real chunk framing,
// real ack pacing — only the socket is fake, enforcing the 64-frame /
// 1 MiB window with async peer acks like the real room. A 2 MiB upload
// paces through and succeeds; nothing is ever silently dropped.

import { describe, expect, it } from "vitest";
import { importJWK, SignJWT } from "jose";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { NoiseChannel, static_keypair_from_secret, type VerifyChannelJwt } from "../vendor/relay/channel.ts";
import { b64u_decode, b64u_encode } from "../vendor/relay/b64u.ts";
import { ChunkReassembly, SINGLE_FRAME_BYTES, chunk_bytes } from "../src/forge.ts";
import { CoreApi } from "../src/api.ts";
import {
  ForgeSession,
  type ChannelEvents,
  type RelayLinkLike,
} from "../src/relay-forge.ts";
import type { GrantMaterial } from "../vendor/relay/client.ts";
import { create_stream_feed } from "../src/live.ts";

const MOCK_ISS = "https://transport-test.invalid";

async function mint_jwt(cnf_pk: Uint8Array, core_sk: Uint8Array, sub: string, mid: string): Promise<string> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", d: b64u_encode(core_sk), x: b64u_encode(ed25519.getPublicKey(core_sk)) }, "EdDSA");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    v: 1, sub, mid, role: "client", scope: ["relay:connect", "forge:execute"],
    cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: b64u_encode(cnf_pk) } }, jti: `t-${Math.random()}`,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "t1" })
    .setIssuer(MOCK_ISS).setAudience("ast-relay").setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300)
    .sign(key);
}

/** Fake Relay link: real responder NoiseChannel, real window accounting. */
class FakeLink implements RelayLinkLike {
  events: ChannelEvents | null = null;
  sent_bodies: Uint8Array[] = [];
  dropped = 0;
  private responder: NoiseChannel | null = null;
  private channel = "";
  private seq = 0;
  private readonly asm = new Map<string, ChunkReassembly>();

  constructor(
    private readonly forge_sk: Uint8Array,
    private readonly forge_pk: Uint8Array,
    private readonly ctx: { account: string; machine: string },
  ) {}

  async connect(): Promise<{ role: string; forge_online: boolean }> {
    return { role: "client", forge_online: true };
  }

  open(channel: string): void {
    this.channel = channel;
    // Lenient grant read (admission is Relay's job, covered elsewhere);
    // the Noise binding signature is still verified for real.
    const verify: VerifyChannelJwt = async (jwt) => {
      const payload = JSON.parse(new TextDecoder().decode(b64u_decode(jwt.split(".")[1] ?? ""))) as {
        sub?: unknown; mid?: unknown; cnf?: { jwk?: { x?: unknown } };
      };
      if (payload.sub !== this.ctx.account || payload.mid !== this.ctx.machine) throw new Error("binding");
      const x = payload.cnf?.jwk?.x;
      if (typeof x !== "string") throw new Error("no cnf");
      return b64u_decode(x);
    };
    this.responder = new NoiseChannel({
      initiator: false,
      static_keypair: static_keypair_from_secret(randomBytes(32)),
      cnf_sign_key: this.forge_sk,
      verify_channel_jwt: verify,
      ctx: { ...this.ctx, channel },
    });
    setTimeout(() => this.events?.on_channel_opened?.(channel, "forge"), 0);
  }

  private pump(): void {
    const n = this.responder;
    if (!n) return;
    for (const out of n.take_outbound()) this.emit(out);
    // Responder handshake turn: take_outbound never produces handshake
    // messages; emit our reply when it is our turn.
    if (n.get_phase() === "handshake") {
      try {
        this.emit(n.next_handshake_message());
        for (const out of n.take_outbound()) this.emit(out);
      } catch {
        // Not our turn yet; the next inbound message triggers us.
      }
    }
  }

  /** When true, peer acks are withheld (tests WouldBlock + retry). */
  hold_acks = false;
  private unacked: Array<{ seq: number; bytes: number; resolve: () => void; timer: ReturnType<typeof setTimeout> | null }> = [];
  private queued: Array<{ body: Uint8Array; encoded: number; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }> = [];
  private peer_seq = 0;

  private window_has(encoded_bytes: number): boolean {
    const frames = this.unacked.length;
    const bytes = this.unacked.reduce((n, u) => n + u.bytes, 0);
    return frames < 64 && bytes + encoded_bytes <= 1_048_576;
  }

  will_fit(_channel: string, encoded_bytes: number): boolean {
    return this.window_has(encoded_bytes);
  }

  send_opaque(channel: string, body: Uint8Array): "sent" | "dropped-window-full" {
    if (channel !== this.channel || !this.responder) return "dropped-window-full";
    const encoded = b64u_encode(body).length;
    if (!this.window_has(encoded)) {
      this.dropped += 1;
      setTimeout(() => this.events?.on_error?.("backpressure", "recipient window full; frame dropped"), 0);
      return "dropped-window-full";
    }
    this.route(body, encoded, () => undefined, () => undefined);
    return "sent";
  }

  send_acked(channel: string, body: Uint8Array, opts: { timeout_ms?: number } = {}): Promise<void> {
    const timeout_ms = opts.timeout_ms ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      if (channel !== this.channel || !this.responder) {
        reject(new Error("not connected"));
        return;
      }
      const encoded = b64u_encode(body).length;
      const timer = timeout_ms > 0 ? setTimeout(() => reject(new Error("ack timeout")), timeout_ms) : null;
      const entry = { body, encoded, resolve, reject, timer };
      if (this.window_has(encoded)) {
        this.route_entry(entry);
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

  private route_entry(entry: { body: Uint8Array; encoded: number; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }): void {
    const wrapped = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve();
    };
    this.route(entry.body, entry.encoded, wrapped, entry.reject);
  }

  private route(body: Uint8Array, encoded: number, resolve: () => void, _reject: (e: Error) => void): void {
    const n = this.responder;
    if (!n) return;
    this.sent_bodies.push(body);
    const seq = this.peer_seq++;
    const tracked = { seq, bytes: encoded, resolve, timer: null as ReturnType<typeof setTimeout> | null };
    this.unacked.push(tracked);
    setImmediate(() => {
      try {
        if (n.get_phase() === "handshake") {
          n.receive_handshake_message(body);
        } else {
          const app = n.receive_transport(body);
          if (app) this.on_request(app);
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
      this.events?.on_ack?.(this.channel, seq);
      while (this.queued.length > 0) {
        const next = this.queued[0]!;
        if (!this.window_has(next.encoded)) break;
        this.queued.shift();
        this.route_entry(next);
      }
    };
    if (this.hold_acks) {
      this.held_acks.push(ack);
    } else {
      setImmediate(ack);
    }
    // The responder confirm emits asynchronously (JWT verify inside the
    // Noise confirm); flush again on short delays so the handshake
    // completes without polling the relay.
    setTimeout(() => this.pump(), 10);
    setTimeout(() => this.pump(), 100);
  }

  private held_acks: Array<() => void> = [];

  /** Release all withheld acks (WouldBlock-retry tests). */
  release_acks(): void {
    for (const ack of this.held_acks.splice(0, this.held_acks.length)) ack();
  }

  private emit(body: Uint8Array): void {
    this.events?.on_data?.(this.channel, this.seq++, body);
  }

  private answer(value: unknown): void {
    const raw = new TextEncoder().encode(JSON.stringify(value));
    const n = this.responder;
    if (!n) return;
    if (raw.length > SINGLE_FRAME_BYTES) {
      for (const chunk of chunk_bytes(`t-${this.seq}-${raw.length}`, raw)) {
        const { ct } = n.seal(new TextEncoder().encode(JSON.stringify(chunk)));
        this.emit(ct);
      }
      return;
    }
    this.emit(n.seal(raw).ct);
  }

  private on_request(app: Uint8Array): void {
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

  close_channel(): void {}
  close(): void {}
}

function stub_core(core_sk: Uint8Array, sub: string, mid: string): CoreApi {
  const fetch_impl = (async (url: string, init: RequestInit) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/v1/grants/issue") {
      // Mint per request against the caller-supplied cnf, like real Core:
      // the session always proves possession of the exact granted key.
      const raw_body = init.body;
      const body = JSON.parse((typeof raw_body === "string" ? raw_body : new TextDecoder().decode(raw_body as Uint8Array)) ?? "{}") as { cnf?: { x?: unknown } };
      const x = body.cnf?.x;
      if (typeof x !== "string") throw new Error("mock: cnf required");
      const jwt = await mint_jwt(b64u_decode(x), core_sk, sub, mid);
      return new Response(JSON.stringify({ token: jwt, expires_at: new Date(Date.now() + 300_000).toISOString() }), { status: 200 });
    }
    throw new Error(`unexpected ${u.pathname}`);
  }) as typeof fetch;
  return new CoreApi("", { fetch_impl });
}

async function connected_session(): Promise<{ session: ForgeSession; link: FakeLink; cnf_x: string }> {
  const core_sk = ed25519.utils.randomSecretKey();
  const forge_sk = ed25519.utils.randomSecretKey();
  const forge_pk = ed25519.getPublicKey(forge_sk);
  const sub = `acct_01K${"A".repeat(23)}`;
  const mid = `mch_01K${"A".repeat(23)}`;
  const api = stub_core(core_sk, sub, mid);
  const cnf_x = b64u_encode(forge_pk);
  let link_ref: FakeLink | null = null;
  const session = new ForgeSession({
    core: api,
    relay_ws_url: "wss://relay.test",
    relay_http_url: "https://relay.test",
    account_id: sub,
    machine_id: mid,
    forge_cnf_x: cnf_x,
    create_link: (_url: string, _grant: GrantMaterial, events: ChannelEvents) => {
      const link = new FakeLink(forge_sk, forge_pk, { account: sub, machine: mid });
      link.events = events;
      link_ref = link;
      return link;
    },
  });
  await session.connect();
  if (!link_ref) throw new Error("no link");
  return { session, link: link_ref, cnf_x };
}

describe("ordered transport + window", () => {
  it("small calls round-trip in order", async () => {
    const { session, link } = await connected_session();
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

  it("a 2 MiB upload paces through the window and succeeds (send_acked)", async () => {
    const { session, link } = await connected_session();
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
      connect: async () => ({ role: "client", forge_online: true }),
      open: () => undefined,
      send_opaque: () => "sent" as const,
      send_acked: async (_c: string, _b: Uint8Array) => undefined,
      will_fit: () => {
        order.push("fit-check");
        return fits;
      },
      close_channel: () => undefined,
      close: () => undefined,
    };
    const fake_secure = { noise: { seal: (pt: Uint8Array) => ({ ct: pt }) } };
    const sender = new PacedSender(() => link, "ch", () => false);
    const done = sender.send(fake_secure as never, "hello");
    await new Promise((r) => setTimeout(r, 10));
    // Blocked on the full window: nothing sealed, nothing sent.
    expect(order).toEqual(["fit-check"]);
    fits = true;
    sender.on_ack();
    await done;
    expect(order).toEqual(["fit-check", "fit-check"]);
  });
});
