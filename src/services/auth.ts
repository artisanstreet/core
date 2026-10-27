import { Effect } from "effect";
import { createTOTPKeyURI, verifyHOTP } from "@oslojs/otp";
import {
  base64urlEncode,
  decryptWithKey,
  encryptWithKey,
  randomBytes,
  sha256Hex,
} from "../crypto.ts";
import { MAGIC_LINK_TTL_SECONDS, RATE_WINDOW_SECONDS, SESSION_TTL_SECONDS } from "../constants.ts";
import { CoreError, badRequest, conflict, forbidden, gone, internal, unauthorized } from "../errors.ts";
import { newId } from "../ids.ts";
import { AppConfigTag, DbTag, TxTag, dbRun } from "./deps.ts";
import { checkBudget } from "./ratelimit.ts";
import { record } from "./activity.ts";
import { MailTag } from "./mail.ts";
import insertAccount from "../db/queries/accounts/insertAccount.sql";
import getAccountById from "../db/queries/accounts/getAccountById.sql";
import getAccountByEmail from "../db/queries/accounts/getAccountByEmail.sql";
import stageTotpSecret from "../db/queries/accounts/stageTotpSecret.sql";
import promoteTotp from "../db/queries/accounts/promoteTotp.sql";
import clearTotp from "../db/queries/accounts/clearTotp.sql";
import claimTotpStep from "../db/queries/totp/claimTotpStep.sql";
import insertActivity from "../db/queries/activity/insertActivity.sql";
import insertLoginRequest from "../db/queries/login/insertLoginRequest.sql";
import getLoginRequestByEmailTokenHash from "../db/queries/login/getLoginRequestByEmailTokenHash.sql";
import getLoginRequestById from "../db/queries/login/getLoginRequestById.sql";
import markEmailApproved from "../db/queries/login/markEmailApproved.sql";
import markLoginCompleted from "../db/queries/login/markLoginCompleted.sql";
import insertSession from "../db/queries/sessions/insertSession.sql";
import getSessionWithAccountByTokenHash from "../db/queries/sessions/getSessionWithAccountByTokenHash.sql";
import revokeSession from "../db/queries/sessions/revokeSession.sql";
import revokeSessionsByAccount from "../db/queries/sessions/revokeSessionsByAccount.sql";
import listSessionsByAccount from "../db/queries/sessions/listSessionsByAccount.sql";
import insertRecoveryCode from "../db/queries/recovery/insertRecoveryCode.sql";
import countActiveRecoveryCodes from "../db/queries/recovery/countActiveRecoveryCodes.sql";
import consumeRecoveryCode from "../db/queries/recovery/consumeRecoveryCode.sql";
import purgeRecoveryCodes from "../db/queries/deletion/purgeRecoveryCodes.sql";

export interface SessionPrincipal {
  readonly sessionId: string;
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string;
  readonly totpEnrolled: boolean;
  readonly totpVerifiedAt: string | null;
  readonly tokenHash: string;
}

const SESSION_TOKEN_PREFIX = "ast_sess_";
const TOTP_PURPOSE = "totp-secret v1";

export function newSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${base64urlEncode(randomBytes(32))}`;
}

function hashSecret(s: string) {
  return Effect.promise(() => sha256Hex(`ast-core secret v1:${s}`));
}

// ---------------------------------------------------------------------------
// Magic link: request → (email) consume → finalize. The emailed token only
// ever marks approval; the request secret held by the originating session
// is what completes the login. GET never mutates.
// ---------------------------------------------------------------------------

export function requestMagicLink(opts: {
  email: string;
  displayName?: string;
  deviceName?: string;
  ip?: string | null;
}) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const mailer = yield* MailTag;
    const nowMs = cfg.now();
    const email = opts.email.trim().toLowerCase();

    // Six requests/hour per email leaves headroom for the legitimate
    // re-request pattern (lost/expired links) while still capping
    // mailbox bombing; IP and global budgets back it up.
    yield* checkBudget(`login:email:${email}`, RATE_WINDOW_SECONDS, 10, nowMs);
    if (opts.ip) yield* checkBudget(`login:ip:${opts.ip}`, RATE_WINDOW_SECONDS, 20, nowMs);
    yield* checkBudget("login:global", RATE_WINDOW_SECONDS, 200, nowMs);

    let account = yield* dbRun(() => getAccountByEmail.run(db, { email }));
    if (!account) {
      yield* dbRun(() =>
        insertAccount.run(db, {
          id: newId("acct"),
          email,
          displayName: (opts.displayName ?? "").slice(0, 120),
        }),
      );
      account = yield* dbRun(() => getAccountByEmail.run(db, { email }));
    }
    if (!account) return yield* Effect.fail(badRequest("could not load account"));
    if (account.deleted_at) return yield* Effect.fail(gone("account is deleted"));

    const requestSecret = base64urlEncode(randomBytes(32));
    const emailToken = base64urlEncode(randomBytes(32));
    const requestId = newId("logreq");
    const expiresAt = new Date(nowMs + MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
    const requestSecretHash = yield* hashSecret(requestSecret);
    const emailTokenHash = yield* hashSecret(emailToken);
    yield* dbRun(() =>
      insertLoginRequest.run(db, {
        id: requestId,
        email,
        requestSecretHash,
        emailTokenHash,
        totpRequired: account.totp_enrolled_at != null,
        requesterIp: opts.ip ?? null,
        expiresAt,
      }),
    );
    const confirmUrl = `${cfg.publicBaseUrl}/v1/auth/magic/confirm?token=${emailToken}`;
    yield* mailer.send({
      to: email,
      subject: "Sign in to Ast",
      text:
        `Approve this sign-in request (expires in 15 minutes):\n${confirmUrl}\n\n` +
        `If you did not request this, ignore this message.`,
      confirmUrl,
    });
    yield* record(account.id, "login.requested", { ip: opts.ip ?? null });
    return { requestId, requestSecret, expiresAt };
  });
}

function requestStatusOf(row: { status: string; expires_at: string }, nowMs: number) {
  if (row.status === "completed") return "completed" as const;
  if (Date.parse(row.expires_at) <= nowMs || row.status === "expired") return "expired" as const;
  if (row.status === "email_approved") return "email_approved" as const;
  return "pending" as const;
}

export function consumeMagicLink(opts: { token: string; requestSecret?: string; ip?: string | null }) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const nowMs = cfg.now();
    if (opts.ip) yield* checkBudget(`consume:ip:${opts.ip}`, RATE_WINDOW_SECONDS, 30, nowMs);
    yield* checkBudget("consume:global", RATE_WINDOW_SECONDS, 300, nowMs);

    const tokenHash = yield* hashSecret(opts.token);
    const row = yield* dbRun(() => getLoginRequestByEmailTokenHash.run(db, { emailTokenHash: tokenHash }));
    // Wrong/absent tokens reveal nothing and map to no request.
    if (!row) return yield* Effect.fail(unauthorized("invalid or expired link"));
    const status = requestStatusOf(row, nowMs);
    if (status !== "pending") {
      return { requestId: row.id, status, totpRequired: row.totp_required };
    }
    const approved = yield* dbRun(() => markEmailApproved.run(db, { id: row.id }));
    if (approved) {
      const acct = yield* dbRun(() => getAccountByEmail.run(db, { email: row.email }));
      if (acct) yield* record(acct.id, "login.email_approved", {});
      return { requestId: row.id, status: "email_approved" as const, totpRequired: row.totp_required };
    }
    return { requestId: row.id, status: requestStatusOf({ ...row, status: "expired" }, nowMs), totpRequired: row.totp_required };
  });
}

export function loginRequestStatus(opts: { requestId: string; requestSecret: string }) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const row = yield* dbRun(() => getLoginRequestById.run(db, { id: opts.requestId }));
    if (!row) return yield* Effect.fail(unauthorized("invalid request"));
    const secretHash = yield* hashSecret(opts.requestSecret);
    if (secretHash !== row.request_secret_hash) return yield* Effect.fail(unauthorized("invalid request"));
    return {
      requestId: row.id,
      status: requestStatusOf(row, cfg.now()),
      totpRequired: row.totp_required,
      email: row.email,
      expiresAt: row.expires_at,
    };
  });
}

export function finalizeMagicLink(opts: {
  requestId: string;
  requestSecret: string;
  totpCode?: string;
  recoveryCode?: string;
  deviceName?: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const nowMs = cfg.now();
    const row = yield* dbRun(() => getLoginRequestById.run(db, { id: opts.requestId }));
    if (!row) return yield* Effect.fail(unauthorized("invalid request"));
    const secretHash = yield* hashSecret(opts.requestSecret);
    if (secretHash !== row.request_secret_hash) return yield* Effect.fail(unauthorized("invalid request"));
    if (requestStatusOf(row, nowMs) === "expired") return yield* Effect.fail(gone("request expired"));
    if (row.status !== "email_approved") {
      return yield* Effect.fail(forbidden("email approval required first"));
    }
    const account = yield* dbRun(() => getAccountByEmail.run(db, { email: row.email }));
    if (!account || account.deleted_at) return yield* Effect.fail(gone("account is deleted"));

    // Email alone never bypasses TOTP.
    let totpVerified = false;
    if (account.totp_enrolled_at != null) {
      const ok = yield* satisfyTotpChallenge(account.id, opts.totpCode, opts.recoveryCode, opts.ip ?? null, nowMs);
      if (!ok) return yield* Effect.fail(forbidden("second factor required"));
      totpVerified = true;
    }
    // Atomic single-use: completion, session, and audit commit together, so
    // a crash cannot burn the request while stranding the login. Exactly one
    // finalize wins the markLoginCompleted race; losers see no row.
    const tx = yield* TxTag;
    const token = newSessionToken();
    const tokenHash = yield* hashSecret(token);
    const expiresAt = new Date(nowMs + SESSION_TTL_SECONDS * 1000).toISOString();
    const sess = yield* tx.transaction(
      Effect.gen(function* () {
        const { db: tx_db } = yield* DbTag;
        const completed = yield* dbRun(() => markLoginCompleted.run(tx_db, { id: row.id }));
        if (!completed) return yield* Effect.fail(forbidden("already completed or expired"));
        const s = yield* dbRun(() =>
          insertSession.run(tx_db, {
            id: newId("sess"),
            accountId: account!.id,
            tokenHash,
            deviceName: (opts.deviceName ?? "").slice(0, 120),
            ip: opts.ip ?? null,
            userAgent: (opts.userAgent ?? "").slice(0, 300),
            totpVerifiedAt: totpVerified ? new Date(nowMs).toISOString() : null,
            expiresAt,
          }),
        );
        if (!s) return yield* Effect.fail(internal("database unavailable"));
        yield* dbRun(() =>
          insertActivity.run(tx_db, {
            id: newId("evt"),
            accountId: account!.id,
            machineId: null,
            kind: "login.completed",
            detail: "{}",
            ip: opts.ip ?? null,
          }),
        );
        return s;
      }),
    );
    return {
      sessionId: sess.id,
      rawToken: token,
      accountId: account.id,
      expiresAt,
      totpVerified,
    };
  });
}

// Match a 6-digit code against explicit time-steps around now (±2 steps
// covers the 60 s grace window). Returns the matched step so the caller can
// claim it for durable single-use. Malformed input matches nothing.
function matchTotpStep(secret: Uint8Array, code: string, nowMs: number): bigint | null {
  const c = code.trim();
  if (!/^[0-9]{6}$/.test(c)) return null;
  const base = Math.floor(nowMs / 30000);
  for (let k = -2; k <= 2; k++) {
    try {
      if (verifyHOTP(secret, BigInt(base + k), 6, c)) return BigInt(base + k);
    } catch {
      return null;
    }
  }
  return null;
}

// Attempt budget (durable, per account) + step claim (durable, single-use).
// Both checks live in the database so every isolate enforces them.
function consumeTotpAttempt(accountId: string, secret: Uint8Array, code: string | undefined, nowMs: number) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    yield* checkBudget(`totp:account:${accountId}`, RATE_WINDOW_SECONDS, 10, nowMs);
    if (!code) return false;
    const step = matchTotpStep(secret, code, nowMs);
    if (step === null) return false;
    // Null means this exact code was already consumed in its window
    // (replay), or a concurrent attempt won the race.
    const claimed = yield* dbRun(() => claimTotpStep.run(db, { accountId, step }));
    return claimed !== null;
  });
}

function decryptSecret(enc: Uint8Array, masterKey: Uint8Array) {
  return Effect.tryPromise({
    try: () => decryptWithKey(masterKey, new Uint8Array(enc), TOTP_PURPOSE),
    catch: () => unauthorized("second factor required"),
  });
}

function satisfyTotpChallenge(
  accountId: string,
  totpCode: string | undefined,
  recoveryCode: string | undefined,
  ip: string | null,
  nowMs: number,
): Effect.Effect<boolean, CoreError, import("./deps.ts").DbTag | AppConfigTag> {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    if (ip) yield* checkBudget(`totp:ip:${ip}`, RATE_WINDOW_SECONDS, 30, nowMs);
    const account = yield* dbRun(() => getAccountById.run(db, { id: accountId }));
    if (!account?.totp_secret_enc) return false;
    const secret = yield* decryptSecret(account.totp_secret_enc, cfg.masterKey.raw);
    if (totpCode && (yield* consumeTotpAttempt(accountId, secret, totpCode, nowMs))) return true;
    if (recoveryCode) {
      yield* checkBudget(`totp:account:${accountId}`, RATE_WINDOW_SECONDS, 10, nowMs);
      const codeHash = yield* hashSecret(recoveryCode.trim());
      const used = yield* dbRun(() => consumeRecoveryCode.run(db, { accountId, codeHash }));
      if (used) {
        yield* record(accountId, "totp.recovery_used", {});
        return true;
      }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function requireSession(rawToken: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const tokenHash = yield* hashSecret(rawToken);
    const row = yield* dbRun(() => getSessionWithAccountByTokenHash.run(db, { tokenHash }));
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= cfg.now() || row.deleted_at) {
      return yield* Effect.fail(unauthorized("invalid session"));
    }
    const principal: SessionPrincipal = {
      sessionId: row.id,
      accountId: row.account_id,
      email: row.email,
      displayName: row.display_name,
      totpEnrolled: row.totp_enrolled_at != null,
      totpVerifiedAt: row.totp_verified_at,
      tokenHash,
    };
    return principal;
  });
}

export function revokeCurrentSession(rawToken: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const tokenHash = yield* hashSecret(rawToken);
    yield* dbRun(() => revokeSession.run(db, { tokenHash }));
  });
}

export function revokeAllSessions(accountId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    yield* dbRun(() => revokeSessionsByAccount.run(db, { accountId }));
    yield* record(accountId, "sessions.revoked_all", {});
  });
}

export function listSessions(accountId: string, limit: number) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* dbRun(() => listSessionsByAccount.run(db, { accountId, limit }));
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        deviceName: r.device_name,
        totpVerifiedAt: r.totp_verified_at,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// TOTP + recovery codes
// ---------------------------------------------------------------------------

export function enrollTotp(accountId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const existing = yield* dbRun(() => getAccountById.run(db, { id: accountId }));
    // A stolen session must not silently swap the factor: replacing MFA
    // goes through disable (which verifies the live code) first.
    if (!existing) return yield* Effect.fail(badRequest("no such account"));
    if (existing.totp_enrolled_at != null) {
      return yield* Effect.fail(conflict("totp already enrolled; disable it first"));
    }
    // Fresh code set each enrollment; stale codes from a prior factor die.
    yield* dbRun(() => purgeRecoveryCodes.run(db, { accountId }));
    const secret = randomBytes(20);
    const enc = yield* Effect.promise(() => encryptWithKey(cfg.masterKey.raw, secret, TOTP_PURPOSE));
    const staged = yield* dbRun(() => stageTotpSecret.run(db, { id: accountId, secretEnc: enc }));
    if (!staged) return yield* Effect.fail(conflict("totp already enrolled; disable it first"));
    const codes = Array.from({ length: 10 }, () => base64urlEncode(randomBytes(9)));
    for (const code of codes) {
      const codeHash = yield* hashSecret(code);
      yield* dbRun(() => insertRecoveryCode.run(db, { id: newId("rc"), accountId, codeHash }));
    }
    const otpauthUrl = createTOTPKeyURI("Ast", accountId, secret, 30, 6);
    yield* record(accountId, "totp.enroll_started", {});
    return { otpauthUrl, recoveryCodes: codes };
  });
}

export function verifyTotpEnroll(accountId: string, code: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const account = yield* dbRun(() => getAccountById.run(db, { id: accountId }));
    if (!account) return yield* Effect.fail(badRequest("no such account"));
    if (account.totp_enrolled_at != null) return yield* Effect.fail(conflict("totp already enrolled"));
    if (!account.totp_pending_secret_enc) return yield* Effect.fail(badRequest("no pending enrollment"));
    const secret = yield* decryptSecret(new Uint8Array(account.totp_pending_secret_enc), cfg.masterKey.raw);
    const ok = yield* consumeTotpAttempt(accountId, secret, code, cfg.now());
    if (!ok) return yield* Effect.fail(forbidden("invalid code"));
    yield* dbRun(() => promoteTotp.run(db, { id: accountId }));
    yield* record(accountId, "totp.enrolled", {});
    return { enrolled: true };
  });
}

export function disableTotp(accountId: string, code: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const account = yield* dbRun(() => getAccountById.run(db, { id: accountId }));
    if (!account?.totp_secret_enc || account.totp_enrolled_at == null) {
      return yield* Effect.fail(badRequest("totp is not enrolled"));
    }
    const secret = yield* decryptSecret(new Uint8Array(account.totp_secret_enc), cfg.masterKey.raw);
    const ok = yield* consumeTotpAttempt(accountId, secret, code, cfg.now());
    if (!ok) return yield* Effect.fail(forbidden("invalid code"));
    yield* dbRun(() => clearTotp.run(db, { id: accountId }));
    yield* dbRun(() => purgeRecoveryCodes.run(db, { accountId }));
    yield* record(accountId, "totp.disabled", {});
    return { disabled: true };
  });
}

export function countRecoveryCodes(accountId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => countActiveRecoveryCodes.run(db, { accountId }));
    return row.n;
  });
}

export function assertSecondFactor(
  accountId: string,
  opts: { totpCode?: string; recoveryCode?: string },
) {
  return Effect.gen(function* () {
    const cfg = yield* AppConfigTag;
    const ok = yield* satisfyTotpChallenge(accountId, opts.totpCode, opts.recoveryCode, null, cfg.now());
    if (!ok) return yield* Effect.fail(forbidden("second factor required"));
  });
}
