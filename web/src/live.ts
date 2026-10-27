// Live-update seam for relay-mode Forge views.
//
// v1 reality: SSE event streams are NOT tunneled, so the current feed
// polls with a cursor (`transcript?after=` on the open thread). It never
// refetches full transcripts on a timer: only the delta past the last
// seen position is requested, and the slow `/state` pass (sidebar counts)
// is separate and infrequent.
//
// Planned (Rust owns the other half): bounded stream frames over the
// tunnel — `start`/`chunk`/`end` carrying `/events?since=` envelopes,
// concurrent with unary calls, cleaned up on channel disconnect. When
// those fields land in the wire doc, a `StreamFeed` implementing the same
// `LiveFeed` interface replaces the polling feed without touching pages.
// This module documents the seam; it does not pretend the stream exists.

import type { LiveEnvelope } from "./forge.ts";

export interface LiveFeed {
  readonly transport: "polling" | "stream";
  start(): void;
  stop(): void;
  /** True when the underlying grant dies soon — the page re-establishes. */
  needsRefresh?(nowMs?: number): boolean;
}

export interface PollingFeedOptions<T extends { position?: number }> {
  /** Fetch transcript items newer than `after` (position cursor). */
  threadPoll: (after: number) => Promise<T[]>;
  getAfter: () => number;
  onItems: (items: T[]) => void;
  /** Ms between thread polls while the tab is visible. Default 4000. */
  visibleMs?: number;
  /** Ms between thread polls while the tab is hidden. Default 20000. */
  hiddenMs?: number;
}

export function createPollingFeed<T extends { position?: number }>(opts: PollingFeedOptions<T>): LiveFeed {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight = false;

  const cadence = () => (typeof document !== "undefined" && document.visibilityState === "hidden" ? (opts.hiddenMs ?? 20000) : (opts.visibleMs ?? 4000));

  const tick = async (): Promise<void> => {
    timer = null;
    if (stopped) return;
    if (!inFlight) {
      inFlight = true;
      try {
        const items = await opts.threadPoll(opts.getAfter());
        if (!stopped && items.length > 0) opts.onItems(items);
      } catch {
        // Transient (grant mid-refresh, offline Forge): keep the last
        // rendered state and try again next cadence. The page surfaces
        // hard failures from its own explicit loads, not from the feed.
      } finally {
        inFlight = false;
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), cadence());
  };

  return {
    transport: "polling",
    start() {
      if (!stopped && timer !== null) return;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
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
  /**
   * Build a fresh stream (own Relay channel, own grant, own Noise
   * session) wired to the given events. Called on start and on every
   * re-subscribe (Reset, refresh) — never shared across subscribes.
   */
  open: (events: StreamEvents) => StreamHandle;
  /** SUBSCRIBE path for the cursor, e.g. `/events?since=12&thread=t1`. */
  path: (since: number | null) => string;
  getSince: () => number | null;
  setSince: (seq: number) => void;
  onEnvelope: (env: LiveEnvelope) => void;
  /** Stream lost (end/error/Reset-storm): the page falls back to polling. */
  onStreamLost: (message: string) => void;
  /** Reset envelope observed (re-subscribing from the preserved cursor). */
  onResetNotice?: () => void;
}

/**
 * Live event stream over the tunnel (wire doc §6): SUBSCRIBE on a
 * dedicated channel, backlog then live envelopes with the standard `since`
 * cursor. Reset re-subscribes from the last seen seq — no new bookkeeping.
 * A Reset storm or end/error yields to the polling fallback via
 * onStreamLost. Grant refresh is the page's job (needsRefresh) because it
 * must also re-establish the unary session channel.
 */
export function createStreamFeed(opts: StreamFeedOptions): LiveFeed {
  let stream: StreamHandle | null = null;
  let stopped = false;
  let resets = 0;
  let resetWindowStart = 0;

  const lost = (message: string) => {
    if (stopped) return;
    stop();
    opts.onStreamLost(message);
  };

  const subscribe = async (): Promise<void> => {
    if (stopped) return;
    const handle = opts.open({
      onEnvelope: (env) => {
        if (stopped || stream !== handle) return;
        if (env.seq !== null) {
          const cur = opts.getSince();
          if (cur === null || env.seq > cur) opts.setSince(env.seq);
        }
        opts.onEnvelope(env);
      },
      onReset: () => {
        if (stopped || stream !== handle) return;
        opts.onResetNotice?.();
        const now = Date.now();
        if (now - resetWindowStart > 30_000) {
          resetWindowStart = now;
          resets = 0;
        }
        resets++;
        if (resets > 5) {
          lost("Stream keeps resetting; using polling instead.");
          return;
        }
        try {
          handle.stop();
        } catch {
          // ignore
        }
        if (stream === handle) stream = null;
        void subscribe();
      },
      onEnd: (reason) => {
        if (stopped || stream !== handle) return;
        lost(`Stream ended (${reason}).`);
      },
      onError: (code, message) => {
        if (stopped || stream !== handle) return;
        lost(`${code}: ${message}`);
      },
    });
    stream = handle;
    try {
      await handle.start(opts.path(opts.getSince()));
    } catch (e) {
      if (stream === handle) stream = null;
      lost(e instanceof Error ? e.message : "Subscribe failed.");
    }
  };

  function stop(): void {
    stopped = true;
    try {
      stream?.stop();
    } catch {
      // ignore
    }
    stream = null;
  }

  return {
    transport: "stream",
    start() {
      stopped = false;
      resets = 0;
      resetWindowStart = 0;
      void subscribe();
    },
    stop,
    needsRefresh(nowMs?: number) {
      return stream?.needsRefresh(nowMs) ?? false;
    },
  };
}
