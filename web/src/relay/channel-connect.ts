// Shared Relay channel establishment: grant mint → Noise XX initiation →
// admission → handshake-open wait. `ForgeSession` (unary calls) and
// `ForgeStream` (SUBSCRIBE) share this; only their post-open event wiring
// differs (kept per class). All internals are Effect; the session/stream
// `connect`/`start` methods are the sole Promise boundary.

import { Deferred, Effect, Either } from "effect";
import { EditorLink, SecureChannel } from "../../vendor/relay/client.ts";
import type { GrantMaterial } from "../../vendor/relay/client.ts";
import { staticKeypairFromSecret } from "../../vendor/relay/channel.ts";
import { b64uDecode } from "../../vendor/relay/b64u.ts";
import { randomBytes } from "@noble/hashes/utils.js";
import { issue_grant_effect, type FetchLike } from "../core/api-effect.ts";
import type { ApiFailure, DecodeFailure, TransportFailure } from "../core/api-error.ts";
import { grant_jti, newEphemeralCnf, GrantJwtError } from "./cnf.ts";
import type { ChannelEvents, PendingGate, RelayLinkLike } from "./transport.ts";
import { throwIfTunnelError, type TunnelResponse } from "../forge/codec.ts";

/** Mint a fresh one-use grant + ephemeral cnf for one channel. */
export const mint_channel_grant_effect = (
  http: { fetch_impl: FetchLike; base: string },
  machine_id: string,
): Effect.Effect<
  { grant: GrantMaterial; grant_expires_at_ms: number; cnf_sk: Uint8Array },
  ApiFailure | TransportFailure | DecodeFailure | GrantJwtError
> =>
  Effect.gen(function* () {
    const cnf = newEphemeralCnf();
    const issued = yield* issue_grant_effect(http.fetch_impl, http.base, {
      audience: "ast-relay",
      scope: ["relay:connect", "forge:execute"],
      ttlSeconds: 300,
      targetMachineId: machine_id,
      cnf: cnf.jwk,
    });
    let grant_expires_at_ms = Date.parse(issued.expiresAt);
    if (!Number.isFinite(grant_expires_at_ms)) grant_expires_at_ms = Date.now() + 300_000;
    const jti = yield* Either.match(grant_jti(issued.token), {
      onLeft: (e) => Effect.fail(e),
      onRight: (value) => Effect.succeed(value),
    });
    return { grant: { jwt: issued.token, jti, cnfSk: cnf.sk }, grant_expires_at_ms, cnf_sk: cnf.sk };
  });

/** Initiate the Noise XX session bound to the enrolled Forge key. */
export const initiate_secure = (
  cnf_sk: Uint8Array,
  forge_cnf_x: string,
  grant_jwt: string,
  ctx: { account: string; machine: string; channel: string },
): Effect.Effect<SecureChannel, GrantJwtError> =>
  Effect.gen(function* () {
    const forge_cnf = yield* Effect.try({
      try: () => b64uDecode(forge_cnf_x),
      catch: () => new GrantJwtError({ reason: "Forge record has no usable identity key." }),
    });
    if (forge_cnf.length !== 32) {
      return yield* Effect.fail(new GrantJwtError({ reason: "Forge record has no usable identity key." }));
    }
    return yield* Effect.try({
      try: () =>
        SecureChannel.initiate(staticKeypairFromSecret(randomBytes(32)), {
          cnfSignKey: cnf_sk,
          expectedForgeCnf: forge_cnf,
          ownGrantJwt: grant_jwt,
          ctx,
        }),
      catch: () => new GrantJwtError({ reason: "channel setup failed" }),
    });
  });

export function channel_url(relay_ws_url: string, account_id: string, machine_id: string): string {
  return `${relay_ws_url}/v1/route/${encodeURIComponent(account_id)}/${encodeURIComponent(machine_id)}`;
}

export type LinkFactory = (url: string, grant: GrantMaterial, events: ChannelEvents) => RelayLinkLike;

/** Default link factory: real WebSocket `EditorLink`. */
export function default_link_factory(ws_impl?: typeof WebSocket): LinkFactory {
  return (url, grant, events) => new EditorLink(url, grant, events, ws_impl);
}

/** Settle one in-flight unary call: look up + drop the pending gate, then
 * complete it with the Forge response (or the tunnel error). Shared by
 * `ForgeSession` and `ForgeStream` so the resolve/reject rules match. */
export const settle_pending = (
  pending: Map<string, PendingGate>,
  res: TunnelResponse,
  failure_message: string,
): void => {
  const found = res.id ? pending.get(res.id) : undefined;
  if (!found) return;
  pending.delete(res.id);
  Either.match(
    Either.try({
      try: () => throwIfTunnelError(res),
      catch: (e) => (e instanceof Error ? e : new Error(failure_message)),
    }),
    {
      onLeft: (e) => Deferred.unsafeDone(found.gate, Effect.fail(e)),
      onRight: (ok) => Deferred.unsafeDone(found.gate, Effect.succeed(ok)),
    },
  );
};

/** Pump all queued outbound handshake bytes through one sender. */
export function flush_outbound(secure: SecureChannel, send: (body: Uint8Array) => void): void {
  for (const body of secure.pumpOutbound()) send(body);
}

/** Wait for the encrypted channel to open (Effect sleep loop + timeout). */
export const wait_open_effect = (
  is_open: () => boolean | undefined,
  is_closed: () => boolean,
  closed_message: string,
  timeout_message: string,
  timeout_ms: number,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout_ms;
    for (;;) {
      if (is_closed()) return yield* Effect.fail(new Error(closed_message));
      if (is_open()) return;
      if (Date.now() > deadline) return yield* Effect.fail(new Error(timeout_message));
      yield* Effect.sleep("25 millis");
    }
  }).pipe(Effect.timeout(timeout_ms + 1_000));
