import { Effect } from "effect";
import {
  base64urlDecode,
  base64urlEncode,
  randomBytes,
  sha256Bytes,
  sha256Hex,
} from "../crypto.js";
import { ENROLLMENT_TTL_SECONDS, LOGIN_CODE_ALPHABET, RATE_WINDOW_SECONDS } from "../constants.js";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import { newId } from "../ids.js";
import { AppConfigTag, DbTag, dbRun } from "./deps.js";
import { checkBudget } from "./ratelimit.js";
import { record } from "./activity.js";
import getAccountById from "../db/queries/accounts/getAccountById.sql";
import insertEnrollment from "../db/queries/enrollments/insertEnrollment.sql";
import getEnrollmentById from "../db/queries/enrollments/getEnrollmentById.sql";
import getEnrollmentByCodeHash from "../db/queries/enrollments/getEnrollmentByCodeHash.sql";
import claimEnrollment from "../db/queries/enrollments/claimEnrollment.sql";
import confirmEnrollment from "../db/queries/enrollments/confirmEnrollment.sql";
import insertMachine from "../db/queries/machines/insertMachine.sql";
import getMachineById from "../db/queries/machines/getMachineById.sql";
import listMachinesByAccount from "../db/queries/machines/listMachinesByAccount.sql";
import revokeMachine from "../db/queries/machines/revokeMachine.sql";
import touchMachineLastSeen from "../db/queries/machines/touchMachineLastSeen.sql";
import insertNonce from "../db/queries/nonces/insertNonce.sql";

export interface MachinePrincipal {
  readonly machineId: string;
  readonly accountId: string;
}

const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function fingerprintOfPublicKeyX(x: string) {
  return Effect.promise(() => sha256Bytes(base64urlDecode(x)).then(base64urlEncode));
}

export function verifyEd25519(publicKeyX: string, signatureB64: string, message: Uint8Array) {
  return Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: "Ed25519", x: publicKeyX, key_ops: ["verify"], ext: true } as JsonWebKey,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify({ name: "Ed25519" }, key, base64urlDecode(signatureB64).buffer as ArrayBuffer, message.buffer as ArrayBuffer);
    },
    catch: () => unauthorized("invalid signature"),
  });
}

// Canonical request proof (§3): verifies timestamp window, recomputes the
// body hash, verifies the Ed25519 signature FIRST, then atomically claims
// the nonce (durable replay protection). Signature-first ordering keeps
// unauthenticated invalid signatures from filling the replay table or
// poisoning a nonce the legitimate holder will use; the nonce is part of
// the signed canonical string, so the later claim stays bound to exactly
// what was verified. Any failure is a generic 401.
export function verifyMachineProof(opts: {
  subjectId: string;
  publicKeyX: string;
  timestamp: string;
  nonce: string;
  signature: string;
  method: string;
  pathAndQuery: string;
  rawBody: string;
}) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const ts = Number(opts.timestamp);
    if (!Number.isFinite(ts) || Math.abs(cfg.now() / 1000 - ts) > 300) {
      return yield* Effect.fail(unauthorized("stale request"));
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(opts.nonce)) {
      return yield* Effect.fail(unauthorized("bad nonce"));
    }
    const bodyHash = yield* Effect.promise(() => sha256Hex(opts.rawBody));
    if (bodyHash !== EMPTY_BODY_HASH && opts.rawBody.length === 0) {
      return yield* Effect.fail(unauthorized("bad body"));
    }
    const canonical = `${opts.timestamp}\n${opts.nonce}\n${opts.method}\n${opts.pathAndQuery}\n${bodyHash}`;
    const ok = yield* verifyEd25519(opts.publicKeyX, opts.signature, new TextEncoder().encode(canonical));
    if (!ok) return yield* Effect.fail(unauthorized("invalid signature"));
    const claimed = yield* dbRun(() => insertNonce.run(db, { subject: opts.subjectId, nonce: opts.nonce }));
    if (!claimed) return yield* Effect.fail(unauthorized("replay rejected"));
  });
}

function newCode(): string {
  // Rejection sampling over the actual alphabet length: unbiased, and every
  // index is always in range (a past &31 mask over a 31-char alphabet could
  // emit undefined and break code lookup after upper-casing).
  const n = LOGIN_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < 8) {
    const b = randomBytes(1)[0]!;
    if (b >= limit) continue;
    out += LOGIN_CODE_ALPHABET[b % n];
  }
  return out;
}

// Exported for the generator distribution test.
export { newCode as newEnrollmentCode };

// ---------------------------------------------------------------------------
// Enrollment lifecycle
// ---------------------------------------------------------------------------

export function startEnrollment(opts: {
  publicKeyX: string;
  label: string;
  timestamp: number;
  proof: string;
  ip?: string | null;
}) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    if (opts.ip) yield* checkBudget(`enroll:ip:${opts.ip}`, RATE_WINDOW_SECONDS, 10, cfg.now());
    if (Math.abs(cfg.now() / 1000 - opts.timestamp) > 300) {
      return yield* Effect.fail(unauthorized("stale request"));
    }
    const msg = `enrollment-request\n${opts.publicKeyX}\n${opts.label}\n${opts.timestamp}`;
    const ok = yield* verifyEd25519(opts.publicKeyX, opts.proof, new TextEncoder().encode(msg));
    if (!ok) return yield* Effect.fail(unauthorized("proof of possession failed"));
    const code = newCode();
    const codeHash = yield* Effect.promise(() => sha256Hex(`ast-core enroll v1:${code}`));
    const enrollmentId = newId("enr");
    const expiresAt = new Date(cfg.now() + ENROLLMENT_TTL_SECONDS * 1000).toISOString();
    yield* dbRun(() =>
      insertEnrollment.run(db, {
        id: enrollmentId,
        publicKeyX: opts.publicKeyX,
        label: opts.label.slice(0, 120),
        codeHash,
        expiresAt,
      }),
    );
    const fingerprint = yield* fingerprintOfPublicKeyX(opts.publicKeyX);
    return { enrollmentId, code, expiresAt, keyFingerprint: fingerprint };
  });
}

export function claimEnrollmentWithCode(opts: {
  code: string;
  accountId: string;
  email: string;
  ip?: string | null;
}) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    yield* checkBudget(`claim:account:${opts.accountId}`, RATE_WINDOW_SECONDS, 20, cfg.now());
    if (opts.ip) yield* checkBudget(`claim:ip:${opts.ip}`, RATE_WINDOW_SECONDS, 30, cfg.now());
    yield* checkBudget("claim:global", RATE_WINDOW_SECONDS, 200, cfg.now());
    const codeHash = yield* Effect.promise(() => sha256Hex(`ast-core enroll v1:${opts.code.trim().toUpperCase()}`));
    const found = yield* dbRun(() => getEnrollmentByCodeHash.run(db, { codeHash }));
    if (!found || found.status !== "pending" || Date.parse(found.expires_at) <= cfg.now()) {
      return yield* Effect.fail(unauthorized("invalid or expired code"));
    }
    const claimed = yield* dbRun(() =>
      claimEnrollment.run(db, { id: found.id, accountId: opts.accountId, email: opts.email }),
    );
    if (!claimed) return yield* Effect.fail(unauthorized("invalid or expired code"));
    yield* record(opts.accountId, "machine.claimed", { ip: opts.ip ?? null });
    return { enrollmentId: found.id, status: "claimed" as const };
  });
}

export function enrollmentStatus(enrollmentId: string, subjectPublicKeyX: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const row = yield* dbRun(() => getEnrollmentById.run(db, { id: enrollmentId }));
    if (!row) return yield* Effect.fail(unauthorized("unknown enrollment"));
    if (row.public_key_x !== subjectPublicKeyX) return yield* Effect.fail(unauthorized("unknown enrollment"));
    let status = row.status;
    if ((status === "pending" || status === "claimed") && Date.parse(row.expires_at) <= cfg.now()) {
      status = "expired";
    }
    let displayName: string | null = null;
    if (row.account_id && (status === "claimed" || status === "confirmed")) {
      const acct = yield* dbRun(() => getAccountById.run(db, { id: row.account_id as string }));
      displayName = acct?.display_name ?? "";
    }
    return {
      enrollmentId: row.id,
      status: status as "pending" | "claimed" | "confirmed" | "expired" | "voided",
      accountId: status === "claimed" || status === "confirmed" ? row.account_id : null,
      email: status === "claimed" || status === "confirmed" ? row.email : null,
      displayName,
      expiresAt: row.expires_at,
    };
  });
}

// Authenticate a machine-proof request: resolves the subject id (enrollment
// or machine) to its enrolled public key, then verifies the full proof.
// Returns the caller's identity for account-scoping downstream.
export function authenticateMachineProof(opts: {
  subjectId: string;
  timestamp: string;
  nonce: string;
  signature: string;
  method: string;
  pathAndQuery: string;
  rawBody: string;
}) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    let publicKeyX: string;
    let accountId: string | null = null;
    let machineId: string | null = null;
    if (opts.subjectId.startsWith("enr_")) {
      const row = yield* dbRun(() => getEnrollmentById.run(db, { id: opts.subjectId }));
      if (!row) return yield* Effect.fail(unauthorized("unknown subject"));
      publicKeyX = row.public_key_x;
    } else if (opts.subjectId.startsWith("mch_")) {
      const row = yield* dbRun(() => getMachineById.run(db, { id: opts.subjectId }));
      if (!row || row.revoked_at) return yield* Effect.fail(unauthorized("unknown subject"));
      publicKeyX = row.public_key_x;
      accountId = row.account_id;
      machineId = row.id;
    } else {
      return yield* Effect.fail(unauthorized("unknown subject"));
    }
    yield* verifyMachineProof({ ...opts, publicKeyX });
    return { publicKeyX, accountId, machineId };
  });
}

export function confirmEnrollmentWithKey(opts: {
  enrollmentId: string;
  accountId: string;
  confirmation: string;
}) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => getEnrollmentById.run(db, { id: opts.enrollmentId }));
    if (!row) return yield* Effect.fail(unauthorized("unknown enrollment"));
    if (row.status === "confirmed" && row.machine_id && row.account_id === opts.accountId) {
      return { machineId: row.machine_id, accountId: row.account_id };
    }
    if (row.status !== "claimed" || row.account_id !== opts.accountId) {
      return yield* Effect.fail(forbidden("enrollment is not claimed to this account"));
    }
    // The caller proved possession of the enrollment key twice before
    // reaching here: the transport proof (headers) and the confirmation
    // signature over the exact (enrollment, account, key) binding checked
    // below. The update then atomically requires the claimed state, so a
    // guessed code alone can never create a machine.
    const bindMsg = `enrollment-confirm\n${row.id}\n${opts.accountId}\n${row.public_key_x}`;
    const bound = yield* verifyEd25519(row.public_key_x, opts.confirmation, new TextEncoder().encode(bindMsg));
    if (!bound) return yield* Effect.fail(unauthorized("confirmation does not bind this account and key"));
    const machineId = newId("mch");
    const done = yield* dbRun(() =>
      confirmEnrollment.run(db, { id: row.id, accountId: opts.accountId, machineId }),
    );
    if (!done) return yield* Effect.fail(forbidden("enrollment is not claimed to this account"));
    yield* dbRun(() =>
      insertMachine.run(db, { id: machineId, accountId: opts.accountId, publicKeyX: row.public_key_x, label: row.label }),
    );
    yield* record(opts.accountId, "machine.enrolled", {});
    return { machineId, accountId: opts.accountId };
  });
}

// ---------------------------------------------------------------------------
// Machine registry
// ---------------------------------------------------------------------------

export function requireMachine(machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => getMachineById.run(db, { id: machineId }));
    if (!row || row.revoked_at) return yield* Effect.fail(unauthorized("unknown or revoked machine"));
    yield* dbRun(() => touchMachineLastSeen.run(db, { id: machineId }));
    const principal: MachinePrincipal = { machineId: row.id, accountId: row.account_id };
    return { principal, publicKeyX: row.public_key_x };
  });
}

export function listMachines(accountId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* dbRun(() => listMachinesByAccount.run(db, { accountId }));
    return {
      machines: rows.map((r) => ({
        id: r.id,
        publicKey: { kty: "OKP" as const, crv: "Ed25519" as const, x: r.public_key_x },
        label: r.label,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
        lastSeenAt: r.last_seen_at,
      })),
    };
  });
}

export function revokeMachineById(accountId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* dbRun(() => revokeMachine.run(db, { id: machineId, accountId }));
    if (!done) return yield* Effect.fail(forbidden("no such machine in this account"));
    yield* record(accountId, "machine.revoked", {});
    return { revoked: true };
  });
}

export function machinePublicKeyJwk(accountId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => getMachineById.run(db, { id: machineId }));
    if (!row || row.account_id !== accountId || row.revoked_at) {
      return yield* Effect.fail(forbidden("no such machine in this account"));
    }
    return { kty: "OKP" as const, crv: "Ed25519" as const, x: row.public_key_x };
  });
}
