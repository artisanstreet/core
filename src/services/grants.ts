import { Cache, Context, Effect, Layer } from "effect";
import { SignJWT, exportJWK, jwtVerify } from "jose";
import { base64urlDecode, base64urlEncode, decryptWithKey, encryptWithKey, randomBytes } from "../crypto.ts";
import { GRANT_MAX_TTL_SECONDS } from "../constants.ts";
import { badRequest, forbidden, unauthorized, type CoreError } from "../errors.ts";
import { newId } from "../ids.ts";
import { AppConfigTag, DbTag, dbRun } from "./deps.ts";
import { record } from "./activity.ts";
import insertGrantKey from "../db/queries/grants/insertGrantKey.sql";
import getGrantKeyByKid from "../db/queries/grants/getGrantKeyByKid.sql";
import listActiveGrantKeys from "../db/queries/grants/listActiveGrantKeys.sql";
import retireGrantKey from "../db/queries/grants/retireGrantKey.sql";
import listRecentKeysForJwks from "../db/queries/grants/listRecentKeysForJwks.sql";
import listRetiredKeyIds from "../db/queries/grants/listRetiredKeyIds.sql";
import listRevokedMachineIds from "../db/queries/grants/listRevokedMachineIds.sql";
import getMachineById from "../db/queries/machines/getMachineById.sql";

const SEED_PURPOSE = "grant-key-seed v1";

export class KeyCacheTag extends Context.Tag("GrantKeyCache")<
  KeyCacheTag,
  Cache.Cache<string, CryptoKey, CoreError>
>() {}

export const global_key_cache: Cache.Cache<string, CryptoKey, CoreError> = Effect.runSync(
  Cache.make({
    capacity: 8,
    timeToLive: "15 minutes",
    lookup: (_kid: string): Effect.Effect<CryptoKey, CoreError> => Effect.fail(badRequest("signing key unavailable")),
  }),
);

export const KeyCacheLive = Layer.succeed(KeyCacheTag, global_key_cache);

function newKid(nowMs: number): string {
  const d = new Date(nowMs);
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const rand = base64urlEncode(randomBytes(3)).toLowerCase();
  return `core-${ym}-${rand}`;
}

export const ensureActiveKey = Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const cache = yield* KeyCacheTag.pipe(Effect.orElseSucceed(() => null));
    const active = yield* dbRun(() => listActiveGrantKeys.run(db, { limit: 5 }));
    const first = active[0];
    if (first) {
      if (cache) {
        const hit_opt = yield* cache.getOption(first.kid);
        if (hit_opt._tag === "Some") return { kid: first.kid, privateKey: hit_opt.value };
      }
      const row = yield* dbRun(() => getGrantKeyByKid.run(db, { kid: first.kid }));
      if (!row || row.retired_at) return yield* Effect.fail(badRequest("signing key unavailable"));
      const seed = yield* Effect.tryPromise({
        try: () => decryptWithKey(cfg.masterKey.raw, new Uint8Array(row.private_seed_enc), SEED_PURPOSE),
        catch: () => unauthorized("signing key unavailable"),
      });
      const privateKey = yield* importSeed(seed, row.public_x);
      if (cache) yield* cache.set(first.kid, privateKey).pipe(Effect.orElseSucceed(() => undefined));
      return { kid: first.kid, privateKey };
    }
    // Generate the first (or replacement) signing key.
    const kp = (yield* Effect.promise(() =>
      crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
    )) as CryptoKeyPair;
    const priv = (yield* Effect.promise(() => exportJWK(kp.privateKey))) as { x?: string; d?: string };
    if (!priv.x || !priv.d) return yield* Effect.fail(badRequest("could not export key"));
    const kid = newKid(cfg.now());
    const seedEnc = yield* Effect.promise(() =>
      encryptWithKey(cfg.masterKey.raw, base64urlDecode(priv.d as string), SEED_PURPOSE),
    );
    yield* dbRun(() => insertGrantKey.run(db, { kid, publicX: priv.x as string, privateSeedEnc: seedEnc }));
    const privateKey = yield* importSeed(base64urlDecode(priv.d as string), priv.x as string);
    if (cache) yield* cache.set(kid, privateKey).pipe(Effect.orElseSucceed(() => undefined));
    return { kid, privateKey };
  });

const importSeed = (seed: Uint8Array, x: string) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: "Ed25519", x, d: base64urlEncode(seed), key_ops: ["sign"], ext: true } as JsonWebKey,
        { name: "Ed25519" },
        false,
        ["sign"],
      ),
    catch: () => unauthorized("signing key unavailable"),
  });

export interface IssueGrantInput {
  readonly accountId: string;
  readonly audience: "ast-relay" | "ast-core";
  readonly scope: Array<"relay:connect" | "forge:execute" | "machine:sync">;
  readonly ttlSeconds?: number;
  readonly role: "client" | "forge";
  readonly mid: string;
  readonly cnf: { kty: "OKP"; crv: "Ed25519"; x: string };
}

export const issueGrant = (input: IssueGrantInput) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const ttl = input.ttlSeconds ?? GRANT_MAX_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > GRANT_MAX_TTL_SECONDS) {
      return yield* Effect.fail(badRequest("ttlSeconds must be 1..300"));
    }
    if (input.audience === "ast-core") {
      if (input.role !== "forge" || input.scope.length !== 1 || input.scope[0] !== "machine:sync") {
        return yield* Effect.fail(badRequest("ast-core grants are forge machine:sync only"));
      }
    } else if (!input.scope.includes("relay:connect")) {
      return yield* Effect.fail(badRequest("ast-relay grants require relay:connect"));
    }
    // The target machine must belong to the account and be live. Both
    // machine and session grant paths converge here.
    const m = yield* dbRun(() => getMachineById.run(db, { id: input.mid }));
    if (!m || m.account_id !== input.accountId || m.revoked_at) {
      return yield* Effect.fail(forbidden("unknown target machine in this account"));
    }
    if (input.role === "forge" && m.public_key_x !== input.cnf.x) {
      return yield* Effect.fail(forbidden("machine grant cnf must equal the enrolled key"));
    }
    const nowSec = Math.floor(cfg.now() / 1000);
    const claims = {
      v: 1 as const,
      iss: cfg.jwtIssuer,
      aud: input.audience,
      sub: input.accountId,
      mid: input.mid,
      role: input.role,
      cnf: { jwk: input.cnf },
      scope: [...input.scope],
      iat: nowSec,
      nbf: nowSec,
      exp: nowSec + ttl,
      jti: newId("tkn"),
    };
    const { kid, privateKey } = yield* ensureActiveKey;
    const token = yield* Effect.tryPromise({
      try: () =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
          .sign(privateKey),
      catch: () => unauthorized("could not sign grant") as CoreError,
    });
    yield* record(input.accountId, "grant.issued", {});
    return {
      token,
      expiresAt: new Date((nowSec + ttl) * 1000).toISOString(),
      claims,
    };
  });

// JWKS for independent verification (Relay/Forge). Public keys only.
export const jwks = Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* dbRun(() => listRecentKeysForJwks.run(db, {}));
    return {
      keys: rows.map((r) => ({
        kty: "OKP" as const,
        crv: "Ed25519" as const,
        x: r.public_x,
        kid: r.kid,
        use: "sig" as const,
        alg: "EdDSA" as const,
      })),
    };
  });

export const revocations = Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const machines = yield* dbRun(() => listRevokedMachineIds.run(db, { limit: 1000 }));
    const keys = yield* dbRun(() => listRetiredKeyIds.run(db, { limit: 100 }));
    return {
      revokedMachineIds: machines.map((m) => m.id),
      revokedKeyIds: keys.map((k) => k.kid),
      asOf: new Date(cfg.now()).toISOString(),
    };
  });

// Admin rotation (deployment credential CORE_ADMIN_TOKEN; endpoint 404s
// without one). New key issues immediately; retired keys stay in JWKS for
// the 15-minute grace window.
export const rotateKeys = Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const cache = yield* KeyCacheTag.pipe(Effect.orElseSucceed(() => null));
    const kp = (yield* Effect.promise(() =>
      crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
    )) as CryptoKeyPair;
    const priv = (yield* Effect.promise(() => exportJWK(kp.privateKey))) as { x?: string; d?: string };
    if (!priv.x || !priv.d) return yield* Effect.fail(badRequest("could not export key"));
    const kid = newKid(cfg.now());
    const seedEnc = yield* Effect.promise(() =>
      encryptWithKey(cfg.masterKey.raw, base64urlDecode(priv.d as string), SEED_PURPOSE),
    );
    yield* dbRun(() => insertGrantKey.run(db, { kid, publicX: priv.x as string, privateSeedEnc: seedEnc }));
    const actives = yield* dbRun(() => listActiveGrantKeys.run(db, { limit: 10 }));
    for (const a of actives) {
      if (a.kid === kid) continue;
      yield* dbRun(() => retireGrantKey.run(db, { kid: a.kid }));
      if (cache) yield* cache.invalidate(a.kid);
    }
    return { kid };
  });

// Verification helper mirroring what Relay/Forge implement independently
// (JWKS + iss/aud/exp/nbf + v/role/mid/scope; key-bound admission is the
// transport's transcript check). Used by tests to prove issued JWTs verify
// against the served JWKS.
export const verifyGrantWithJwks = (opts: { jwks: unknown; token: string; issuer: string; audience: string }) =>
  Effect.tryPromise({
    try: async () => {
      const { createLocalJWKSet } = await import("jose");
      const getKey = createLocalJWKSet(opts.jwks as Parameters<typeof createLocalJWKSet>[0]);
      const { payload, protectedHeader } = await jwtVerify(opts.token, getKey, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ["EdDSA"],
        clockTolerance: 60,
      });
      if (protectedHeader.alg !== "EdDSA" || (payload as { v?: number }).v !== 1) {
        throw new Error("unsupported grant");
      }
      return payload;
    },
    catch: () => unauthorized("invalid grant") as CoreError,
  });
