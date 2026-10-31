import { Effect, Either } from "effect";
import { createTOTPKeyURI as create_totp_key_uri, verifyHOTP as verify_hotp } from "@oslojs/otp";
import { base64url_encode, decrypt_with_key, encrypt_with_key, random_bytes, sha256_hex } from "../crypto.ts";
import { MAGIC_LINK_TTL_SECONDS, RATE_WINDOW_SECONDS, SESSION_TTL_SECONDS } from "../constants.ts";
import { CoreError, bad_request, conflict, forbidden, gone, internal, unauthorized } from "../errors.ts";
import { new_id } from "../ids.ts";
import { AppConfigTag, DbTag, TxTag, db_run } from "./deps.ts";
import { check_budget } from "./ratelimit.ts";
import { record } from "./activity.ts";
import { MailTag } from "./mail.ts";
import insert_account from "../db/queries/accounts/insert-account.sql"
import get_account_by_id from "../db/queries/accounts/get-account-by-id.sql"
import get_account_by_email from "../db/queries/accounts/get-account-by-email.sql"
import stage_totp_secret from "../db/queries/accounts/stage-totp-secret.sql"
import promote_totp from "../db/queries/accounts/promote-totp.sql"
import clear_totp from "../db/queries/accounts/clear-totp.sql"
import claim_totp_step from "../db/queries/totp/claim-totp-step.sql"
import insert_activity from "../db/queries/activity/insert-activity.sql"
import insert_login_request from "../db/queries/login/insert-login-request.sql"
import get_login_request_by_email_token_hash from "../db/queries/login/get-login-request-by-email-token-hash.sql"
import get_login_request_by_id from "../db/queries/login/get-login-request-by-id.sql"
import mark_email_approved from "../db/queries/login/mark-email-approved.sql"
import mark_login_completed from "../db/queries/login/mark-login-completed.sql"
import insert_session from "../db/queries/sessions/insert-session.sql"
import get_session_with_account_by_token_hash from "../db/queries/sessions/get-session-with-account-by-token-hash.sql"
import revoke_session from "../db/queries/sessions/revoke-session.sql"
import revoke_sessions_by_account from "../db/queries/sessions/revoke-sessions-by-account.sql"
import list_sessions_by_account from "../db/queries/sessions/list-sessions-by-account.sql"
import insert_recovery_code from "../db/queries/recovery/insert-recovery-code.sql"
import count_active_recovery_codes from "../db/queries/recovery/count-active-recovery-codes.sql"
import consume_recovery_code from "../db/queries/recovery/consume-recovery-code.sql"
import purge_recovery_codes from "../db/queries/deletion/purge-recovery-codes.sql"
import insert_sign_in_method from "../db/queries/sign-in/insert-sign-in-method.sql"
import get_sign_in_method from "../db/queries/sign-in/get-sign-in-method.sql"

export interface SessionPrincipal {
  readonly session_id: string;
  readonly account_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly totp_enrolled: boolean;
  readonly totp_verified_at: string | null;
  readonly token_hash: string;
}

const SESSION_TOKEN_PREFIX = "ast_sess_";
const TOTP_PURPOSE = "totp-secret v1";

export function new_session_token(): string {
  return `${SESSION_TOKEN_PREFIX}${base64url_encode(random_bytes(32))}`;
}

const hash_secret = (s: string) =>
  Effect.sync(() => sha256_hex(`ast-core secret v1:${s}`));

// ---------------------------------------------------------------------------
// Magic link: request → (email) consume → finalize. The emailed token only
// ever marks approval; the request secret held by the originating session
// is what completes the login. GET never mutates.
// ---------------------------------------------------------------------------

export const request_magic_link = (opts: {
  email: string;
  display_name?: string;
  device_name?: string;
  ip?: string | null;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const mailer = yield* MailTag;
    const now_ms = cfg.now();
    const email = opts.email.trim().toLowerCase();

    // Six requests/hour per email leaves headroom for the legitimate
    // re-request pattern (lost/expired links) while still capping
    // mailbox bombing; IP and global budgets back it up.
    yield* check_budget(`login:email:${email}`, RATE_WINDOW_SECONDS, 10, now_ms);
    if (opts.ip) yield* check_budget(`login:ip:${opts.ip}`, RATE_WINDOW_SECONDS, 20, now_ms);
    yield* check_budget("login:global", RATE_WINDOW_SECONDS, 200, now_ms);

    const existing = yield* db_run(() => get_account_by_email.run(db, { email }));
    if (!existing) {
      const tx = yield* TxTag;
      const account_id = new_id("acct");
      yield* tx.transaction(
        Effect.gen(function* () {
          const { db: tx_db } = yield* DbTag;
          yield* db_run(() =>
            insert_account.run(tx_db, {
              id: account_id,
              email,
              display_name: (opts.display_name ?? "").slice(0, 120),
              avatar_url: null }),
          );
          yield* db_run(() => insert_sign_in_method.run(tx_db, { account_id, kind: "email", subject: email }));
        }),
      );
    }
    const account = existing ?? (yield* db_run(() => get_account_by_email.run(db, { email })));
    if (!account) return yield* Effect.fail(bad_request("could not load account"));
    if (account.deleted_at) return yield* Effect.fail(gone("account is deleted"));
    const email_method = yield* db_run(() => get_sign_in_method.run(db, { account_id: account.id, kind: "email" }));

    const request_secret = base64url_encode(random_bytes(32));
    const email_token = base64url_encode(random_bytes(32));
    const request_id = new_id("logreq");
    const expires_at = new Date(now_ms + MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
    const request_secret_hash = yield* hash_secret(request_secret);
    const email_token_hash = yield* hash_secret(email_token);
    yield* db_run(() =>
      insert_login_request.run(db, {
        id: request_id,
        email,
        request_secret_hash: request_secret_hash,
        email_token_hash: email_token_hash,
        totp_required: account.totp_enrolled_at != null,
        requester_ip: opts.ip ?? null,
        expires_at: expires_at }),
    );
    const approve_base = (cfg.auth_public_base_url ?? cfg.public_base_url).replace(/\/+$/, "");
    const confirm_url = cfg.auth_public_base_url
      ? `${approve_base}/approve?token=${email_token}`
      : `${approve_base}/v1/auth/magic/confirm?token=${email_token}`;
    yield* mailer.send(
      email_method
        ? {
            to: email,
            subject: "Sign in to Ast",
            text:
              `Approve this sign-in request (expires in 15 minutes):\n${confirm_url}\n\n` +
              `If you did not request this, ignore this message.`,
            confirm_url }
        : {
            to: email,
            subject: "Sign in to Ast",
            text:
              `Someone asked to sign in to your account with an email link, but email sign-in is off.\n` +
              `Sign in with the provider you linked instead: ${approve_base}\n\n` +
              `If you did not request this, ignore this message.`,
            confirm_url: approve_base },
    );
    yield* record(account.id, "login.requested", { ip: opts.ip ?? null });
    return { request_id: request_id, request_secret: request_secret, expires_at: expires_at };
  });

function request_status_of(row: { status: string; expires_at: string }, now_ms: number) {
  if (row.status === "completed") return "completed" as const;
  if (Date.parse(row.expires_at) <= now_ms || row.status === "expired") return "expired" as const;
  if (row.status === "email_approved") return "email_approved" as const;
  return "pending" as const;
}

export const consume_magic_link = (opts: { token: string; request_secret?: string; ip?: string | null }) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const now_ms = cfg.now();
    if (opts.ip) yield* check_budget(`consume:ip:${opts.ip}`, RATE_WINDOW_SECONDS, 30, now_ms);
    yield* check_budget("consume:global", RATE_WINDOW_SECONDS, 300, now_ms);

    const token_hash = yield* hash_secret(opts.token);
    const row = yield* db_run(() => get_login_request_by_email_token_hash.run(db, { email_token_hash: token_hash }));
    // Wrong/absent tokens reveal nothing and map to no request.
    if (!row) return yield* Effect.fail(unauthorized("invalid or expired link"));
    const status = request_status_of(row, now_ms);
    if (status !== "pending") {
      return { request_id: row.id, status, totp_required: row.totp_required };
    }
    const approved = yield* db_run(() => mark_email_approved.run(db, { id: row.id }));
    if (approved) {
      const acct = yield* db_run(() => get_account_by_email.run(db, { email: row.email }));
      if (acct) yield* record(acct.id, "login.email_approved", {});
      return { request_id: row.id, status: "email_approved" as const, totp_required: row.totp_required };
    }
    return { request_id: row.id, status: request_status_of({ ...row, status: "expired" }, now_ms), totp_required: row.totp_required };
  });

export const login_request_status = (opts: { request_id: string; request_secret: string }) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const row = yield* db_run(() => get_login_request_by_id.run(db, { id: opts.request_id }));
    if (!row) return yield* Effect.fail(unauthorized("invalid request"));
    const secret_hash = yield* hash_secret(opts.request_secret);
    if (secret_hash !== row.request_secret_hash) return yield* Effect.fail(unauthorized("invalid request"));
    return {
      request_id: row.id,
      status: request_status_of(row, cfg.now()),
      totp_required: row.totp_required,
      email: row.email,
      expires_at: row.expires_at };
  });

export const finalize_magic_link = (opts: {
  request_id: string;
  request_secret: string;
  totp_code?: string;
  recovery_code?: string;
  device_name?: string;
  ip?: string | null;
  user_agent?: string | null;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const now_ms = cfg.now();
    const row = yield* db_run(() => get_login_request_by_id.run(db, { id: opts.request_id }));
    if (!row) return yield* Effect.fail(unauthorized("invalid request"));
    const secret_hash = yield* hash_secret(opts.request_secret);
    if (secret_hash !== row.request_secret_hash) return yield* Effect.fail(unauthorized("invalid request"));
    if (request_status_of(row, now_ms) === "expired") return yield* Effect.fail(gone("request expired"));
    if (row.status !== "email_approved") {
      return yield* Effect.fail(forbidden("email approval required first"));
    }
    const account = yield* db_run(() => get_account_by_email.run(db, { email: row.email }));
    if (!account || account.deleted_at) return yield* Effect.fail(gone("account is deleted"));

    // Email alone never bypasses TOTP.
    let totp_verified = false;
    if (account.totp_enrolled_at != null) {
      const ok = yield* satisfy_totp_challenge(account.id, opts.totp_code, opts.recovery_code, opts.ip ?? null, now_ms);
      if (!ok) return yield* Effect.fail(forbidden("second factor required"));
      totp_verified = true;
    }
    const email_method = yield* db_run(() => get_sign_in_method.run(db, { account_id: account.id, kind: "email" }));
    if (!email_method) return yield* Effect.fail(forbidden("email sign-in is off"));

    const gate = Effect.gen(function* () {
      const { db: tx_db } = yield* DbTag;
      const completed = yield* db_run(() => mark_login_completed.run(tx_db, { id: row.id }));
      if (!completed) return yield* Effect.fail(forbidden("already completed or expired"));
      return account.id;
    });
    return yield* open_session(gate, {
      totp_verified,
      device_name: opts.device_name,
      ip: opts.ip ?? null,
      user_agent: opts.user_agent ?? null,
      event: "login.completed" });
  });

export interface SessionOpening {
  readonly totp_verified: boolean;
  readonly device_name?: string;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly event: string;
}

export const open_session = <E>(gate: Effect.Effect<string, E | CoreError, DbTag>, opening: SessionOpening) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfigTag;
    const tx = yield* TxTag;
    const now_ms = cfg.now();
    const token = new_session_token();
    const token_hash = yield* hash_secret(token);
    const expires_at = new Date(now_ms + SESSION_TTL_SECONDS * 1000).toISOString();
    const opened = yield* tx.transaction(
      Effect.gen(function* () {
        const account_id = yield* gate;
        const { db: tx_db } = yield* DbTag;
        const session = yield* db_run(() =>
          insert_session.run(tx_db, {
            id: new_id("sess"),
            account_id,
            token_hash,
            device_name: (opening.device_name ?? "").slice(0, 120),
            ip: opening.ip,
            user_agent: (opening.user_agent ?? "").slice(0, 300),
            totp_verified_at: opening.totp_verified ? new Date(now_ms).toISOString() : null,
            expires_at }),
        );
        if (!session) return yield* Effect.fail(internal("database unavailable"));
        yield* db_run(() =>
          insert_activity.run(tx_db, {
            id: new_id("evt"),
            account_id,
            machine_id: null,
            kind: opening.event,
            detail: "{}",
            ip: opening.ip }),
        );
        return { session_id: session.id, account_id };
      }),
    );
    return {
      session_id: opened.session_id,
      raw_token: token,
      account_id: opened.account_id,
      expires_at,
      totp_verified: opening.totp_verified };
  });

// Match a 6-digit code against explicit time-steps around now (±2 steps
// covers the 60 s grace window). Returns the matched step so the caller can
// claim it for durable single-use. Malformed input matches nothing.
function match_totp_step(secret: Uint8Array, code: string, now_ms: number): bigint | null {
  const c = code.trim();
  if (!/^[0-9]{6}$/.test(c)) return null;
  const base = Math.floor(now_ms / 30000);
  for (let k = -2; k <= 2; k++) {
    const attempt = Either.try(() => verify_hotp(secret, BigInt(base + k), 6, c));
    if (Either.isLeft(attempt)) return null;
    if (attempt.right) return BigInt(base + k);
  }
  return null;
}

// Attempt budget (durable, per account) + step claim (durable, single-use).
// Both checks live in the database so every isolate enforces them.
const consume_totp_attempt = (account_id: string, secret: Uint8Array, code: string | undefined, now_ms: number) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    yield* check_budget(`totp:account:${account_id}`, RATE_WINDOW_SECONDS, 10, now_ms);
    if (!code) return false;
    const step = match_totp_step(secret, code, now_ms);
    if (step === null) return false;
    // Null means this exact code was already consumed in its window
    // (replay), or a concurrent attempt won the race.
    const claimed = yield* db_run(() => claim_totp_step.run(db, { account_id: account_id, step }));
    return claimed !== null;
  });

const decrypt_secret = (enc: Uint8Array, master_key: Uint8Array) =>
  Effect.try({
        try: () => decrypt_with_key(master_key, new Uint8Array(enc), TOTP_PURPOSE),
    catch: () => unauthorized("second factor required") });

const satisfy_totp_challenge = (
  account_id: string,
  totp_code: string | undefined,
  recovery_code: string | undefined,
  ip: string | null,
  now_ms: number,
) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    if (ip) yield* check_budget(`totp:ip:${ip}`, RATE_WINDOW_SECONDS, 30, now_ms);
    const account = yield* db_run(() => get_account_by_id.run(db, { id: account_id }));
    if (!account?.totp_secret_enc) return false;
    const secret = yield* decrypt_secret(account.totp_secret_enc, cfg.master_key.raw);
    if (totp_code && (yield* consume_totp_attempt(account_id, secret, totp_code, now_ms))) return true;
    if (recovery_code) {
      yield* check_budget(`totp:account:${account_id}`, RATE_WINDOW_SECONDS, 10, now_ms);
      const code_hash = yield* hash_secret(recovery_code.trim());
      const used = yield* db_run(() => consume_recovery_code.run(db, { account_id: account_id, code_hash: code_hash }));
      if (used) {
        yield* record(account_id, "totp.recovery_used", {});
        return true;
      }
    }
    return false;
  });

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const require_session = (raw_token: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const token_hash = yield* hash_secret(raw_token);
    const row = yield* db_run(() => get_session_with_account_by_token_hash.run(db, { token_hash: token_hash }));
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= cfg.now() || row.deleted_at) {
      return yield* Effect.fail(unauthorized("invalid session"));
    }
    const principal: SessionPrincipal = {
      session_id: row.id,
      account_id: row.account_id,
      email: row.email,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      totp_enrolled: row.totp_enrolled_at != null,
      totp_verified_at: row.totp_verified_at,
      token_hash };
    return principal;
  });

export const revoke_current_session = (raw_token: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const token_hash = yield* hash_secret(raw_token);
    yield* db_run(() => revoke_session.run(db, { token_hash: token_hash }));
  });

export const revoke_all_sessions = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    yield* db_run(() => revoke_sessions_by_account.run(db, { account_id: account_id }));
    yield* record(account_id, "sessions.revoked_all", {});
  });

export const list_sessions = (account_id: string, limit: number) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* db_run(() => list_sessions_by_account.run(db, { account_id: account_id, limit }));
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        device_name: r.device_name,
        totp_verified_at: r.totp_verified_at,
        created_at: r.created_at,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at })) };
  });

// ---------------------------------------------------------------------------
// TOTP + recovery codes
// ---------------------------------------------------------------------------

export const enroll_totp = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const existing = yield* db_run(() => get_account_by_id.run(db, { id: account_id }));
    // A stolen session must not silently swap the factor: replacing MFA
    // goes through disable (which verifies the live code) first.
    if (!existing) return yield* Effect.fail(bad_request("no such account"));
    if (existing.totp_enrolled_at != null) {
      return yield* Effect.fail(conflict("totp already enrolled; disable it first"));
    }
    // Fresh code set each enrollment; stale codes from a prior factor die.
    yield* db_run(() => purge_recovery_codes.run(db, { account_id: account_id }));
    const secret = random_bytes(20);
    const enc = yield* Effect.sync(() => encrypt_with_key(cfg.master_key.raw, secret, TOTP_PURPOSE));
    const staged = yield* db_run(() => stage_totp_secret.run(db, { id: account_id, secret_enc: enc }));
    if (!staged) return yield* Effect.fail(conflict("totp already enrolled; disable it first"));
    const codes = Array.from({ length: 10 }, () => base64url_encode(random_bytes(9)));
    for (const code of codes) {
      const code_hash = yield* hash_secret(code);
      yield* db_run(() => insert_recovery_code.run(db, { id: new_id("rc"), account_id: account_id, code_hash: code_hash }));
    }
    const otpauth_url = create_totp_key_uri("Ast", account_id, secret, 30, 6);
    yield* record(account_id, "totp.enroll_started", {});
    return { otpauth_url: otpauth_url, recovery_codes: codes };
  });

export const verify_totp_enroll = (account_id: string, code: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const account = yield* db_run(() => get_account_by_id.run(db, { id: account_id }));
    if (!account) return yield* Effect.fail(bad_request("no such account"));
    if (account.totp_enrolled_at != null) return yield* Effect.fail(conflict("totp already enrolled"));
    if (!account.totp_pending_secret_enc) return yield* Effect.fail(bad_request("no pending enrollment"));
    const secret = yield* decrypt_secret(new Uint8Array(account.totp_pending_secret_enc), cfg.master_key.raw);
    const ok = yield* consume_totp_attempt(account_id, secret, code, cfg.now());
    if (!ok) return yield* Effect.fail(forbidden("invalid code"));
    yield* db_run(() => promote_totp.run(db, { id: account_id }));
    yield* record(account_id, "totp.enrolled", {});
    return { enrolled: true };
  });

export const disable_totp = (account_id: string, code: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const account = yield* db_run(() => get_account_by_id.run(db, { id: account_id }));
    if (!account?.totp_secret_enc || account.totp_enrolled_at == null) {
      return yield* Effect.fail(bad_request("totp is not enrolled"));
    }
    const secret = yield* decrypt_secret(new Uint8Array(account.totp_secret_enc), cfg.master_key.raw);
    const ok = yield* consume_totp_attempt(account_id, secret, code, cfg.now());
    if (!ok) return yield* Effect.fail(forbidden("invalid code"));
    yield* db_run(() => clear_totp.run(db, { id: account_id }));
    yield* db_run(() => purge_recovery_codes.run(db, { account_id: account_id }));
    yield* record(account_id, "totp.disabled", {});
    return { disabled: true };
  });

export const count_recovery_codes = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => count_active_recovery_codes.run(db, { account_id: account_id }));
    return row.n;
  });

export const assert_second_factor = (
  account_id: string,
  opts: { totp_code?: string; recovery_code?: string },
) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfigTag;
    const ok = yield* satisfy_totp_challenge(account_id, opts.totp_code, opts.recovery_code, null, cfg.now());
    if (!ok) return yield* Effect.fail(forbidden("second factor required"));
  });
