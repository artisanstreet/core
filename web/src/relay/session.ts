// One browser→Forge session over a single Relay channel. The channel
// carries the Noise handshake bytes first, then encrypted tunnel calls.
// Reconnects always start a NEW session (new channel + handshake).
//
// Grant refresh: grants live ≤300 s. The session records its grant expiry;
// the page re-establishes (new grant, new channel, re-handshake) while the
// browser retains the Core session.

import { Deferred, Effect, Either, Match, Schema } from "effect";
import { SendTimeoutError } from "../../vendor/relay/client.ts";
import type { SecureChannel } from "../../vendor/relay/client.ts";
import type { GrantMaterial } from "../../vendor/relay/client.ts";
import type { CoreApi } from "../api.ts";
import {
  encodeTunnelRequest,
  newRequestId,
  SINGLE_FRAME_BYTES,
  throwIfTunnelError,
  type TunnelRequest,
  type TunnelResponse,
} from "../forge/codec.ts";
import { ChunkReassembly, chunkBytes, type TunnelChunk } from "../forge/chunk.ts";
import { decode_app_message, type AppMessage } from "../forge/app-message.ts";
import { newChannelId } from "./cnf.ts";
import { channel_url, default_link_factory, flush_outbound, initiate_secure, mint_channel_grant_effect, settle_pending, wait_open_effect } from "./channel-connect.ts";
export { grant_jti } from "./cnf.ts";
import { run_effect } from "../core/run-promise.ts";
import { PacedSender } from "./paced-sender.ts";
import type { ChannelEvents, ForgeSessionEvent, PendingGate, RelayLinkLike } from "./transport.ts";

export type { ChannelEvents, ForgeSessionEvent, RelayLinkLike };
export type SendStatus = "sent" | "dropped-window-full";

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


class CallTimeoutError extends Error {
  constructor() {
    super("Forge did not answer in time.");
    this.name = "CallTimeoutError";
  }
}

export class ForgeSession {
  private link: RelayLinkLike | null = null;
  private secure: SecureChannel | null = null;
  private readonly pending = new Map<string, PendingGate>();
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
    const self = this;
    const connect_program = Effect.gen(function* () {
        const { core, accountId, machineId } = self.opts;
        const minted = yield* mint_channel_grant_effect(core, machineId);
        self.grantExpiresAtMs = minted.grant_expires_at_ms;
        const grant = minted.grant;
        const secure = yield* initiate_secure(minted.cnf_sk, self.opts.forgeCnfX, grant.jwt, {
          account: accountId,
          machine: machineId,
          channel: self.channel,
        });
        self.secure = secure;
        const events = self.opts.onEvent;
        const makeLink = self.opts.createLink ?? default_link_factory(self.opts.wsImpl);
        const link = makeLink(
          channel_url(self.opts.relayWsUrl, accountId, machineId),
          grant,
          {
            onChannelOpened: (channel, peer) => {
              if (channel !== self.channel) return;
              events?.({ type: "channel-opened", channel });
              void peer;
              flush_outbound(secure, (body) => link.sendOpaque(channel, body));
            },
            onData: (channel, _seq, body) => {
              if (channel !== self.channel) return;
              Either.match(
                Either.try({
                  try: () => secure.handleIncoming(body),
                  catch: (e) => (e instanceof Error ? e : new Error("Channel failed.")),
                }),
                {
                  onLeft: (e) => {
                    events?.({ type: "error", code: "channel_failed", message: e.message });
                    self.close();
                  },
                  onRight: (app) => {
                    // Flush twice: the first pump may complete our handshake turn
                    // (m3), which synchronously queues our confirm — the second
                    // flush carries it. Without this the initiator's confirm
                    // sits unsent and the channel never opens.
                    flush_outbound(secure, (out) => link.sendOpaque(channel, out));
                    flush_outbound(secure, (out) => link.sendOpaque(channel, out));
                    if (app) self.onAppBytes(app);
                  },
                },
              );
            },
            onChannelClosed: (channel, reason) => {
              if (channel === self.channel) {
                events?.({ type: "channel-closed", channel, reason });
                self.failPending(new Error(`Channel closed (${reason}).`));
              }
            },
            onPresence: (forgeOnline, clients) => events?.({ type: "presence", forgeOnline, clients }),
            onAck: () => self.onAck(),
            onError: (code, message) => {
              // A dropped sealed frame desyncs the Noise stream: fail the
              // session explicitly (caller re-handshakes) instead of
              // truncating or resending ciphertext out of order.
              if (code === "backpressure") {
                self.failPending(new Error("Relay window full; channel broken, reconnect to retry."));
                self.close();
                return;
              }
              events?.({ type: "error", code, message });
            },
          },
        );
        self.link = link;
        const { forgeOnline } = yield* Effect.tryPromise({
          try: () => link.connect(),
          catch: (e) => (e instanceof Error ? e : new Error("Relay admission failed.")),
        });
        events?.({ type: "ready", forgeOnline });
        link.open(self.channel);
        flush_outbound(secure, (body) => link.sendOpaque(self.channel, body));
        // Wait for the Noise handshake + mutual confirm, not just Relay
        // admission: callers may tunnel immediately after connect().
        yield* wait_open_effect(
          () => self.secure?.isOpen(),
          () => self.closed,
          "Session closed while opening.",
          "Encrypted channel did not open.",
          30_000,
        );
        return { forgeOnline };
      });
    return run_effect(connect_program);
  }

  /** Unary tunnel call. Large bodies chunk; large answers reassemble. */
  async call(req: Omit<TunnelRequest, "id"> & { id?: string }): Promise<TunnelResponse> {
    const link = this.link;
    const secure = this.secure;
    if (!link || !secure) throw new Error("Not connected.");
    if (!secure.isOpen()) throw new Error("Encrypted channel is not open yet.");
    if (this.closed) throw new Error("Session closed.");
    const full: TunnelRequest = { ...req, id: req.id ?? newRequestId() };
    const self = this;
    const as_error = (e: unknown) => (e instanceof Error ? e : new Error("Send failed."));
    const call_program = Effect.gen(function* () {
        const gate = yield* Deferred.make<TunnelResponse, Error>();
        self.pending.set(full.id, { gate });
        const texts = yield* Effect.try({
          try: () => self.request_texts(full),
          catch: as_error,
        });
        yield* Effect.forEach(
          texts,
          (text) =>
            Effect.gen(function* () {
              const secure_now = self.secure;
              if (!secure_now) return yield* Effect.fail(new Error("Not connected."));
              yield* self.sender.send_effect(secure_now, text);
            }),
          { discard: true },
        );
        return yield* Deferred.await(gate).pipe(
          Effect.timeoutFail({
            duration: "60 seconds",
            onTimeout: () => new CallTimeoutError(),
          }),
        );
      }).pipe(
        Effect.catchAll((e: unknown) => {
          const still_pending = self.pending.delete(full.id);
          if (still_pending) self.reassembly.delete(full.id);
          if (e instanceof CallTimeoutError) return Effect.fail(e);
          if (!still_pending && self.is_channel_break(e)) {
            // Send broke after the call settled: the channel is suspect.
            self.failPending(as_error(e));
            self.close();
          }
          return Effect.fail(as_error(e));
        }),
        // Cleanup runs on every exit — failure, success, and interrupt
        // (a closed page must not leave pending gates or reassembly).
        Effect.ensuring(
          Effect.sync(() => {
            self.pending.delete(full.id);
            self.reassembly.delete(full.id);
          }),
        ),
      );
    return run_effect(call_program);
  }

  private readonly reassembly = new Map<string, ChunkReassembly>();
  private readonly sender: PacedSender = new PacedSender(
    () => this.link,
    this.channel,
    () => this.closed,
  );

  private is_channel_break(e: unknown) {
    return (
      e instanceof SendTimeoutError ||
      (e instanceof Error && /closed|loss|channel|did not answer/i.test(e.message))
    );
  }

  private onAck(): void {
    this.sender.onAck();
  }

  /** Request plaintexts in send order (single frame or chunk frames). */
  private request_texts(full: TunnelRequest) {
    const framed = encodeTunnelRequest(full);
    if (new TextEncoder().encode(framed).length <= SINGLE_FRAME_BYTES) return [framed];
    const raw = new TextEncoder().encode(framed);
    return chunkBytes(full.id, raw).map((c) => JSON.stringify(c));
  }

  private onAppBytes(app: Uint8Array): void {
    const text = new TextDecoder().decode(app);
    const message: AppMessage = Either.getOrElse(
      Either.map(Schema.decodeUnknownEither(Schema.parseJson())(text), decode_app_message),
      (): AppMessage => ({ _tag: "BadFrame" }),
    );
    return Match.value(message).pipe(
      Match.tag("Chunk", ({ chunk }) => this.feedChunk(chunk)),
      Match.tag("BadChunk", ({ transfer, reason }) => {
        this.reassembly.delete(transfer);
        this.opts.onEvent?.({ type: "error", code: "bad_chunks", message: reason });
      }),
      Match.tag("Response", ({ response }) => this.deliverResponse(response)),
      Match.tag("BadFrame", () => {
        this.opts.onEvent?.({ type: "error", code: "bad_frame", message: "Forge answered with an unreadable frame." });
      }),
      Match.exhaustive,
    );
  }

  private feedChunk(chunk: TunnelChunk): void {
    let asm = this.reassembly.get(chunk.transfer);
    if (!asm) {
      asm = new ChunkReassembly();
      this.reassembly.set(chunk.transfer, asm);
    }
    Either.match(
      Either.try({
        try: () => asm.feed(chunk),
        catch: (e) => (e instanceof Error ? e : new Error("Chunked transfer failed.")),
      }),
      {
        onLeft: (e) => {
          this.reassembly.delete(chunk.transfer);
          this.opts.onEvent?.({ type: "error", code: "bad_chunks", message: e.message });
        },
        onRight: (res) => {
          if (!res.done) return;
          this.reassembly.delete(chunk.transfer);
          this.onResponseBytes(res.bytes);
        },
      },
    );
  }

  private onResponseBytes(raw: Uint8Array): void {
    const text = new TextDecoder().decode(raw);
    const message: AppMessage = Either.getOrElse(
      Either.map(Schema.decodeUnknownEither(Schema.parseJson())(text), decode_app_message),
      (): AppMessage => ({ _tag: "BadFrame" }),
    );
    return Match.value(message).pipe(
      Match.tag("Response", ({ response }) => this.deliverResponse(response)),
      Match.orElse(() => {
        this.opts.onEvent?.({ type: "error", code: "bad_frame", message: "Reassembled an unreadable response." });
      }),
    );
  }

  private deliverResponse(response: TunnelResponse): void {
    settle_pending(this.pending, response, "Forge call failed.");
  }

  private failPending(e: Error): void {
    for (const p of this.pending.values()) Deferred.unsafeDone(p.gate, Effect.fail(e));
    this.pending.clear();
    this.reassembly.clear();
  }

  close(): void {
    this.closed = true;
    this.failPending(new Error("Session closed."));
    // Best-effort channel farewell: a gone socket must not fail close.
    Either.getOrNull(
      Either.try({
        try: () => this.link?.closeChannel(this.channel, "bye"),
        catch: () => null,
      }),
    );
    this.link?.close();
    this.link = null;
    this.secure?.destroy();
    this.secure = null;
  }
}
