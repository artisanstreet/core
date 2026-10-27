import { Cache, Context, Effect, Layer } from "effect";
import { SignJWT, exportJWK as export_jwk, jwtVerify as jwt_verify } from "jose";
import { base64url_decode, base64url_encode, decrypt_with_key, encrypt_with_key, random_bytes } from "../crypto.ts";
import { GRANT_MAX_TTL_SECONDS } from "../constants.ts";
import { bad_request, forbidden, unauthorized, type CoreError } from "../errors.ts";
import { new_id } from "../ids.ts";
import { AppConfigTag, DbTag, db_run } from "./deps.ts";
import { record } from "./activity.ts";
import insert_grant_key from "../db/queries/grants/insertGrantKey.sql"
import get_grant_key_by_kid from "../db/queries/grants/getGrantKeyByKid.sql"
import list_active_grant_keys from "../db/queries/grants/listActiveGrantKeys.sql"
import retire_grant_key from "../db/queries/grants/retireGrantKey.sql"
import list_recent_keys_for_jwks from "../db/queries/grants/listRecentKeysForJwks.sql"
import list_retired_key_ids from "../db/queries/grants/listRetiredKeyIds.sql"
import list_revoked_machine_ids from "../db/queries/grants/listRevokedMachineIds.sql"
import get_machine_by_id from "../db/queries/machines/getMachineById.sql"

const SEED_PURPOSE = "grant-key-seed v1";

export class KeyCacheTag extends Context.Tag("GrantKeyCache")<
  KeyCacheTag,
  Cache.Cache<string, CryptoKey, CoreError>
>() {}

export const global_key_cache: Cache.Cache<string, CryptoKey, CoreError> = Effect.runSync(
  Cache.make({
    capacity: 8,
    timeToLive: "15 minutes",
    lookup: (_kid: string): Effect.Effect<CryptoKey, CoreError> => Effect.fail(bad_request("signing key unavailable")) }),
);

export const KeyCacheLive = Layer.succeed(KeyCacheTag, global_key_cache);

function new_kid(now_ms: number): string {
  const d = new Date(now_ms);
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const rand = base64url_encode(random_bytes(3)).toLowerCase();
  return `core-${ym}-${rand}`;
}

export const ensure_active_key = Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const cache = yield* KeyCacheTag.pipe(Effect.orElseSucceed(() => null));
    const active = yield* db_run(() => list_active_grant_keys.run(db, { limit: 5 }));
    const first = active[0];
    if (first) {
      if (cache) {
        const hit_opt = yield* cache.getOption(first.kid);
        if (hit_opt._tag === "Some") return { kid: first.kid, private_key: hit_opt.value };
      }
      const row = yield* db_run(() => get_grant_key_by_kid.run(db, { kid: first.kid }));
      if (!row || row.retired_at) return yield* Effect.fail(bad_request("signing key unavailable"));
      const seed = yield* Effect.try({
        try: () => decrypt_with_key(cfg.master_key.raw, new Uint8Array(row.private_seed_enc), SEED_PURPOSE),
        catch: () => unauthorized("signing key unavailable") });
      const private_key = yield* import_seed(seed, row.public_x);
      if (cache) yield* cache.set(first.kid, private_key).pipe(Effect.orElseSucceed(() => undefined));
      return { kid: first.kid, private_key };
    }
    // Generate the first (or replacement) signing key.
    const kp = (yield* Effect.promise(() =>
      crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
    )) as CryptoKeyPair;
    const priv = (yield* Effect.promise(() => export_jwk(kp.privateKey))) as { x?: string; d?: string };
    if (!priv.x || !priv.d) return yield* Effect.fail(bad_request("could not export key"));
    const kid = new_kid(cfg.now());
    const seed_enc = yield* Effect.sync(() =>
      encrypt_with_key(cfg.master_key.raw, base64url_decode(priv.d as string), SEED_PURPOSE),
    );
    yield* db_run(() => insert_grant_key.run(db, { kid, publicX: priv.x as string, privateSeedEnc: seed_enc }));
    const private_key = yield* import_seed(base64url_decode(priv.d as string), priv.x as string);
    if (cache) yield* cache.set(kid, private_key).pipe(Effect.orElseSucceed(() => undefined));
    return { kid, private_key };
  });

const import_seed = (seed: Uint8Array, x: string) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: "Ed25519", x, d: base64url_encode(seed), key_ops: ["sign"], ext: true } as JsonWebKey,
        { name: "Ed25519" },
        false,
        ["sign"],
      ),
    catch: () => unauthorized("signing key unavailable") });

export interface IssueGrantInput {
  readonly account_id: string;
  readonly audience: "ast-relay" | "ast-core";
  readonly scope: Array<"relay:connect" | "forge:execute" | "machine:sync">;
  readonly ttl_seconds?: number;
  readonly role: "client" | "forge";
  readonly mid: string;
  readonly cnf: { kty: "OKP"; crv: "Ed25519"; x: string };
}

export const issue_grant = (input: IssueGrantInput) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const ttl = input.ttl_seconds ?? GRANT_MAX_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > GRANT_MAX_TTL_SECONDS) {
      return yield* Effect.fail(bad_request("ttlSeconds must be 1..300"));
    }
    if (input.audience === "ast-core") {
      if (input.role !== "forge" || input.scope.length !== 1 || input.scope[0] !== "machine:sync") {
        return yield* Effect.fail(bad_request("ast-core grants are forge machine:sync only"));
      }
    } else if (!input.scope.includes("relay:connect")) {
      return yield* Effect.fail(bad_request("ast-relay grants require relay:connect"));
    }
    // The target machine must belong to the account and be live. Both
    // machine and session grant paths converge here.
    const m = yield* db_run(() => get_machine_by_id.run(db, { id: input.mid }));
    if (!m || m.account_id !== input.account_id || m.revoked_at) {
      return yield* Effect.fail(forbidden("unknown target machine in this account"));
    }
    if (input.role === "forge" && m.public_key_x !== input.cnf.x) {
      return yield* Effect.fail(forbidden("machine grant cnf must equal the enrolled key"));
    }
    const now_sec = Math.floor(cfg.now() / 1000);
    const claims = {
      v: 1 as const,
      iss: cfg.jwt_issuer,
      aud: input.audience,
      sub: input.account_id,
      mid: input.mid,
      role: input.role,
      cnf: { jwk: input.cnf },
      scope: [...input.scope],
      iat: now_sec,
      nbf: now_sec,
      exp: now_sec + ttl,
      jti: new_id("tkn") };
    const { kid, private_key } = yield* ensure_active_key;
    const token = yield* Effect.tryPromise({
      try: () =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
          .sign(private_key),
      catch: () => unauthorized("could not sign grant") as CoreError });
    yield* record(input.account_id, "grant.issued", {});
    return {
      token,
      expiresAt: new Date((now_sec + ttl) * 1000).toISOString(),
      claims };
  });

// JWKS for independent verification (Relay/Forge). Public keys only.
export const jwks = Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* db_run(() => list_recent_keys_for_jwks.run(db, {}));
    return {
      keys: rows.map((r) => ({
        kty: "OKP" as const,
        crv: "Ed25519" as const,
        x: r.public_x,
        kid: r.kid,
        use: "sig" as const,
        alg: "EdDSA" as const })) };
  });

export const revocations = Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const machines = yield* db_run(() => list_revoked_machine_ids.run(db, { limit: 1000 }));
    const keys = yield* db_run(() => list_retired_key_ids.run(db, { limit: 100 }));
    return {
      revokedMachineIds: machines.map((m) => m.id),
      revokedKeyIds: keys.map((k) => k.kid),
      asOf: new Date(cfg.now()).toISOString() };
  });

// Admin rotation (deployment credential CORE_ADMIN_TOKEN; endpoint 404s
// without one). New key issues immediately; retired keys stay in JWKS for
// the 15-minute grace window.
export const rotate_keys = Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const cache = yield* KeyCacheTag.pipe(Effect.orElseSucceed(() => null));
    const kp = (yield* Effect.promise(() =>
      crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
    )) as CryptoKeyPair;
    const priv = (yield* Effect.promise(() => export_jwk(kp.privateKey))) as { x?: string; d?: string };
    if (!priv.x || !priv.d) return yield* Effect.fail(bad_request("could not export key"));
    const kid = new_kid(cfg.now());
    const seed_enc = yield* Effect.sync(() =>
      encrypt_with_key(cfg.master_key.raw, base64url_decode(priv.d as string), SEED_PURPOSE),
    );
    yield* db_run(() => insert_grant_key.run(db, { kid, publicX: priv.x as string, privateSeedEnc: seed_enc }));
    const actives = yield* db_run(() => list_active_grant_keys.run(db, { limit: 10 }));
    for (const a of actives) {
      if (a.kid === kid) continue;
      yield* db_run(() => retire_grant_key.run(db, { kid: a.kid }));
      if (cache) yield* cache.invalidate(a.kid);
    }
    return { kid };
  });

// Verification helper mirroring what Relay/Forge implement independently
// (JWKS + iss/aud/exp/nbf + v/role/mid/scope; key-bound admission is the
// transport's transcript check). Used by tests to prove issued JWTs verify
// against the served JWKS.
export const verify_grant_with_jwks = (opts: { jwks: unknown; token: string; issuer: string; audience: string }) =>
  Effect.tryPromise({
    try: async () => {
      const { createLocalJWKSet: create_local_jwk_set } = await import("jose");
      const get_key = create_local_jwk_set(opts.jwks as Parameters<typeof create_local_jwk_set>[0]);
      const { payload, protectedHeader } = await jwt_verify(opts.token, get_key, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ["EdDSA"],
        clockTolerance: 60 });
      if (protectedHeader.alg !== "EdDSA" || (payload as { v?: number }).v !== 1) {
        throw new Error("unsupported grant");
      }
      return payload;
    },
    catch: () => unauthorized("invalid grant") as CoreError });
