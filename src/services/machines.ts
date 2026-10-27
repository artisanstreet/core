import { Effect } from "effect";
import { base64url_decode, base64url_encode, random_bytes, sha256_bytes, sha256_hex } from "../crypto.ts";
import { ENROLLMENT_TTL_SECONDS, LOGIN_CODE_ALPHABET, RATE_WINDOW_SECONDS } from "../constants.ts";
import { bad_request, forbidden, unauthorized } from "../errors.ts";
import { new_id } from "../ids.ts";
import { AppConfigTag, DbTag, db_run } from "./deps.ts";
import { check_budget } from "./ratelimit.ts";
import { record } from "./activity.ts";
import get_account_by_id from "../db/queries/accounts/get-account-by-id.sql"
import insert_enrollment from "../db/queries/enrollments/insert-enrollment.sql"
import get_enrollment_by_id from "../db/queries/enrollments/get-enrollment-by-id.sql"
import get_enrollment_by_code_hash from "../db/queries/enrollments/get-enrollment-by-code-hash.sql"
import claim_enrollment from "../db/queries/enrollments/claim-enrollment.sql"
import confirm_enrollment from "../db/queries/enrollments/confirm-enrollment.sql"
import insert_machine from "../db/queries/machines/insert-machine.sql"
import get_machine_by_id from "../db/queries/machines/get-machine-by-id.sql"
import list_machines_by_account from "../db/queries/machines/list-machines-by-account.sql"
import revoke_machine from "../db/queries/machines/revoke-machine.sql"
import touch_machine_last_seen from "../db/queries/machines/touch-machine-last-seen.sql"
import insert_nonce from "../db/queries/nonces/insert-nonce.sql"

export interface MachinePrincipal {
  readonly machine_id: string;
  readonly account_id: string;
}

const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const fingerprint_of_public_key_x = (x: string) =>
  Effect.sync(() => base64url_encode(sha256_bytes(base64url_decode(x))));

export const verify_ed25519 = (public_key_x: string, signature_b64: string, message: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: "Ed25519", x: public_key_x, key_ops: ["verify"], ext: true } as JsonWebKey,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const sig_bytes = base64url_decode(signature_b64);
      const sig_copy = new Uint8Array(sig_bytes);
      const msg_copy = new Uint8Array(message);
      return crypto.subtle.verify({ name: "Ed25519" }, key, sig_copy, msg_copy);
    },
    catch: () => unauthorized("invalid signature") });

// Canonical request proof (§3): verifies timestamp window, recomputes the
// body hash, verifies the Ed25519 signature FIRST, then atomically claims
// the nonce (durable replay protection). Signature-first ordering keeps
// unauthenticated invalid signatures from filling the replay table or
// poisoning a nonce the legitimate holder will use; the nonce is part of
// the signed canonical string, so the later claim stays bound to exactly
// what was verified. Any failure is a generic 401.
export const verify_machine_proof = (opts: {
  subject_id: string;
  public_key_x: string;
  timestamp: string;
  nonce: string;
  signature: string;
  method: string;
  path_and_query: string;
  raw_body: string;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const ts = Number(opts.timestamp);
    if (!Number.isFinite(ts) || Math.abs(cfg.now() / 1000 - ts) > 300) {
      return yield* Effect.fail(unauthorized("stale request"));
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(opts.nonce)) {
      return yield* Effect.fail(unauthorized("bad nonce"));
    }
    const body_hash = yield* Effect.sync(() => sha256_hex(opts.raw_body));
    if (body_hash !== EMPTY_BODY_HASH && opts.raw_body.length === 0) {
      return yield* Effect.fail(unauthorized("bad body"));
    }
    const canonical = `${opts.timestamp}\n${opts.nonce}\n${opts.method}\n${opts.path_and_query}\n${body_hash}`;
    const ok = yield* verify_ed25519(opts.public_key_x, opts.signature, new TextEncoder().encode(canonical));
    if (!ok) return yield* Effect.fail(unauthorized("invalid signature"));
    const claimed = yield* db_run(() => insert_nonce.run(db, { subject: opts.subject_id, nonce: opts.nonce }));
    if (!claimed) return yield* Effect.fail(unauthorized("replay rejected"));
  });

function new_code(): string {
  // Rejection sampling over the actual alphabet length: unbiased, and every
  // index is always in range (a past &31 mask over a 31-char alphabet could
  // emit undefined and break code lookup after upper-casing).
  const n = LOGIN_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < 8) {
    const b = random_bytes(1)[0]!;
    if (b >= limit) continue;
    out += LOGIN_CODE_ALPHABET[b % n];
  }
  return out;
}

// Exported for the generator distribution test.
export { new_code as new_enrollment_code };

// ---------------------------------------------------------------------------
// Enrollment lifecycle
// ---------------------------------------------------------------------------

export const start_enrollment = (opts: {
  public_key_x: string;
  label: string;
  timestamp: number;
  proof: string;
  ip?: string | null;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    if (opts.ip) yield* check_budget(`enroll:ip:${opts.ip}`, RATE_WINDOW_SECONDS, 10, cfg.now());
    if (Math.abs(cfg.now() / 1000 - opts.timestamp) > 300) {
      return yield* Effect.fail(unauthorized("stale request"));
    }
    const msg = `enrollment-request\n${opts.public_key_x}\n${opts.label}\n${opts.timestamp}`;
    const ok = yield* verify_ed25519(opts.public_key_x, opts.proof, new TextEncoder().encode(msg));
    if (!ok) return yield* Effect.fail(unauthorized("proof of possession failed"));
    const code = new_code();
    const code_hash = yield* Effect.sync(() => sha256_hex(`ast-core enroll v1:${code}`));
    const enrollment_id = new_id("enr");
    const expires_at = new Date(cfg.now() + ENROLLMENT_TTL_SECONDS * 1000).toISOString();
    yield* db_run(() =>
      insert_enrollment.run(db, {
        id: enrollment_id,
        public_key_x: opts.public_key_x,
        label: opts.label.slice(0, 120),
        code_hash: code_hash,
        expires_at: expires_at }),
    );
    const fingerprint = yield* fingerprint_of_public_key_x(opts.public_key_x);
    return { enrollment_id: enrollment_id, code, expires_at: expires_at, key_fingerprint: fingerprint };
  });

export const claim_enrollment_with_code = (opts: {
  code: string;
  account_id: string;
  email: string;
  ip?: string | null;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    yield* check_budget(`claim:account:${opts.account_id}`, RATE_WINDOW_SECONDS, 20, cfg.now());
    if (opts.ip) yield* check_budget(`claim:ip:${opts.ip}`, RATE_WINDOW_SECONDS, 30, cfg.now());
    yield* check_budget("claim:global", RATE_WINDOW_SECONDS, 200, cfg.now());
    const code_hash = yield* Effect.sync(() => sha256_hex(`ast-core enroll v1:${opts.code.trim().toUpperCase()}`));
    const found = yield* db_run(() => get_enrollment_by_code_hash.run(db, { code_hash: code_hash }));
    if (!found || found.status !== "pending" || Date.parse(found.expires_at) <= cfg.now()) {
      return yield* Effect.fail(unauthorized("invalid or expired code"));
    }
    const claimed = yield* db_run(() =>
      claim_enrollment.run(db, { id: found.id, account_id: opts.account_id, email: opts.email }),
    );
    if (!claimed) return yield* Effect.fail(unauthorized("invalid or expired code"));
    yield* record(opts.account_id, "machine.claimed", { ip: opts.ip ?? null });
    return { enrollment_id: found.id, status: "claimed" as const };
  });

export const enrollment_status = (enrollment_id: string, subject_public_key_x: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const row = yield* db_run(() => get_enrollment_by_id.run(db, { id: enrollment_id }));
    if (!row) return yield* Effect.fail(unauthorized("unknown enrollment"));
    if (row.public_key_x !== subject_public_key_x) return yield* Effect.fail(unauthorized("unknown enrollment"));
    let status = row.status;
    if ((status === "pending" || status === "claimed") && Date.parse(row.expires_at) <= cfg.now()) {
      status = "expired";
    }
    let display_name: string | null = null;
    if (row.account_id && (status === "claimed" || status === "confirmed")) {
      const acct = yield* db_run(() => get_account_by_id.run(db, { id: row.account_id as string }));
      display_name = acct?.display_name ?? "";
    }
    return {
      enrollment_id: row.id,
      status: status as "pending" | "claimed" | "confirmed" | "expired" | "voided",
      account_id: status === "claimed" || status === "confirmed" ? row.account_id : null,
      email: status === "claimed" || status === "confirmed" ? row.email : null,
      display_name: display_name,
      expires_at: row.expires_at };
  });

// Authenticate a machine-proof request: resolves the subject id (enrollment
// or machine) to its enrolled public key, then verifies the full proof.
// Returns the caller's identity for account-scoping downstream.
export const authenticate_machine_proof = (opts: {
  subject_id: string;
  timestamp: string;
  nonce: string;
  signature: string;
  method: string;
  path_and_query: string;
  raw_body: string;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    let public_key_x: string;
    let account_id: string | null = null;
    let machine_id: string | null = null;
    if (opts.subject_id.startsWith("enr_")) {
      const row = yield* db_run(() => get_enrollment_by_id.run(db, { id: opts.subject_id }));
      if (!row) return yield* Effect.fail(unauthorized("unknown subject"));
      public_key_x = row.public_key_x;
    } else if (opts.subject_id.startsWith("mch_")) {
      const row = yield* db_run(() => get_machine_by_id.run(db, { id: opts.subject_id }));
      if (!row || row.revoked_at) return yield* Effect.fail(unauthorized("unknown subject"));
      public_key_x = row.public_key_x;
      account_id = row.account_id;
      machine_id = row.id;
    } else {
      return yield* Effect.fail(unauthorized("unknown subject"));
    }
    yield* verify_machine_proof({ ...opts, public_key_x });
    return { public_key_x, account_id, machine_id };
  });

export const confirm_enrollment_with_key = (opts: {
  enrollment_id: string;
  account_id: string;
  confirmation: string;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => get_enrollment_by_id.run(db, { id: opts.enrollment_id }));
    if (!row) return yield* Effect.fail(unauthorized("unknown enrollment"));
    if (row.status === "confirmed" && row.machine_id && row.account_id === opts.account_id) {
      return { machine_id: row.machine_id, account_id: row.account_id };
    }
    if (row.status !== "claimed" || row.account_id !== opts.account_id) {
      return yield* Effect.fail(forbidden("enrollment is not claimed to this account"));
    }
    // The caller proved possession of the enrollment key twice before
    // reaching here: the transport proof (headers) and the confirmation
    // signature over the exact (enrollment, account, key) binding checked
    // below. The update then atomically requires the claimed state, so a
    // guessed code alone can never create a machine.
    const bind_msg = `enrollment-confirm\n${row.id}\n${opts.account_id}\n${row.public_key_x}`;
    const bound = yield* verify_ed25519(row.public_key_x, opts.confirmation, new TextEncoder().encode(bind_msg));
    if (!bound) return yield* Effect.fail(unauthorized("confirmation does not bind this account and key"));
    const machine_id = new_id("mch");
    const done = yield* db_run(() =>
      confirm_enrollment.run(db, { id: row.id, account_id: opts.account_id, machine_id: machine_id }),
    );
    if (!done) return yield* Effect.fail(forbidden("enrollment is not claimed to this account"));
    yield* db_run(() =>
      insert_machine.run(db, { id: machine_id, account_id: opts.account_id, public_key_x: row.public_key_x, label: row.label }),
    );
    yield* record(opts.account_id, "machine.enrolled", {});
    return { machine_id: machine_id, account_id: opts.account_id };
  });

// ---------------------------------------------------------------------------
// Machine registry
// ---------------------------------------------------------------------------

export const require_machine = (machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => get_machine_by_id.run(db, { id: machine_id }));
    if (!row || row.revoked_at) return yield* Effect.fail(unauthorized("unknown or revoked machine"));
    yield* db_run(() => touch_machine_last_seen.run(db, { id: machine_id }));
    const principal: MachinePrincipal = { machine_id: row.id, account_id: row.account_id };
    return { principal, public_key_x: row.public_key_x };
  });

export const list_machines = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* db_run(() => list_machines_by_account.run(db, { account_id: account_id }));
    return {
      machines: rows.map((r) => ({
        id: r.id,
        public_key: { kty: "OKP" as const, crv: "Ed25519" as const, x: r.public_key_x },
        label: r.label,
        created_at: r.created_at,
        revoked_at: r.revoked_at,
        last_seen_at: r.last_seen_at })) };
  });

export const revoke_machine_by_id = (account_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* db_run(() => revoke_machine.run(db, { id: machine_id, account_id: account_id }));
    if (!done) return yield* Effect.fail(forbidden("no such machine in this account"));
    yield* record(account_id, "machine.revoked", {});
    return { revoked: true };
  });

export const machine_public_key_jwk = (account_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => get_machine_by_id.run(db, { id: machine_id }));
    if (!row || row.account_id !== account_id || row.revoked_at) {
      return yield* Effect.fail(forbidden("no such machine in this account"));
    }
    return { kty: "OKP" as const, crv: "Ed25519" as const, x: row.public_key_x };
  });
