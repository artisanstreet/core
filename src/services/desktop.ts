import { Effect, Option } from "effect";
import { base64url_encode, random_bytes, sha256_bytes, sha256_hex } from "../crypto.ts";
import { DESKTOP_GRANT_TTL_SECONDS, RATE_WINDOW_SECONDS } from "../constants.ts";
import { forbidden, unauthorized } from "../errors.ts";
import { AppConfigTag, DbTag, db_run } from "./deps.ts";
import { check_budget } from "./ratelimit.ts";
import { record } from "./activity.ts";
import { open_session, type SessionPrincipal } from "./auth.ts";
import type { Requester } from "./sign-in.ts";
import insert_desktop_grant from "../db/queries/desktop/insert-desktop-grant.sql"
import redeem_desktop_grant from "../db/queries/desktop/redeem-desktop-grant.sql"
import get_desktop_grant_factor from "../db/queries/desktop/get-desktop-grant-factor.sql"

const code_hash_of = (code: string) => sha256_hex(`ast-core desktop v1:${code}`);

const challenge_of = (verifier: string) => base64url_encode(sha256_bytes(verifier));

const invalid_sign_in = () => unauthorized("invalid or expired sign-in");

export const grant_desktop_code = (principal: SessionPrincipal, challenge: string, ip: string | null) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const now_ms = cfg.now();
    const totp_verified = principal.totp_verified_at !== null;
    yield* Effect.when(
      Effect.fail(forbidden("second factor required")),
      () => principal.totp_enrolled && !totp_verified,
    );
    yield* check_budget(`desktop:account:${principal.account_id}`, RATE_WINDOW_SECONDS, 30, now_ms);
    const code = base64url_encode(random_bytes(32));
    const expires_at = new Date(now_ms + DESKTOP_GRANT_TTL_SECONDS * 1000).toISOString();
    yield* db_run(() =>
      insert_desktop_grant.run(db, {
        code_hash: code_hash_of(code),
        challenge,
        account_id: principal.account_id,
        totp_verified,
        expires_at }),
    );
    yield* record(principal.account_id, "login.desktop_granted", { ip });
    return { code, expires_at };
  });

export const redeem_desktop_code = (opts: { code: string; verifier: string; requester: Requester }) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const now_ms = cfg.now();
    yield* Option.match(Option.fromNullable(opts.requester.ip), {
      onNone: () => Effect.void,
      onSome: (ip) => check_budget(`desktop:ip:${ip}`, RATE_WINDOW_SECONDS, 30, now_ms) });
    const code_hash = code_hash_of(opts.code);
    const factor = yield* db_run(() => get_desktop_grant_factor.run(db, { code_hash }));
    const { totp_verified } = yield* Effect.fromNullable(factor).pipe(Effect.mapError(invalid_sign_in));
    const gate = Effect.gen(function* () {
      const { db: tx_db } = yield* DbTag;
      const row = yield* db_run(() =>
        redeem_desktop_grant.run(tx_db, {
          code_hash,
          challenge: challenge_of(opts.verifier),
          now: new Date(now_ms).toISOString() }),
      );
      return yield* Effect.fromNullable(row).pipe(
        Effect.mapBoth({ onFailure: invalid_sign_in, onSuccess: (grant) => grant.account_id }),
      );
    });
    return yield* open_session(gate, {
      totp_verified,
      ip: opts.requester.ip,
      user_agent: opts.requester.user_agent,
      event: "login.desktop" });
  });
