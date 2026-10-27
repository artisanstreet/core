// Presence transport headers: the Relay CORS preflight allowlist covers
// Authorization and Content-Type only, so the browser must not send
// tracer (`b3`/`traceparent`) or cookie-credential headers cross-origin.
// A stub fetch records the exact headers the platform client emits.

import { describe, expect, it } from "vitest";
import { fetchPresence } from "../src/relay/presence.ts";

describe("presence transport headers", () => {
  it("sends only authorization + accept (CORS-safe, no tracer headers)", async () => {
    let seen: { url: unknown; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ forge_online: true, clients: 2 }), { status: 200 });
    }) as typeof fetch;
    const presence = await fetchPresence("https://relay.test", "acct1", "mch1", "jwt.grant.here", fetchImpl);
    expect(presence).toEqual({ forgeOnline: true, clients: 2 });
    const headers = (seen!.init.headers ?? {}) as Record<string, string>;
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    expect(names).toEqual(["accept", "authorization"]);
  });
});
