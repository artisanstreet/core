// Shared transport types for Forge sessions/streams. The only surface
// that touches the vendored Relay link (`EditorLink` in production, fakes
// in tests) — Noise, grants, and framing stay real on both sides.

export interface RelayLinkLike {
  connect(): Promise<{ role: string; forgeOnline: boolean }>;
  open(channel: string): void;
  sendOpaque(channel: string, body: Uint8Array): SendStatus;
  sendAcked(channel: string, body: Uint8Array, opts?: { timeoutMs?: number }): Promise<void>;
  willFit(channel: string, encodedBytes: number): boolean;
  closeChannel(channel: string, reason?: string): void;
  close(code?: number, reason?: string): void;
}

export type SendStatus = "sent" | "dropped-window-full";

export type ChannelEvents = {
  onChannelOpened?(channel: string, peer: "forge" | "client"): void;
  onData?(channel: string, seq: number, body: Uint8Array): void;
  onChannelClosed?(channel: string, reason: string): void;
  onPresence?(forgeOnline: boolean, clients: number): void;
  onError?(code: string, message: string): void;
  onAck?(channel: string, seq: number): void;
  onClose?(code: number, reason: string): void;
};

export type ForgeSessionEvent =
  | { type: "ready"; forgeOnline: boolean }
  | { type: "presence"; forgeOnline: boolean; clients: number }
  | { type: "channel-opened"; channel: string }
  | { type: "channel-closed"; channel: string; reason: string }
  | { type: "error"; code: string; message: string };
