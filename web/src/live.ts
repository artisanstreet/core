import { Effect, Either, Fiber } from "effect";
import type { LiveEnvelope } from "./forge/stream-frames.ts";

export interface LiveFeed {
  readonly transport: "polling" | "stream";
  start(): void;
  stop(): void;
  needs_refresh?(now_ms?: number): boolean;
}

export interface PollingFeedOptions<T extends { position?: number }> {
  thread_poll: (after: number) => Promise<T[]>;
  get_after: () => number;
  on_items: (items: T[]) => void;
  visible_ms?: number;
  hidden_ms?: number;
}

export function create_polling_feed<T extends { position?: number }>(opts: PollingFeedOptions<T>): LiveFeed {
  let fiber: Fiber.RuntimeFiber<void> | null = null;
  let stopped = false;

  const cadence_ms = (): number =>
    typeof document !== "undefined" && document.visibilityState === "hidden" ? (opts.hidden_ms ?? 20000) : (opts.visible_ms ?? 4000);

  const poll_once: Effect.Effect<void> = Effect.gen(function* () {
    if (stopped) return;
    const items = yield* Effect.orElseSucceed(
      Effect.tryPromise({ try: () => opts.thread_poll(opts.get_after()), catch: () => null }),
      () => [] as Array<T>,
    );
    if (!stopped && items.length > 0) {
      yield* Effect.sync(() => opts.on_items(items));
    }
  });

  const loop: Effect.Effect<void> = Effect.forever(
    Effect.gen(function* () {
      yield* poll_once;
      yield* Effect.sleep(`${cadence_ms()} millis`);
    }),
  );

  return {
    transport: "polling",
    start() {
      if (!stopped && fiber !== null) return;
      stopped = false;
      fiber = Effect.runFork(loop.pipe(Effect.catchAll(() => Effect.void)));
    },
    stop() {
      stopped = true;
      const f = fiber;
      fiber = null;
      if (f !== null) {
        Effect.runFork(Fiber.interrupt(f));
      }
    },
  };
}

export interface StreamHandle {
  start(subscribe_path: string): Promise<string>;
  stop(): void;
  needs_refresh(now_ms?: number): boolean;
}

export interface StreamEvents {
  on_envelope(env: LiveEnvelope): void;
  on_reset(): void;
  on_end(reason: string): void;
  on_error(code: string, message: string): void;
}

export interface StreamFeedOptions {
  open: (events: StreamEvents) => StreamHandle;
  path: (since: number | null) => string;
  get_since: () => number | null;
  set_since: (seq: number) => void;
  on_envelope: (env: LiveEnvelope) => void;
  on_stream_lost: (message: string) => void;
  on_reset_notice?: () => void;
}

const stop_quietly = (handle: StreamHandle | null): void => {
  if (handle === null) return;
  Either.getOrNull(Either.try({ try: () => handle.stop(), catch: () => null }));
};

export function create_stream_feed(opts: StreamFeedOptions): LiveFeed {
  let stream: StreamHandle | null = null;
  let stopped = false;
  let resets = 0;
  let reset_window_start = 0;

  const lost = (message: string): void => {
    if (stopped) return;
    stop();
    opts.on_stream_lost(message);
  };

  const events_for = (get_handle: () => StreamHandle | null): StreamEvents => ({
    on_envelope: (env) => {
      const handle = get_handle();
      if (stopped || handle === null || stream !== handle) return;
      if (env.seq !== null) {
        const cur = opts.get_since();
        if (cur === null || env.seq > cur) opts.set_since(env.seq);
      }
      opts.on_envelope(env);
    },
    on_reset: () => {
      const handle = get_handle();
      if (stopped || handle === null || stream !== handle) return;
      opts.on_reset_notice?.();
      const now = Date.now();
      if (now - reset_window_start > 30_000) {
        reset_window_start = now;
        resets = 0;
      }
      resets++;
      if (resets > 5) {
        lost("Stream keeps resetting; using polling instead.");
        return;
      }
      stop_quietly(handle);
      if (stream === handle) stream = null;
      subscribe_now();
    },
    on_end: (reason) => {
      const handle = get_handle();
      if (stopped || handle === null || stream !== handle) return;
      lost(`Stream ended (${reason}).`);
    },
    on_error: (code, message) => {
      const handle = get_handle();
      if (stopped || handle === null || stream !== handle) return;
      lost(`${code}: ${message}`);
    },
  });

  const subscribe_now = (): void => {
    if (stopped) return;
    let handle: StreamHandle | null = null;
    const events = events_for(() => handle);
    handle = opts.open(events);
    const current = handle;
    stream = current;
    const path = opts.path(opts.get_since());
    const program: Effect.Effect<void> = Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => current.start(path), catch: (e) => e });
    }).pipe(
      Effect.catchAll((e: unknown) =>
        Effect.sync(() => {
          if (stream === current) stream = null;
          lost(e instanceof Error ? e.message : "Subscribe failed.");
        }),
      ),
    );
    Effect.runFork(program);
  };

  function stop(): void {
    stopped = true;
    stop_quietly(stream);
    stream = null;
  }

  return {
    transport: "stream",
    start() {
      stopped = false;
      resets = 0;
      reset_window_start = 0;
      subscribe_now();
    },
    stop,
    needs_refresh(now_ms?: number) {
      return stream?.needs_refresh(now_ms) ?? false;
    },
  };
}
