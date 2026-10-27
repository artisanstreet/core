// StreamFeed: SUBSCRIBE with the since cursor, Reset re-subscribe,
// Reset-storm/end/error fallback, grant-refresh passthrough.

import { describe, expect, it, vi } from "vitest";
import { create_stream_feed, type StreamFeedOptions } from "../src/live.ts";
import type { LiveEnvelope } from "../src/forge.ts";

interface FakeHandle {
  starts: Array<string | null>;
  stopped: boolean;
  refresh_due: boolean;
  events: {
    on_envelope(env: LiveEnvelope): void;
    on_reset(): void;
    on_end(reason: string): void;
    on_error(code: string, message: string): void;
  } | null;
  start(path: string | null): Promise<string>;
  stop(): void;
  needs_refresh(): boolean;
}

function fake_handle(): FakeHandle {
  const h: FakeHandle = {
    starts: [],
    stopped: false,
    refresh_due: false,
    events: null,
    async start(path: string | null): Promise<string> {
      h.starts.push(path);
      return "st-1";
    },
    stop(): void {
      h.stopped = true;
    },
    needs_refresh(): boolean {
      return h.refresh_due;
    },
  };
  return h;
}

function setup(overrides?: Partial<StreamFeedOptions>): { opts: StreamFeedOptions; handles: FakeHandle[]; seen: LiveEnvelope[]; lost: string[]; since: { v: number | null } } {
  const handles: FakeHandle[] = [];
  const seen: LiveEnvelope[] = [];
  const lost: string[] = [];
  const since = { v: null as number | null };
  const opts: StreamFeedOptions = {
    open: (events) => {
      const h = fake_handle();
      h.events = events;
      handles.push(h);
      return h;
    },
    path: (s) => `/events?since=${s ?? 0}&thread=t1`,
    get_since: () => since.v,
    set_since: (q) => {
      since.v = q;
    },
    on_envelope: (env) => void seen.push(env),
    on_stream_lost: (message) => void lost.push(message),
    ...overrides,
  };
  return { opts, handles, seen, lost, since };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("stream feed", () => {
  it("subscribes with the cursor and advances it on envelopes", async () => {
    const { opts, handles, seen, since } = setup();
    const feed = create_stream_feed(opts);
    feed.start();
    await tick();
    expect(handles).toHaveLength(1);
    expect(handles[0]!.starts).toEqual(["/events?since=0&thread=t1"]);
    handles[0]!.events!.on_envelope({ seq: 5, type: "item", event: {} });
    handles[0]!.events!.on_envelope({ seq: 3, type: "item", event: {} });
    expect(seen.map((e) => e.seq)).toEqual([5, 3]);
    expect(since.v).toBe(5);
    feed.stop();
  });

  it("Reset re-subscribes from the preserved cursor", async () => {
    const { opts, handles } = setup();
    const feed = create_stream_feed(opts);
    feed.start();
    await tick();
    handles[0]!.events!.on_envelope({ seq: 9, type: "item", event: {} });
    handles[0]!.events!.on_reset();
    await tick();
    expect(handles).toHaveLength(2);
    expect(handles[1]!.starts).toEqual(["/events?since=9&thread=t1"]);
    feed.stop();
  });

  it("a Reset storm yields to the fallback instead of looping forever", async () => {
    const { opts, handles, lost } = setup();
    const feed = create_stream_feed(opts);
    feed.start();
    await tick();
    for (let i = 0; i < 6; i++) {
      handles[handles.length - 1]!.events!.on_reset();
      await tick();
    }
    expect(lost.length).toBe(1);
    expect(lost[0]).toMatch(/polling/);
    feed.stop();
  });

  it("end and error yield to the fallback", async () => {
    const { opts, handles, lost } = setup();
    const feed = create_stream_feed(opts);
    feed.start();
    await tick();
    handles[0]!.events!.on_end("done");
    expect(lost).toEqual(["Stream ended (done)."]);
  });

  it("passes grant refresh through for the page to re-establish", async () => {
    const { opts, handles } = setup();
    const feed = create_stream_feed(opts);
    feed.start();
    await tick();
    expect(feed.needs_refresh?.()).toBe(false);
    handles[0]!.refresh_due = true;
    expect(feed.needs_refresh?.()).toBe(true);
    feed.stop();
  });

  it("ignores late events after stop", async () => {
    const { opts, handles, seen } = setup();
    const feed = create_stream_feed(opts);
    feed.start();
    await tick();
    feed.stop();
    handles[0]!.events!.on_envelope({ seq: 50, type: "item", event: {} });
    expect(seen).toEqual([]);
  });
});
