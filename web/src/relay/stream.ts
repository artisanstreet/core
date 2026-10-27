// One live event subscription over a DEDICATED Relay channel with its own
// Noise session (wire doc §6) — unary calls proceed concurrently on the
// main session channel. SUBSCRIBE answers with a normal TunnelResponse
// carrying {"$stream": {"stream": id}}; envelopes then arrive as
// {"$event": {"stream": id, "envelope": {...}}} (chunked when oversized).
// UNSUBSCRIBE ends one stream; closing the Relay channel cancels it.

import { Deferred, Effect, Schema } from "effect";
import { run_effect } from "../core/run-promise.ts";
import type { SecureChannel } from "../../vendor/relay/client.ts";
import {
  decodeTunnelResponse,
  encodeTunnelRequest,
  newRequestId,
  throwIfTunnelError,
  type TunnelRequest,
  type TunnelResponse,
} from "../forge/codec.ts";
import { ChunkReassembly, isChunkFrame, TunnelChunk } from "../forge/chunk.ts";
import { asLiveEnvelope, asStreamEvent, asStreamStart, type LiveEnvelope } from "../forge/stream-frames.ts";
import { newChannelId } from "./cnf.ts";
import { channel_url, default_link_factory, flush_outbound, initiate_secure, mint_channel_grant_effect, wait_open_effect } from "./channel-connect.ts";
import { PacedSender } from "./paced-sender.ts";
import type { ForgeSessionOptions } from "./session.ts";

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

interface StreamPending {
  gate: Deferred.Deferred<TunnelResponse, Error>;
}

export class ForgeStream {
  private link: import("./transport.ts").RelayLinkLike | null = null;
  private secure: SecureChannel | null = null;
  private readonly pending = new Map<string, StreamPending>();
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
    const self = this;
    return run_effect(
      Effect.gen(function* () {
        const { core, accountId, machineId } = self.opts;
        const minted = yield* mint_channel_grant_effect(core, machineId);
        const grant = minted.grant;
        self.grantExpiresAtMs = minted.grant_expires_at_ms;
        const secure = yield* Effect.try({
          try: () =>
            initiate_secure(minted.cnf_sk, self.opts.forgeCnfX, grant.jwt, {
              account: accountId,
              machine: machineId,
              channel: self.channel,
            }),
          catch: (e) => (e instanceof Error ? e : new Error("Channel setup failed.")),
        });
        self.secure = secure;
        const events = self.opts.events;
        const makeLink = self.opts.createLink ?? default_link_factory(self.opts.wsImpl);
        const link = makeLink(
          channel_url(self.opts.relayWsUrl, accountId, machineId),
          grant,
          {
            onChannelOpened: (channel) => {
              if (channel !== self.channel) return;
              flush_outbound(secure, (body) => link.sendOpaque(channel, body));
            },
            onData: (channel, _seq, body) => {
              if (channel !== self.channel) return;
              try {
                const app = secure.handleIncoming(body);
                flush_outbound(secure, (out) => link.sendOpaque(channel, out));
                flush_outbound(secure, (out) => link.sendOpaque(channel, out));
                if (app) self.onAppBytes(app);
              } catch (e) {
                events.onError("channel_failed", e instanceof Error ? e.message : "Channel failed.");
                self.close();
              }
            },
            onChannelClosed: (channel, reason) => {
              if (channel === self.channel) {
                events.onEnd(`channel closed (${reason})`);
                self.close();
              }
            },
            onPresence: () => undefined,
            onAck: () => self.onStreamAck(),
            onError: (code, message) => {
              if (code === "backpressure") {
                events.onError(code, "Relay window full; stream broken, resubscribe on a new channel.");
                self.close();
                return;
              }
              events.onError(code, message);
            },
          },
        );
        self.link = link;
        yield* Effect.tryPromise({
          try: () => link.connect(),
          catch: (e) => (e instanceof Error ? e : new Error("Relay admission failed.")),
        });
        link.open(self.channel);
        flush_outbound(secure, (body) => link.sendOpaque(self.channel, body));
        yield* wait_open_effect(
          () => self.secure?.isOpen(),
          () => self.closed,
          "Stream closed while opening.",
          "Encrypted stream channel did not open.",
          30_000,
        );
        self.subscribeId = newRequestId();
        const res = yield* self.call_once_effect({ method: "SUBSCRIBE", path: subscribePath, id: self.subscribeId });
        const started = asStreamStart(throwIfTunnelError(res).body);
        if (!started) return yield* Effect.fail(new Error("Forge did not open a stream (no $stream start)."));
        self.streamId = started.$stream.stream;
        return self.streamId;
      }),
    );
  }

  private readonly sender: PacedSender = new PacedSender(
    () => this.link,
    this.channel,
    () => this.closed,
  );

  private onStreamAck(): void {
    this.sender.onAck();
  }

  private call_once_effect(req: { method: "SUBSCRIBE"; path: string; id: string }): Effect.Effect<TunnelResponse, Error> {
    const full: TunnelRequest = { ...req };
    encodeTunnelRequest(full);
    const self = this;
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<TunnelResponse, Error>();
      self.pending.set(full.id, { gate });
      try {
        const secure = self.secure;
        if (!secure) return yield* Effect.fail(new Error("Not connected."));
        yield* self.sender.send_effect(secure, encodeTunnelRequest(full));
        return yield* Deferred.await(gate).pipe(
          Effect.timeoutFail({
            duration: "30 seconds",
            onTimeout: () => new Error("Forge did not answer SUBSCRIBE."),
          }),
        );
      } finally {
        self.pending.delete(full.id);
      }
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
    if (started) return;
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
      const ok = throwIfTunnelError(res);
      Deferred.unsafeDone(p.gate, Effect.succeed(ok));
    } catch (e) {
      Deferred.unsafeDone(p.gate, Effect.fail(e instanceof Error ? e : new Error("SUBSCRIBE failed.")));
    }
  }

  /** UNSUBSCRIBE best-effort, then close the channel and destroy keys. */
  stop(): void {
    if (!this.closed && this.streamId && this.secure?.isOpen()) {
      const secure = this.secure;
      const text = JSON.stringify({ id: newRequestId(), method: "UNSUBSCRIBE", path: `/events/${this.streamId}` });
      // Best effort on a closing channel: skip when the window is full
      // rather than consuming a nonce for a farewell nobody needs.
      void run_effect(this.sender.send_effect(secure, text)).catch(() => undefined);
    }
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) Deferred.unsafeDone(p.gate, Effect.fail(new Error("Stream closed.")));
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
