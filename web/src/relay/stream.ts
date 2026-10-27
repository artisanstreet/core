// One live event subscription over a DEDICATED Relay channel with its own
// Noise session (wire doc §6) — unary calls proceed concurrently on the
// main session channel. SUBSCRIBE answers with a normal TunnelResponse
// carrying {"$stream": {"stream": id}}; envelopes then arrive as
// {"$event": {"stream": id, "envelope": {...}}} (chunked when oversized).
// UNSUBSCRIBE ends one stream; closing the Relay channel cancels it.

import { Deferred, Effect, Either, Match, Schema } from "effect";
import { run_effect } from "../core/run-promise.ts";
import type { SecureChannel } from "../../vendor/relay/client.ts";
import {
  encode_tunnel_request,
  new_request_id,
  throw_if_tunnel_error,
  TunnelResponse,
  type TunnelRequest,
} from "../forge/codec.ts";
import { ChunkReassembly, type TunnelChunk } from "../forge/chunk.ts";
import { decode_app_message, type AppMessage } from "../forge/app-message.ts";
import { as_live_envelope, as_stream_event, as_stream_start, type LiveEnvelope } from "../forge/stream-frames.ts";
import { new_channel_id } from "./cnf.ts";
import { channel_url, default_link_factory, flush_outbound, initiate_secure, mint_channel_grant_effect, settle_pending, wait_open_effect } from "./channel-connect.ts";
import { PacedSender } from "./paced-sender.ts";
import type { ForgeSessionOptions } from "./session.ts";
import type { PendingGate } from "./transport.ts";

export interface ForgeStreamEvents {
  on_envelope(env: LiveEnvelope): void;
  /** Reset envelope (lagged broadcast / full queue): re-subscribe from cursor. */
  on_reset(): void;
  on_end(reason: string): void;
  on_error(code: string, message: string): void;
}

export interface ForgeStreamOptions extends ForgeSessionOptions {
  events: ForgeStreamEvents;
}

export class ForgeStream {
  private link: import("./transport.ts").RelayLinkLike | null = null;
  private secure: SecureChannel | null = null;
  private readonly pending = new Map<string, PendingGate>();
  private readonly reassembly = new Map<string, ChunkReassembly>();
  private closed = false;
  private stream_id: string | null = null;
  private subscribe_id: string | null = null;
  readonly channel = new_channel_id();
  grant_expires_at_ms = 0;

  constructor(private readonly opts: ForgeStreamOptions) {
  }

  needs_refresh(now_ms = Date.now(), margin_ms = 90_000): boolean {
    if (!this.grant_expires_at_ms) return false;
    return this.grant_expires_at_ms - now_ms < margin_ms;
  }

  /** Open the channel, handshake, and SUBSCRIBE. Resolves with the stream id. */
  async start(subscribe_path: string): Promise<string> {
    if (this.closed) throw new Error("stream closed");
    const self = this;
    const start_program = Effect.gen(function* () {
        const { core, account_id, machine_id } = self.opts;
        const minted = yield* mint_channel_grant_effect(core, machine_id);
        const grant = minted.grant;
        self.grant_expires_at_ms = minted.grant_expires_at_ms;
        const secure = yield* initiate_secure(minted.cnf_sk, self.opts.forge_cnf_x, grant.jwt, {
          account: account_id,
          machine: machine_id,
          channel: self.channel,
        });
        self.secure = secure;
        const events = self.opts.events;
        const make_link = self.opts.create_link ?? default_link_factory(self.opts.ws_impl);
        const link = make_link(
          channel_url(self.opts.relay_ws_url, account_id, machine_id),
          grant,
          {
            on_channel_opened: (channel) => {
              if (channel !== self.channel) return;
              flush_outbound(secure, (body) => link.send_opaque(channel, body));
            },
            on_data: (channel, _seq, body) => {
              if (channel !== self.channel) return;
              Either.match(
                Either.try({
                  try: () => secure.handle_incoming(body),
                  catch: (e) => (e instanceof Error ? e : new Error("Channel failed.")),
                }),
                {
                  onLeft: (e) => {
                    events.on_error("channel_failed", e.message);
                    self.close();
                  },
                  onRight: (app) => {
                    flush_outbound(secure, (out) => link.send_opaque(channel, out));
                    flush_outbound(secure, (out) => link.send_opaque(channel, out));
                    if (app) self.on_app_bytes(app);
                  },
                },
              );
            },
            on_channel_closed: (channel, reason) => {
              if (channel === self.channel) {
                events.on_end(`channel closed (${reason})`);
                self.close();
              }
            },
            on_presence: () => undefined,
            on_ack: () => self.on_stream_ack(),
            on_error: (code, message) => {
              if (code === "backpressure") {
                events.on_error(code, "Relay window full; stream broken, resubscribe on a new channel.");
                self.close();
                return;
              }
              events.on_error(code, message);
            },
          },
        );
        self.link = link;
        yield* Effect.tryPromise({
          try: () => link.connect(),
          catch: (e) => (e instanceof Error ? e : new Error("Relay admission failed.")),
        });
        link.open(self.channel);
        flush_outbound(secure, (body) => link.send_opaque(self.channel, body));
        yield* wait_open_effect(
          () => self.secure?.is_open(),
          () => self.closed,
          "Stream closed while opening.",
          "Encrypted stream channel did not open.",
          30_000,
        );
        self.subscribe_id = new_request_id();
        const res = yield* self.call_once_effect({ method: "SUBSCRIBE", path: subscribe_path, id: self.subscribe_id });
        const started_body = yield* Effect.try({
          try: () => throw_if_tunnel_error(res).body,
          catch: (e) => (e instanceof Error ? e : new Error("Forge did not open a stream.")),
        });
        const started = as_stream_start(started_body);
        if (!started) return yield* Effect.fail(new Error("Forge did not open a stream (no $stream start)."));
        self.stream_id = started.$stream.stream;
        return self.stream_id;
      });
    return run_effect(start_program);
  }

  private readonly sender: PacedSender = new PacedSender(
    () => this.link,
    this.channel,
    () => this.closed,
  );

  private on_stream_ack(): void {
    this.sender.on_ack();
  }

  private call_once_effect(req: { method: "SUBSCRIBE"; path: string; id: string }) {
    const self = this;
    return Effect.acquireUseRelease(
      Effect.map(
        Deferred.make<TunnelResponse, Error>(),
        (gate) => {
          const full: TunnelRequest = { ...req };
          self.pending.set(full.id, { gate });
          return { full, gate };
        },
      ),
      ({ full, gate }) =>
        Effect.gen(function* () {
          const secure = self.secure;
          if (!secure) return yield* Effect.fail(new Error("Not connected."));
          const encoded = yield* Effect.try({
            try: () => encode_tunnel_request(full),
            catch: (e) => (e instanceof Error ? e : new Error("SUBSCRIBE send failed.")),
          });
          yield* self.sender.send_effect(secure, encoded);
          return yield* Deferred.await(gate).pipe(
            Effect.timeoutFail({
              duration: "30 seconds",
              onTimeout: () => new Error("Forge did not answer SUBSCRIBE."),
            }),
          );
        }),
      ({ full }) =>
        Effect.sync(() => {
          self.pending.delete(full.id);
        }),
    );
  }

  private on_app_bytes(app: Uint8Array): void {
    const text = new TextDecoder().decode(app);
    const message: AppMessage = Either.getOrElse(
      Either.map(Schema.decodeUnknownEither(Schema.parseJson())(text), decode_app_message),
      (): AppMessage => ({ _tag: "BadFrame" }),
    );
    return Match.value(message).pipe(
      Match.tag("Chunk", ({ chunk }) => this.feed_chunk(chunk)),
      Match.tag("BadChunk", ({ transfer, reason }) => {
        this.reassembly.delete(transfer);
        this.opts.events.on_error("bad_chunks", reason);
      }),
      Match.tag("Response", ({ response }) => this.on_app_json(response)),
      Match.tag("BadFrame", () => {
        this.opts.events.on_error("bad_frame", "Forge sent an unreadable stream frame.");
      }),
      Match.exhaustive,
    );
  }

  private feed_chunk(chunk: TunnelChunk): void {
    let asm = this.reassembly.get(chunk.transfer);
    if (!asm) {
      asm = new ChunkReassembly();
      this.reassembly.set(chunk.transfer, asm);
    }
    Either.match(
      Either.try({
        try: () => asm.feed(chunk),
        catch: (e) => (e instanceof Error ? e : new Error("Chunked stream frame failed.")),
      }),
      {
        onLeft: (e) => {
          this.reassembly.delete(chunk.transfer);
          this.opts.events.on_error("bad_chunks", e.message);
        },
        onRight: (out) => {
          if (!out.done) return;
          this.reassembly.delete(chunk.transfer);
          this.on_app_json_bytes(out.bytes);
        },
      },
    );
  }

  private on_app_json_bytes(raw: Uint8Array): void {
    const text = new TextDecoder().decode(raw);
    const message: AppMessage = Either.getOrElse(
      Either.map(Schema.decodeUnknownEither(Schema.parseJson())(text), decode_app_message),
      (): AppMessage => ({ _tag: "BadFrame" }),
    );
    return Match.value(message).pipe(
      Match.tag("Response", ({ response }) => this.on_app_json(response)),
      Match.orElse(() => {
        this.opts.events.on_error("bad_frame", "Forge sent an unreadable stream frame.");
      }),
    );
  }

  private on_app_json(json: unknown): void {
    const events = this.opts.events;
    const started = as_stream_start(json);
    if (started) return;
    const ev = as_stream_event(json);
    if (ev) {
      if (ev.$event.stream !== this.stream_id && this.stream_id !== null) return;
      if (typeof ev.$event.end === "string") {
        events.on_end(ev.$event.end);
        this.close();
        return;
      }
      if (ev.$event.envelope !== undefined) {
        const env = as_live_envelope(ev.$event.envelope);
        if (env) {
          if (env.type === "Reset") events.on_reset();
          else events.on_envelope(env);
        }
      }
      return;
    }
    const decoded = Schema.decodeUnknownEither(TunnelResponse)(json);
    Either.match(decoded, {
      onLeft: () => events.on_error("bad_frame", "Forge sent an unreadable stream frame."),
      onRight: (res) => settle_pending(this.pending, res, "SUBSCRIBE failed."),
    });
  }

  /** UNSUBSCRIBE best-effort, then close the channel and destroy keys. */
  stop(): void {
    if (!this.closed && this.stream_id && this.secure?.is_open()) {
      const secure = this.secure;
      const text = JSON.stringify({ id: new_request_id(), method: "UNSUBSCRIBE", path: `/events/${this.stream_id}` });
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
    // Best-effort channel farewell: a gone socket must not fail close.
    Either.getOrNull(
      Either.try({
        try: () => this.link?.close_channel(this.channel, "bye"),
        catch: () => null,
      }),
    );
    this.link?.close();
    this.link = null;
    this.secure?.destroy();
    this.secure = null;
  }
}
