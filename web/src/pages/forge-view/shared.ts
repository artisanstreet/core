// Remote Forge threads (#/forge).
// Shared tunnel helpers: connection control + unary GET + transport-honest
// error hints. Used by the connection, thread-list, and thread-detail
// modules; kept here so the dependency chain stays linear
// (connection → thread-list → thread-detail → shared).

import { ApiError } from "../../api.ts";
import { throwIfTunnelError } from "../../forge.ts";
import type { ForgeSession, ForgeSessionOptions } from "../../relay-forge.ts";
import { friendly } from "../signin.ts";

/** Shared connection state so an open thread can refresh grants/channels. */
export interface ConnCtl {
  opts: ForgeSessionOptions;
  current: ForgeSession | null;
}

export async function tunnelGet(session: ForgeSession, path: string): Promise<unknown> {
  const res = await session.call({ method: "GET", path });
  return throwIfTunnelError(res).body;
}

/** Tunnel failures name the transport honestly: 404/501 means the Forge side is not there yet. */
export function tunnelHint(err: unknown): string {
  if (err instanceof ApiError) return friendly(err);
  const t = (err as { tunnelStatus?: number }).tunnelStatus;
  if (t === 404 || t === 501) {
    return "This Forge does not serve that path over the tunnel yet (the Rust tunnel endpoint is still landing). The encrypted channel itself is open — try again after the Forge updates.";
  }
  return friendly(err);
}

export function threadTitle(t: { id: string; title?: string | null }): string {
  const title = t.title?.trim();
  return title ? `${title} (${t.id})` : t.id;
}
