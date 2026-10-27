import { Effect, Either, Fiber } from "effect";
import type { LiveEnvelope } from "./forge/stream-frames.ts";

export interface LiveFeed {
  readonly transport: "polling" | "stream";
  start(): void;
  stop(): void;
  needsRefresh?(nowMs?: number): boolean;
}

export interface PollingFeedOptions<T extends { position?: number }> {
  threadPoll: (after: number) => Promise<T[]>;
  getAfter: () => number;
  onItems: (items: T[]) => void;
  visibleMs?: number;
  hiddenMs?: number;
}

export function createPollingFeed<T extends { position?: number }>(opts: PollingFeedOptions<T>): LiveFeed {
  let fiber: Fiber.RuntimeFiber<void> | null = null;
  let stopped = false;

  const cadence_ms = (): number =>
    typeof document !== "undefined" && document.visibilityState === "hidden" ? (opts.hiddenMs ?? 20000) : (opts.visibleMs ?? 4000);

  const poll_once: Effect.Effect<void> = Effect.gen(function* () {
    if (stopped) return;
    const items = yield* Effect.orElseSucceed(
      Effect.tryPromise({ try: () => opts.threadPoll(opts.getAfter()), catch: () => null }),
      () => [] as Array<T>,
    );
    if (!stopped && items.length > 0) {
      yield* Effect.sync(() => opts.onItems(items));
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
  start(subscribePath: string): Promise<string>;
  stop(): void;
  needsRefresh(nowMs?: number): boolean;
}

export interface StreamEvents {
  onEnvelope(env: LiveEnvelope): void;
  onReset(): void;
  onEnd(reason: string): void;
  onError(code: string, message: string): void;
}

export interface StreamFeedOptions {
  open: (events: StreamEvents) => StreamHandle;
  path: (since: number | null) => string;
  getSince: () => number | null;
  setSince: (seq: number) => void;
  onEnvelope: (env: LiveEnvelope) => void;
  onStreamLost: (message: string) => void;
  onResetNotice?: () => void;
}

const stop_quietly = (handle: StreamHandle | null): void => {
  if (handle === null) return;
  Either.getOrNull(Either.try({ try: () => handle.stop(), catch: () => null }));
};

export function createStreamFeed(opts: StreamFeedOptions): LiveFeed {
  let stream: StreamHandle | null = null;
  let stopped = false;
  let resets = 0;
  let reset_window_start = 0;

  const lost = (message: string): void => {
    if (stopped) return;
    stop();
    opts.onStreamLost(message);
  };

  const events_for = (getHandle: () => StreamHandle | null): StreamEvents => ({
    onEnvelope: (env) => {
      const handle = getHandle();
      if (stopped || handle === null || stream !== handle) return;
      if (env.seq !== null) {
        const cur = opts.getSince();
        if (cur === null || env.seq > cur) opts.setSince(env.seq);
      }
      opts.onEnvelope(env);
    },
    onReset: () => {
      const handle = getHandle();
      if (stopped || handle === null || stream !== handle) return;
      opts.onResetNotice?.();
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
    onEnd: (reason) => {
      const handle = getHandle();
      if (stopped || handle === null || stream !== handle) return;
      lost(`Stream ended (${reason}).`);
    },
    onError: (code, message) => {
      const handle = getHandle();
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
    const path = opts.path(opts.getSince());
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
    needsRefresh(nowMs?: number) {
      return stream?.needsRefresh(nowMs) ?? false;
    },
  };
}
