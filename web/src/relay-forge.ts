// Remote-Forge session: Core grant → Relay admission → Noise XX E2E →
// tunnel RPC. Uses ONLY the vendored Relay release
// (vendor/relay/*, commit recorded in vendor/relay/VERSION) and the
// contract in relay/contracts/e2e.md:
//
// - Noise_XX_25519_ChaChaPoly_BLAKE2b via the pinned `noise-handshake`
//   library. Fresh static keys per channel (pure DH randomness).
// - Identity: the initiator (this browser) sends its Core-signed grant JWT
//   INSIDE the first encrypted confirm frame; the Forge verifies that JWT
//   itself (JWKS, sub/mid/scope/expiry) and takes the verified `cnf` key.
//   This browser verifies the Forge's binding signature against the
//   enrolled machine key from authenticated Core (`GET /v1/machines`).
// - Relay-forwarded keys are never trusted; no ephemeral-key registry, no
//   custom crypto. `cnf` material here is Ed25519 via @noble/curves (the
//   same vetted backend the Relay package uses).
//
// The browser never receives machine/provider secrets: grants carry only
// the public `cnf.jwk`, and tunnel plaintext is Forge application JSON.

import { ed25519 } from "@noble/curves/ed25519.js";
import { Schema } from "effect";
import { EditorLink, SecureChannel, SendTimeoutError, SendWouldBlockError } from "../vendor/relay/client.ts";
import type { GrantMaterial } from "../vendor/relay/client.ts";
import { sealedFrameSize } from "../vendor/relay/channel.ts";
import { b64uDecode, b64uEncode } from "../vendor/relay/jwt.ts";
import { staticKeypairFromSecret } from "../vendor/relay/channel.ts";
import { randomBytes } from "@noble/hashes/utils.js";
import type { CoreApi } from "./api.ts";
import {
  asLiveEnvelope,
  asStreamEvent,
  asStreamStart,
  ChunkReassembly,
  chunkBytes,
  decodeTunnelResponse,
  encodeTunnelRequest,
  isChunkFrame,
  newRequestId,
  SINGLE_FRAME_BYTES,
  throwIfTunnelError,
  TunnelChunk,
  type LiveEnvelope,
  type TunnelRequest,
  type TunnelResponse,
} from "./forge.ts";

export interface CnfKeypair {
  sk: Uint8Array;
  pk: Uint8Array;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
}

/** Fresh ephemeral Ed25519 `cnf` key for one grant (never stored). */
export function newEphemeralCnf(): CnfKeypair {
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  return { sk, pk, jwk: { kty: "OKP", crv: "Ed25519", x: b64uEncode(pk) } };
}

export interface ForgeSessionOptions {
  core: CoreApi;
  /** e.g. wss://relay.artisanstreet.dev — never carries credentials. */
  relayWsUrl: string;
  /** e.g. https://relay.artisanstreet.dev for presence reads. */
  relayHttpUrl: string;
  accountId: string;
  machineId: string;
  /** Enrolled Forge Ed25519 key (JWK x) from authenticated Core. */
  forgeCnfX: string;
  onEvent?: (ev: ForgeSessionEvent) => void;
  wsImpl?: typeof WebSocket;
  /**
   * Test seam: build the Relay link. Production uses EditorLink (real WS);
   * tests inject a fake enforcing the 64-frame / 1 MiB window. The seam
   * only swaps transport — Noise, grants, and framing stay real.
   */
  createLink?: (url: string, grant: GrantMaterial, events: ChannelEvents) => RelayLinkLike;
}

/** Minimal link surface ForgeSession/ForgeStream drive (real EditorLink satisfies this). */
export interface RelayLinkLike {
  connect(): Promise<{ role: string; forgeOnline: boolean }>;
  open(channel: string): void;
  sendOpaque(channel: string, body: Uint8Array): SendStatus;
  sendAcked(channel: string, body: Uint8Array, opts?: { timeoutMs?: number }): Promise<void>;
  willFit(channel: string, encodedBytes: number): boolean;
  closeChannel(channel: string, reason?: string): void;
  close(code?: number, reason?: string): void;
}

export type SendStatus = "sent" | "dropped-window-full";

export type ChannelEvents = {
  onChannelOpened?(channel: string, peer: "forge" | "client"): void;
  onData?(channel: string, seq: number, body: Uint8Array): void;
  onChannelClosed?(channel: string, reason: string): void;
  onPresence?(forgeOnline: boolean, clients: number): void;
  onError?(code: string, message: string): void;
  onAck?(channel: string, seq: number): void;
  onClose?(code: number, reason: string): void;
};

export type ForgeSessionEvent =
  | { type: "ready"; forgeOnline: boolean }
  | { type: "presence"; forgeOnline: boolean; clients: number }
  | { type: "channel-opened"; channel: string }
  | { type: "channel-closed"; channel: string; reason: string }
  | { type: "error"; code: string; message: string };

function channelCtx(account: string, machine: string, channel: string) {
  return { account, machine, channel };
}

/** Random channel id inside the Relay charset. */
export function newChannelId(): string {
  return `app-${b64uEncode(randomBytes(9))}`;
}

export interface Presence {
  forgeOnline: boolean;
  clients: number;
}

/** Authenticated presence read (Bearer grant, same account+machine). */
export async function fetchPresence(
  relayHttpUrl: string,
  accountId: string,
  machineId: string,
  grantJwt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Presence> {
  const res = await fetchImpl(
    `${relayHttpUrl}/v1/presence/${encodeURIComponent(accountId)}/${encodeURIComponent(machineId)}`,
    { headers: { authorization: `Bearer ${grantJwt}`, accept: "application/json" } },
  );
  const json = (await res.json().catch(() => null)) as { forge_online?: unknown; clients?: unknown } | null;
  if (!res.ok) throw new Error(`Presence check failed (${res.status}).`);
  return { forgeOnline: json?.forge_online === true, clients: typeof json?.clients === "number" ? json.clients : 0 };
}

interface Pending {
  resolve: (r: TunnelResponse) => void;
  reject: (e: Error) => void;
}

/**
 * One browser→Forge session over a single Relay channel. The channel
 * carries the Noise handshake bytes first, then encrypted tunnel calls.
 * Reconnects always start a NEW session (new channel + handshake).
 *
 * Grant refresh: grants live ≤300 s. The session records its grant expiry;
 * the page re-establishes (new grant, new channel, re-handshake) while the
 * browser retains the Core session — see grantExpiresAtMs/needsRefresh and
 * the stream feed's re-subscribe path.
 */
export class ForgeSession {
  private link: RelayLinkLike | null = null;
  private secure: SecureChannel | null = null;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  readonly channel = newChannelId();
  /** Epoch ms when the current grant expires (0 until connected). */
  grantExpiresAtMs = 0;

  constructor(private readonly opts: ForgeSessionOptions) {
  }

  /** True when the grant dies within the margin — re-establish first. */
  needsRefresh(nowMs = Date.now(), marginMs = 90_000): boolean {
    if (!this.grantExpiresAtMs) return false;
    return this.grantExpiresAtMs - nowMs < marginMs;
  }

  /** Issue the short-lived editor grant, admit to Relay, run the Noise handshake. */
  async connect(): Promise<{ forgeOnline: boolean }> {
    if (this.closed) throw new Error("session closed");
    const { core, accountId, machineId } = this.opts;
    const cnf = newEphemeralCnf();
    const issued = await core.issueGrant({
      audience: "ast-relay",
      scope: ["relay:connect", "forge:execute"],
      ttlSeconds: 300,
      targetMachineId: machineId,
      cnf: cnf.jwk,
    });
    this.grantExpiresAtMs = Date.parse(issued.expiresAt);
    if (!Number.isFinite(this.grantExpiresAtMs)) this.grantExpiresAtMs = Date.now() + 300_000;
    const grant: GrantMaterial = { jwt: issued.token, jti: grantJti(issued.token), cnfSk: cnf.sk };
    const forgeCnf = b64uDecode(this.opts.forgeCnfX);
    if (forgeCnf.length !== 32) throw new Error("Forge record has no usable identity key.");
    const ctx = channelCtx(accountId, machineId, this.channel);
    const secure = SecureChannel.initiate(staticKeypairFromSecret(randomBytes(32)), {
      cnfSignKey: cnf.sk,
      expectedForgeCnf: forgeCnf,
      ownGrantJwt: grant.jwt,
      ctx,
    });
    this.secure = secure;
    const events = this.opts.onEvent;
    const makeLink = this.opts.createLink ?? ((url, g, ev) => new EditorLink(url, g, ev, this.opts.wsImpl));
    const link = makeLink(
      `${this.opts.relayWsUrl}/v1/route/${encodeURIComponent(accountId)}/${encodeURIComponent(machineId)}`,
      grant,
      {
        onChannelOpened: (channel, peer) => {
          if (channel !== this.channel) return;
          events?.({ type: "channel-opened", channel });
          void peer;
          for (const body of secure.pumpOutbound()) link.sendOpaque(channel, body);
        },
        onData: (channel, _seq, body) => {
          if (channel !== this.channel) return;
          try {
            const app = secure.handleIncoming(body);
            // Flush twice: the first pump may complete our handshake turn
            // (m3), which synchronously queues our confirm — the second
            // flush carries it. Without this the initiator's confirm
            // sits unsent and the channel never opens.
            for (const out of secure.pumpOutbound()) link.sendOpaque(channel, out);
            for (const out of secure.pumpOutbound()) link.sendOpaque(channel, out);
            if (app) this.onAppBytes(app);
          } catch (e) {
            events?.({ type: "error", code: "channel_failed", message: e instanceof Error ? e.message : "Channel failed." });
            this.close();
          }
        },
        onChannelClosed: (channel, reason) => {
          if (channel === this.channel) {
            events?.({ type: "channel-closed", channel, reason });
            this.failPending(new Error(`Channel closed (${reason}).`));
          }
        },
        onPresence: (forgeOnline, clients) => events?.({ type: "presence", forgeOnline, clients }),
        onAck: () => this.onAck(),
        onError: (code, message) => {
          // A dropped sealed frame desyncs the Noise stream: fail the
          // session explicitly (caller re-handshakes) instead of
          // truncating or resending ciphertext out of order.
          if (code === "backpressure") {
            this.failPending(new Error("Relay window full; channel broken, reconnect to retry."));
            this.close();
            return;
          }
          events?.({ type: "error", code, message });
        },
      },
    );
    this.link = link;
    const { forgeOnline } = await link.connect();
    events?.({ type: "ready", forgeOnline });
    link.open(this.channel);
    for (const body of secure.pumpOutbound()) link.sendOpaque(this.channel, body);
    // Wait for the Noise handshake + mutual confirm, not just Relay
    // admission: callers may tunnel immediately after connect().
    await this.waitOpen(30_000);
    return { forgeOnline };
  }

  private waitOpen(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.closed) return reject(new Error("Session closed while opening."));
        if (this.secure?.isOpen()) return resolve();
        if (Date.now() > deadline) return reject(new Error("Encrypted channel did not open."));
        setTimeout(check, 25);
      };
      check();
    });
  }

  /** Unary tunnel call. Large bodies chunk; large answers reassemble.
   *  Resolves with the Forge response or throws. */
  async call(req: Omit<TunnelRequest, "id"> & { id?: string }): Promise<TunnelResponse> {
    const link = this.link;
    const secure = this.secure;
    if (!link || !secure) throw new Error("Not connected.");
    if (!secure.isOpen()) throw new Error("Encrypted channel is not open yet.");
    if (this.closed) throw new Error("Session closed.");
    const full: TunnelRequest = { ...req, id: req.id ?? newRequestId() };
    return new Promise<TunnelResponse>((resolve, reject) => {
      this.pending.set(full.id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(full.id)) {
          this.reassembly.delete(full.id);
          reject(new Error("Forge did not answer in time."));
        }
      }, 60_000);
      void (async () => {
        try {
          const texts = this.requestTexts(full);
          for (const text of texts) {
            const secureNow = this.secure;
            if (!secureNow) throw new Error("Not connected.");
            await this.sender.send(secureNow, text);
          }
        } catch (e) {
          clearTimeout(timer);
          if (this.pending.delete(full.id)) {
            this.reassembly.delete(full.id);
            reject(e instanceof Error ? e : new Error("Send failed."));
          } else if (this.isChannelBreak(e)) {
            this.failPending(e instanceof Error ? e : new Error("Send failed."));
            this.close();
          }
        }
      })();
    });
  }

  private readonly reassembly = new Map<string, ChunkReassembly>();
  private readonly sender: PacedSender = new PacedSender(
    () => this.link,
    this.channel,
    () => this.closed,
  );

  private onAck(): void {
    this.sender.onAck();
  }

  /** Request plaintexts in send order (single frame or chunk frames). */
  private requestTexts(full: TunnelRequest): string[] {
    const framed = encodeTunnelRequest(full);
    if (new TextEncoder().encode(framed).length <= SINGLE_FRAME_BYTES) return [framed];
    const raw = new TextEncoder().encode(framed);
    return chunkBytes(full.id, raw).map((c) => JSON.stringify(c));
  }

  private isChannelBreak(e: unknown): boolean {
    return (
      e instanceof SendTimeoutError ||
      (e instanceof Error && /closed|loss|channel|did not answer/i.test(e.message))
    );
  }

  private onAppBytes(app: Uint8Array): void {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(app));
    } catch {
      this.opts.onEvent?.({ type: "error", code: "bad_frame", message: "Forge answered with an unreadable frame." });
      return;
    }
    try {
      if (isChunkFrame(json)) {
        const chunk = Schema.decodeUnknownSync(TunnelChunk)(json);
        let asm = this.reassembly.get(chunk.transfer);
        if (!asm) {
          asm = new ChunkReassembly();
          this.reassembly.set(chunk.transfer, asm);
        }
        const res = asm.feed(chunk);
        if (!res.done) return;
        this.reassembly.delete(chunk.transfer);
        this.onResponseBytes(res.bytes);
        return;
      }
      this.onResponseJson(json);
    } catch (e) {
      this.reassembly.delete((json as { transfer?: string }).transfer ?? "");
      this.opts.onEvent?.({
        type: "error",
        code: "bad_chunks",
        message: e instanceof Error ? e.message : "Chunked transfer failed.",
      });
    }
  }

  private onResponseBytes(raw: Uint8Array): void {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      this.opts.onEvent?.({ type: "error", code: "bad_frame", message: "Reassembled an unreadable response." });
      return;
    }
    this.onResponseJson(json);
  }

  private onResponseJson(json: unknown): void {
    let res: TunnelResponse;
    try {
      res = decodeTunnelResponse(json);
    } catch {
      this.opts.onEvent?.({ type: "error", code: "bad_frame", message: "Forge answered with an unreadable frame." });
      return;
    }
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    try {
      p.resolve(throwIfTunnelError(res));
    } catch (e) {
      p.reject(e instanceof Error ? e : new Error("Forge call failed."));
    }
  }

  private failPending(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.reassembly.clear();
  }

  close(): void {
    this.closed = true;
    this.failPending(new Error("Session closed."));
    try {
      this.link?.closeChannel(this.channel, "bye");
    } catch {
      // ignore
    }
    this.link?.close();
    this.link = null;
    this.secure?.destroy();
    this.secure = null;
  }
}

/** Read the grant `jti` for Relay admission (verified server-side). */
function grantJti(jwt: string): string {
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(jwt.split(".")[1] ?? ""))) as { jti?: unknown };
    if (typeof payload.jti === "string" && payload.jti.length > 0) return payload.jti;
  } catch {
    // fall through to the throw below
  }
  throw new Error("Unreadable grant: cannot admit to Relay.");
}

/**
 * Ordered, ack-paced outbound funnel (single place that touches
 * sendAcked). Semantics mirror SecureChannel.sendApp (exact pre-seal
 * sizing via sealedFrameSize, throws-before-consume on a full window,
 * seal + sendAcked one frame at a time):
 * - WouldBlock pauses for the next recipient ack (nothing sealed, safe to
 *   retry) instead of dropping ciphertext;
 * - any post-seal failure (timeout/close/loss) breaks the Noise stream, so
 *   callers fail the session closed and re-handshake — never retry
 *   ciphertext, never skip the Noise sequence.
 * Sends serialize on a mutex: one in-flight sequence per channel. All
 * waiting happens OUTSIDE the incoming-data handler so the ACK read loop
 * keeps draining while sends stall.
 */
export class PacedSender {
  private mutex: Promise<void> = Promise.resolve();
  private waiters: Array<() => void> = [];

  constructor(
    private readonly linkOf: () => RelayLinkLike | null,
    private readonly channel: string,
    private readonly closed: () => boolean,
  ) {}

  onAck(): void {
    for (const w of this.waiters.splice(0, this.waiters.length)) w();
  }

  async send(secure: SecureChannel, text: string): Promise<void> {
    const run = this.mutex.then(async () => {
      const link = this.linkOf();
      if (!link) throw new Error("Not connected.");
      for (;;) {
        if (this.closed()) throw new Error("Session closed.");
        const pt = new TextEncoder().encode(text);
        try {
          if (!link.willFit(this.channel, sealedFrameSize(this.channel, pt.length))) {
            throw new SendWouldBlockError();
          }
          const { ct } = secure.noise.seal(pt);
          await link.sendAcked(this.channel, ct, { timeoutMs: 30_000 });
          return;
        } catch (e) {
          if (e instanceof SendWouldBlockError && !this.closed()) {
            await this.waitForAck(30_000);
            continue;
          }
          throw e;
        }
      }
    });
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private waitForAck(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SendTimeoutError()), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export interface ForgeStreamEvents {
  onEnvelope(env: LiveEnvelope): void;
  /** Reset envelope (lagged broadcast / full queue): re-subscribe from cursor. */
  onReset(): void;
  onEnd(reason: string): void;
  onError(code: string, message: string): void;
}

export interface ForgeStreamOptions extends ForgeSessionOptions {
  events: ForgeStreamEvents;
}

/**
 * One live event subscription over a DEDICATED Relay channel with its own
 * Noise session (wire doc §6) — unary calls proceed concurrently on the
 * main session channel. SUBSCRIBE answers with a normal TunnelResponse
 * carrying {"$stream": {"stream": id}}; envelopes then arrive as
 * {"$event": {"stream": id, "envelope": {...}}} (chunked when oversized).
 * UNSUBSCRIBE ends one stream; closing the Relay channel cancels it.
 */
export class ForgeStream {
  private link: RelayLinkLike | null = null;
  private secure: SecureChannel | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly reassembly = new Map<string, ChunkReassembly>();
  private closed = false;
  private streamId: string | null = null;
  private subscribeId: string | null = null;
  readonly channel = newChannelId();
  grantExpiresAtMs = 0;

  constructor(private readonly opts: ForgeStreamOptions) {
  }

  needsRefresh(nowMs = Date.now(), marginMs = 90_000): boolean {
    if (!this.grantExpiresAtMs) return false;
    return this.grantExpiresAtMs - nowMs < marginMs;
  }

  /** Open the channel, handshake, and SUBSCRIBE. Resolves with the stream id. */
  async start(subscribePath: string): Promise<string> {
    if (this.closed) throw new Error("stream closed");
    const { core, accountId, machineId } = this.opts;
    const cnf = newEphemeralCnf();
    const issued = await core.issueGrant({
      audience: "ast-relay",
      scope: ["relay:connect", "forge:execute"],
      ttlSeconds: 300,
      targetMachineId: machineId,
      cnf: cnf.jwk,
    });
    this.grantExpiresAtMs = Date.parse(issued.expiresAt);
    if (!Number.isFinite(this.grantExpiresAtMs)) this.grantExpiresAtMs = Date.now() + 300_000;
    const grant: GrantMaterial = { jwt: issued.token, jti: grantJti(issued.token), cnfSk: cnf.sk };
    const forgeCnf = b64uDecode(this.opts.forgeCnfX);
    if (forgeCnf.length !== 32) throw new Error("Forge record has no usable identity key.");
    const ctx = channelCtx(accountId, machineId, this.channel);
    const secure = SecureChannel.initiate(staticKeypairFromSecret(randomBytes(32)), {
      cnfSignKey: cnf.sk,
      expectedForgeCnf: forgeCnf,
      ownGrantJwt: grant.jwt,
      ctx,
    });
    this.secure = secure;
    const events = this.opts.events;
    const makeLink = this.opts.createLink ?? ((url, g, ev) => new EditorLink(url, g, ev, this.opts.wsImpl));
    const link = makeLink(
      `${this.opts.relayWsUrl}/v1/route/${encodeURIComponent(accountId)}/${encodeURIComponent(machineId)}`,
      grant,
      {
        onChannelOpened: (channel) => {
          if (channel !== this.channel) return;
          for (const body of secure.pumpOutbound()) link.sendOpaque(channel, body);
        },
        onData: (channel, _seq, body) => {
          if (channel !== this.channel) return;
          try {
            const app = secure.handleIncoming(body);
            // Double flush (see ForgeSession): the first pump may complete
            // our handshake turn and queue our confirm synchronously.
            for (const out of secure.pumpOutbound()) link.sendOpaque(channel, out);
            for (const out of secure.pumpOutbound()) link.sendOpaque(channel, out);
            if (app) this.onAppBytes(app);
          } catch (e) {
            events.onError("channel_failed", e instanceof Error ? e.message : "Channel failed.");
            this.close();
          }
        },
        onChannelClosed: (channel, reason) => {
          if (channel === this.channel) {
            events.onEnd(`channel closed (${reason})`);
            this.close();
          }
        },
        onPresence: () => undefined,
        onAck: () => this.onStreamAck(),
        onError: (code, message) => {
          if (code === "backpressure") {
            events.onError(code, "Relay window full; stream broken, resubscribe on a new channel.");
            this.close();
            return;
          }
          events.onError(code, message);
        },
      },
    );
    this.link = link;
    await link.connect();
    link.open(this.channel);
    for (const body of secure.pumpOutbound()) link.sendOpaque(this.channel, body);
    await this.waitOpen(30_000);
    this.subscribeId = newRequestId();
    const res = await this.callOnce({ method: "SUBSCRIBE", path: subscribePath, id: this.subscribeId });
    const started = asStreamStart(throwIfTunnelError(res).body);
    if (!started) throw new Error("Forge did not open a stream (no $stream start).");
    this.streamId = started.$stream.stream;
    return this.streamId;
  }

  private waitOpen(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.closed) return reject(new Error("Stream closed while opening."));
        if (this.secure?.isOpen()) return resolve();
        if (Date.now() > deadline) return reject(new Error("Encrypted stream channel did not open."));
        setTimeout(check, 25);
      };
      check();
    });
  }

  private readonly sender: PacedSender = new PacedSender(
    () => this.link,
    this.channel,
    () => this.closed,
  );

  private onStreamAck(): void {
    this.sender.onAck();
  }

  private callOnce(req: { method: "SUBSCRIBE"; path: string; id: string }): Promise<TunnelResponse> {
    const full: TunnelRequest = { ...req };
    encodeTunnelRequest(full);
    return new Promise<TunnelResponse>((resolve, reject) => {
      this.pending.set(full.id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(full.id)) reject(new Error("Forge did not answer SUBSCRIBE."));
      }, 30_000);
      void (async () => {
        try {
          const secure = this.secure;
          if (!secure) throw new Error("Not connected.");
          await this.sender.send(secure, encodeTunnelRequest(full));
        } catch (e) {
          clearTimeout(timer);
          if (this.pending.delete(full.id)) reject(e instanceof Error ? e : new Error("SUBSCRIBE send failed."));
        }
      })();
    });
  }

  private onAppBytes(app: Uint8Array): void {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(app));
    } catch {
      this.opts.events.onError("bad_frame", "Forge sent an unreadable stream frame.");
      return;
    }
    try {
      if (isChunkFrame(json)) {
        const chunk = Schema.decodeUnknownSync(TunnelChunk)(json);
        let asm = this.reassembly.get(chunk.transfer);
        if (!asm) {
          asm = new ChunkReassembly();
          this.reassembly.set(chunk.transfer, asm);
        }
        const out = asm.feed(chunk);
        if (!out.done) return;
        this.reassembly.delete(chunk.transfer);
        this.onAppJson(JSON.parse(new TextDecoder().decode(out.bytes)));
        return;
      }
      this.onAppJson(json);
    } catch (e) {
      this.reassembly.delete((json as { transfer?: string }).transfer ?? "");
      this.opts.events.onError("bad_chunks", e instanceof Error ? e.message : "Chunked stream frame failed.");
    }
  }

  private onAppJson(json: unknown): void {
    const events = this.opts.events;
    const started = asStreamStart(json);
    if (started) return; // tolerate stray start repeats
    const ev = asStreamEvent(json);
    if (ev) {
      if (ev.$event.stream !== this.streamId && this.streamId !== null) return;
      if (typeof ev.$event.end === "string") {
        events.onEnd(ev.$event.end);
        this.close();
        return;
      }
      if (ev.$event.envelope !== undefined) {
        const env = asLiveEnvelope(ev.$event.envelope);
        if (env) {
          if (env.type === "Reset") events.onReset();
          else events.onEnvelope(env);
        }
      }
      return;
    }
    // Plain TunnelResponse: the SUBSCRIBE answer (or UNSUBSCRIBE ack).
    let res: TunnelResponse;
    try {
      res = decodeTunnelResponse(json);
    } catch {
      events.onError("bad_frame", "Forge sent an unreadable stream frame.");
      return;
    }
    const p = res.id ? this.pending.get(res.id) : undefined;
    if (!p) return;
    this.pending.delete(res.id);
    try {
      p.resolve(throwIfTunnelError(res));
    } catch (e) {
      p.reject(e instanceof Error ? e : new Error("SUBSCRIBE failed."));
    }
  }

  /** UNSUBSCRIBE best-effort, then close the channel and destroy keys. */
  stop(): void {
    if (!this.closed && this.streamId && this.secure?.isOpen()) {
      const secure = this.secure;
      const text = JSON.stringify({ id: newRequestId(), method: "UNSUBSCRIBE", path: `/events/${this.streamId}` });
      // Best effort on a closing channel: skip when the window is full
      // rather than consuming a nonce for a farewell nobody needs.
      void (async () => {
        try {
          await this.sender.send(secure, text);
        } catch {
          // ignore: the channel close below carries the same meaning
        }
      })();
    }
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("Stream closed."));
    this.pending.clear();
    this.reassembly.clear();
    try {
      this.link?.closeChannel(this.channel, "bye");
    } catch {
      // ignore
    }
    this.link?.close();
    this.link = null;
    this.secure?.destroy();
    this.secure = null;
  }
}
