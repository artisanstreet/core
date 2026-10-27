// Ordered, ack-paced outbound funnel (single place that touches
// `sendAcked`). Semantics mirror SecureChannel.sendApp (exact pre-seal
// sizing via sealedFrameSize, throws-before-consume on a full window,
// seal + sendAcked one frame at a time):
// - WouldBlock pauses for the next recipient ack (nothing sealed, safe to
//   retry) instead of dropping ciphertext;
// - any post-seal failure (timeout/close/loss) breaks the Noise stream, so
//   callers fail the session closed and re-handshake — never retry
//   ciphertext, never skip the Noise sequence.
//
// Effect underneath: a 1-permit `Semaphore` serializes one in-flight
// sequence per channel; ack waits are `Deferred` gates with `Effect.timeout`
// and waiter deregistration on exit (no leaked waiters, no dangling raw
// timers). All waiting happens OUTSIDE the incoming-data handler so the
// ACK read loop keeps draining while sends stall.

import { Deferred, Duration, Effect, STM, TSemaphore } from "effect";
import { run_effect } from "../core/run-promise.ts";
import { SendTimeoutError, SendWouldBlockError } from "../../vendor/relay/client.ts";
import { sealedFrameSize } from "../../vendor/relay/channel.ts";
import type { RelayLinkLike } from "./transport.ts";

export class PacedSender {
  private readonly semaphore: TSemaphore.TSemaphore;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly link_of: () => RelayLinkLike | null,
    private readonly channel: string,
    private readonly closed: () => boolean,
  ) {
    this.semaphore = Effect.runSync(STM.commit(TSemaphore.make(1)));
  }

  onAck(): void {
    for (const w of this.waiters.splice(0, this.waiters.length)) w();
  }

  async send(secure: { noise: { seal(pt: Uint8Array): { ct: Uint8Array } } }, text: string): Promise<void> {
    return run_effect(this.send_effect(secure, text));
  }

  /** Internal Effect API; `send` is the Promise boundary over this. */
  send_effect(
    secure: { noise: { seal(pt: Uint8Array): { ct: Uint8Array } } },
    text: string,
  ): Effect.Effect<void, Error> {
    const self = this;
    return TSemaphore.withPermits(self.semaphore, 1)(
      Effect.gen(function* () {
        const link = self.link_of();
        if (!link) return yield* Effect.fail(new Error("Not connected."));
        for (;;) {
          if (self.closed()) return yield* Effect.fail(new Error("Session closed."));
          const pt = new TextEncoder().encode(text);
          const fits = yield* Effect.try({
            try: () => link.willFit(self.channel, sealedFrameSize(self.channel, pt.length)),
            catch: (e) => (e instanceof Error ? e : new Error("Window check failed.")),
          });
          if (!fits) {
            if (self.closed()) return yield* Effect.fail(new Error("Session closed."));
            yield* self.wait_for_ack(Duration.millis(30_000));
            continue;
          }
          const sealed = yield* Effect.try({
            try: () => secure.noise.seal(pt),
            catch: (e) => (e instanceof Error ? e : new Error("Seal failed.")),
          });
          yield* Effect.tryPromise({
            try: () => link.sendAcked(self.channel, sealed.ct, { timeoutMs: 30_000 }),
            catch: (e) => (e instanceof Error ? e : new Error("Send failed.")),
          });
          return;
        }
      }),
    );
  }

  /** Ack gate with timeout; the waiter deregisters on exit (no leaks). */
  private wait_for_ack(timeout: Duration.DurationInput): Effect.Effect<void, SendTimeoutError> {
    const self = this;
    return Effect.acquireUseRelease(
      Effect.map(
        Deferred.make<void>(),
        (gate) => {
          const wake = () => Deferred.unsafeDone(gate, Effect.void);
          self.waiters.push(wake);
          return { gate, wake };
        },
      ),
      ({ gate }) => Deferred.await(gate),
      ({ wake }) =>
        Effect.sync(() => {
          const i = self.waiters.indexOf(wake);
          if (i >= 0) self.waiters.splice(i, 1);
        }),
    ).pipe(
      Effect.timeout(timeout),
      Effect.mapError(() => new SendTimeoutError()),
    );
  }
}

export { SendTimeoutError, SendWouldBlockError };
