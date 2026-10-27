// Live event stream frames over the tunnel (wire doc §6).
// SUBSCRIBE opens a dedicated channel with its own Noise session; the Forge
// answers {"$stream": {"stream": id}}, then emits one DATA frame per
// envelope: {"$event": {"stream": id, "envelope": {...}}} (oversized
// envelopes chunked). End: {"$event": {"stream": id, "end": reason}}.
// UNSUBSCRIBE ends one stream without closing the channel. Receivers ignore
// unknown envelope fields; Reset envelopes trigger re-subscribe.

import { Either, Schema } from "effect";

export const StreamStart = Schema.Struct({
  $stream: Schema.Struct({ stream: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)) }),
});
export type StreamStart = typeof StreamStart.Type;

export const StreamEvent = Schema.Struct({
  $event: Schema.Struct({
    stream: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
    envelope: Schema.optional(Schema.Unknown),
    end: Schema.optional(Schema.String),
  }),
});
export type StreamEvent = typeof StreamEvent.Type;

export function as_stream_start(input: unknown): StreamStart | null {
  if (typeof input !== "object" || input === null) return null;
  if (!("$stream" in input)) return null;
  return Either.getOrNull(Schema.decodeUnknownEither(StreamStart)(input));
}

export function as_stream_event(input: unknown): StreamEvent | null {
  if (typeof input !== "object" || input === null) return null;
  if (!("$event" in input)) return null;
  return Either.getOrNull(Schema.decodeUnknownEither(StreamEvent)(input));
}

/** Minimal SSE envelope shape the live feed consumes (tolerant reads). */
export interface LiveEnvelope {
  seq: number | null;
  type: string;
  event: Record<string, unknown>;
}

export function as_live_envelope(input: unknown): LiveEnvelope | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : null;
  if (!type) return null;
  const seq = typeof o.seq === "number" && Number.isInteger(o.seq) && o.seq >= 0 ? o.seq : null;
  return { seq, type, event: o };
}
