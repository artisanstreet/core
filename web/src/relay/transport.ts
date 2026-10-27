// Shared transport types for Forge sessions/streams. The only surface
// that touches the vendored Relay link (`EditorLink` in production, fakes
// in tests) — Noise, grants, and framing stay real on both sides.

import type { Deferred } from "effect";
import type { TunnelResponse } from "../forge/codec.ts";

export interface RelayLinkLike {
  connect(): Promise<{ role: string; forge_online: boolean }>;
  open(channel: string): void;
  send_opaque(channel: string, body: Uint8Array): SendStatus;
  send_acked(channel: string, body: Uint8Array, opts?: { timeout_ms?: number }): Promise<void>;
  will_fit(channel: string, encoded_bytes: number): boolean;
  close_channel(channel: string, reason?: string): void;
  close(code?: number, reason?: string): void;
}

export type SendStatus = "sent" | "dropped-window-full";

export type ChannelEvents = {
  on_channel_opened?(channel: string, peer: "forge" | "client"): void;
  on_data?(channel: string, seq: number, body: Uint8Array): void;
  on_channel_closed?(channel: string, reason: string): void;
  on_presence?(forge_online: boolean, clients: number): void;
  on_error?(code: string, message: string): void;
  on_ack?(channel: string, seq: number): void;
  on_close?(code: number, reason: string): void;
};

export type ForgeSessionEvent =
  | { type: "ready"; forge_online: boolean }
  | { type: "presence"; forge_online: boolean; clients: number }
  | { type: "channel_opened"; channel: string }
  | { type: "channel_closed"; channel: string; reason: string }
  | { type: "error"; code: string; message: string };

/** One in-flight unary call: the response resolver both sides share. */
export interface PendingGate {
  gate: Deferred.Deferred<TunnelResponse, Error>;
}
