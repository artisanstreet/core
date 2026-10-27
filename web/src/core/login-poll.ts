// Magic-link approval polling over Effect. The originating browser polls
// the login-status Effect until the emailed link is approved; transient
// service/network hiccups back off exponentially. Terminal answers
// (unknown request, rate limits) stop immediately. Cancellation is
// `AbortSignal`-scoped: navigating away interrupts the fiber.

import { Effect, Fiber } from "effect";
import { ApiFailure, to_legacy_error } from "./api-error.ts";
import { login_status_effect, type HttpSeam } from "./api-effect.ts";
import { run_effect } from "./run-promise.ts";

export type LoginPollStatus = "pending" | "email_approved" | "completed" | "expired";

export interface LoginPollResult {
  status: LoginPollStatus;
  totp_required: boolean;
  email: string;
  expires_at: string;
}

export interface LoginPollCallbacks {
  on_approved: (result: LoginPollResult) => void;
  on_completed: (result: LoginPollResult) => void;
  on_expired: () => void;
  on_transient: (attempt: number) => void;
  on_terminal: (message: string) => void;
  is_cancelled: () => boolean;
  format_error: (err: unknown) => string;
}

const MAX_TRANSIENT = 10;

export function start_login_poll(
  http: HttpSeam,
  request_id: string,
  get_secret: () => string | null,
  callbacks: LoginPollCallbacks,
  abort_signal: AbortSignal,
): () => void {
  let stopped = false;
  const on_abort = () => {
    stopped = true;
  };
  abort_signal.addEventListener("abort", on_abort, { once: true });

  const loop = Effect.gen(function* () {
    let attempt = 0;
    for (;;) {
      if (stopped || callbacks.is_cancelled()) return;
      const secret = get_secret();
      if (!secret) {
        yield* Effect.sync(() => callbacks.on_terminal("This browser lost the request secret (storage was cleared). Start over."));
        return;
      }
      const settled = yield* Effect.either(login_status_effect(http.fetch_impl, http.base, request_id, secret));
      if (settled._tag === "Right") {
        const s = settled.right;
        const mapped: LoginPollResult = {
          status: s.status,
          totp_required: s.totp_required,
          email: s.email,
          expires_at: s.expires_at,
        };
        attempt = 0;
        if (s.status === "email_approved") {
          yield* Effect.sync(() => callbacks.on_approved(mapped));
          return;
        }
        if (s.status === "completed") {
          yield* Effect.sync(() => callbacks.on_completed(mapped));
          return;
        }
        if (s.status === "expired") {
          yield* Effect.sync(() => callbacks.on_expired());
          return;
        }
      } else {
        const err = settled.left;
        const transient = err instanceof ApiFailure ? err.status >= 500 : true;
        if (transient) {
          attempt += 1;
          if (attempt <= MAX_TRANSIENT) {
            yield* Effect.sync(() => callbacks.on_transient(attempt));
            yield* Effect.sleep(`${3000 + attempt * 1000} millis`);
            continue;
          }
        }
        const message = callbacks.format_error(to_legacy_error(err));
        yield* Effect.sync(() => callbacks.on_terminal(message));
        return;
      }
      yield* Effect.sleep("3 seconds");
    }
  });

  const fiber = Effect.runFork(loop.pipe(Effect.catchAll(() => Effect.void)));
  return () => {
    stopped = true;
    abort_signal.removeEventListener("abort", on_abort);
    void run_effect(Fiber.interrupt(fiber)).catch(() => undefined);
  };
}
