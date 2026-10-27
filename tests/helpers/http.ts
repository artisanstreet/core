import { PGlite } from "@electric-sql/pglite";
import { readFile as read_file } from "node:fs/promises";
import { fileURLToPath as file_url_to_path } from "node:url";
import { decodeBase32 as decode_base32 } from "@oslojs/encoding";
import { generateHOTP as generate_hotp, generateTOTP as generate_totp } from "@oslojs/otp";
import { Cause, Effect, Layer } from "effect";
import { base64urlnopad as base64url_nopad } from "@scure/base";
import { sha256 as noble_sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as bytes_to_hex, randomBytes as noble_random_bytes, utf8ToBytes as utf8_to_bytes } from "@noble/hashes/utils.js";
import { create_app, type RequestContext } from "../../src/http.ts";
import { make_service_layers } from "../../src/http/context.ts";
import type { Db } from "../../src/db.ts";
import { DbTag } from "../../src/services/deps.ts";
import { CoreError, internal } from "../../src/errors.ts";

const MASTER_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI"; // 32x 0x42, TEST ONLY

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  confirm_url: string;
}

export interface TestRig {
  app: ReturnType<typeof create_app>;
  db: PGlite;
  mail: SentMail[];
  layers: ReturnType<typeof make_service_layers>;
  token_for_email(email: string): string;
  /** Pin the rig clock (mutable fake time for deterministic tests). */
  set_now(ms: number): void;
  now(): number;
  set_var(key: string, value: string | undefined): void;
}

export async function setup_rig(opts: {
  vars?: Record<string, string | undefined>;
} = {}): Promise<TestRig> {
  const db = new PGlite();
  await db.exec(await read_file(file_url_to_path(new URL("../../db/schema.sql", import.meta.url).href), "utf8"));
  const mail: SentMail[] = [];
  const store = new Map<string, Uint8Array>();
  let now_ms = Date.now();
  const vars: Record<string, string | undefined> = {
    CORE_ENV: "test",
    CORE_PUBLIC_BASE_URL: "http://test.invalid",
    CORE_JWT_ISSUER: "http://test.invalid",
    CORE_MASTER_KEY: MASTER_KEY,
    MAIL_PROVIDER: "log",
    ...(opts.vars ?? {}) };
  const ctx: RequestContext = {
    db: db as unknown as Db,
    env: { vars, admin_token: "test-admin-token" },
    mailer: "log",
    r2: {
      put: (key: string, body: Uint8Array | string) =>
        Promise.resolve(
          void store.set(key, typeof body === "string" ? utf8_to_bytes(body) : body),
        ),
      get: (key: string) => Promise.resolve(store.get(key) ?? null) },
    // Test driver-boundary bridge (mirrors src/index.ts): PGlite
    // transaction() takes a callback. Uninterruptible like production.
    tx_runner: {
      transaction: <A, E>(effect: Effect.Effect<A, E, DbTag>): Effect.Effect<A, E | CoreError> =>
        Effect.uninterruptible(
          Effect.tryPromise({
            try: () =>
              (db as unknown as { transaction: (f: (tx: unknown) => Promise<A>) => Promise<A> }).transaction(async (tx) => {
                const exit = await Effect.runPromiseExit(
                  Effect.provide(effect, Layer.succeed(DbTag, { db: tx as unknown as Db })),
                );
                if (exit._tag === "Success") return exit.value;
                const failure = Cause.failureOption(exit.cause);
                if (failure._tag === "Some") throw failure.value;
                throw internal("database unavailable", { cause: exit.cause });
              }),
            catch: (cause) => (cause instanceof CoreError ? cause : internal("database unavailable", { cause })) }),
        ) },
    mail_sink: (m) => void mail.push(m),
    now: () => now_ms };
  return {
    app: create_app(ctx),
    db,
    mail,
    layers: make_service_layers(ctx),
    token_for_email(email: string) {
      const m = [...mail].reverse().find((x) => x.to === email);
      if (!m) throw new Error(`no mail for ${email}`);
      return new URL(m.confirm_url).searchParams.get("token")!;
    },
    set_now(ms: number) {
      now_ms = ms;
    },
    now() {
      return now_ms;
    },
    set_var(key: string, value: string | undefined) {
      if (value === undefined) delete vars[key];
      else vars[key] = value;
    } };
}

export function totp_code_at(otpauth_url: string, time_ms: number): string {
  const secret = decode_base32(new URL(otpauth_url).searchParams.get("secret")!);
  return generate_hotp(secret, BigInt(Math.floor(time_ms / 30000)), 6);
}

export interface ApiResponse {
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
}

export async function api(
  app: ReturnType<typeof create_app>,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; raw_body?: string } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.raw_body !== undefined) {
    body = opts.raw_body;
    headers["content-type"] ??= "application/json";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const admin = { "x-admin-token": "test-admin-token" };

export interface Account {
  account_id: string;
  token: string;
  cookie: string;
}

// Full magic-link sign-in through the HTTP boundary.
export async function signup(rig: TestRig, email: string): Promise<Account> {
  const q1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email } });
  if (q1.status !== 200) throw new Error(`request failed: ${q1.text}`);
  const { request_id, request_secret } = q1.json as { request_id: string; request_secret: string };
  const token = rig.token_for_email(email);
  const q2 = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token } });
  if (q2.status !== 200) throw new Error(`consume failed: ${q2.text}`);
  const q3 = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret } });
  if (q3.status !== 200) throw new Error(`finalize failed: ${q3.text}`);
  const j = q3.json as { account_id: string };
  const set_cookie = q3.headers.get("set-cookie") ?? "";
  const session_cookie = set_cookie.split(";")[0]!;
  const cookie_token = decodeURIComponent(session_cookie.split("=").slice(1).join("="));
  return { account_id: j.account_id, token: cookie_token, cookie: session_cookie };
}

export function totp_code_for(otpauth_url: string): string {
  const secret = new URL(otpauth_url).searchParams.get("secret")!;
  return generate_totp(decode_base32(secret), 30, 6);
}

// Client-side Ed25519 identity for Forge enrollment / machine proof.
export interface MachineKeys {
  public_x: string;
  sign(bytes: Uint8Array): Promise<string>;
}

export async function new_machine_keys(): Promise<MachineKeys> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { x?: string };
  return {
    public_x: jwk.x!,
    sign: async (bytes: Uint8Array) => {
      const msg_copy = new Uint8Array(bytes);
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, msg_copy);
      return base64url_nopad.encode(new Uint8Array(sig));
    } };
}

export function b64url(bytes: Uint8Array): string {
  return base64url_nopad.encode(bytes);
}

export function sha256_hex_str(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? utf8_to_bytes(data) : data;
  return bytes_to_hex(noble_sha256(bytes));
}

// Authenticated machine-proof headers for a raw body.
export async function machine_headers(
  subject_id: string,
  keys: MachineKeys,
  method: string,
  path_and_query: string,
  raw_body: string,
  timestamp?: string,
  nonce?: string,
): Promise<Record<string, string>> {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const n = nonce ?? base64url_nopad.encode(noble_random_bytes(16));
  const body_hash = sha256_hex_str(raw_body);
  const canonical = `${ts}\n${n}\n${method}\n${path_and_query}\n${body_hash}`;
  return {
    "x-ast-machine": subject_id,
    "x-ast-timestamp": ts,
    "x-ast-nonce": n,
    authorization: `AST-Machine ${await keys.sign(utf8_to_bytes(canonical))}` };
}

// Full Forge enrollment through the HTTP boundary. Returns the machine id.
export async function enroll_machine(
  rig: TestRig,
  session: { cookie: string },
  label: string,
): Promise<{ machine_id: string; keys: MachineKeys }> {
  const keys = await new_machine_keys();
  const ts = Math.floor(Date.now() / 1000);
  const proof = await keys.sign(utf8_to_bytes(`enrollment-request\n${keys.public_x}\n${label}\n${ts}`));
  const start = await api(rig.app, "POST", "/v1/machines/enrollments", {
    body: { publicKey: { kty: "OKP", crv: "Ed25519", x: keys.public_x }, label, timestamp: ts, proof } });
  if (start.status !== 201) throw new Error(`enroll start failed: ${start.text}`);
  const { enrollment_id, code } = start.json as { enrollment_id: string; code: string };
  const claim = await api(rig.app, "POST", "/v1/machines/enrollments/claim", {
    headers: { cookie: session.cookie, origin: "http://localhost" },
    body: { code } });
  if (claim.status !== 200) throw new Error(`claim failed: ${claim.text}`);
  const status_path = `/v1/machines/enrollments/${enrollment_id}/status`;
  const st = await api(rig.app, "GET", status_path, { headers: await machine_headers(enrollment_id, keys, "GET", status_path, "") });
  if (st.status !== 200) throw new Error(`status failed: ${st.text}`);
  const sj = st.json as { account_id: string };
  const confirmation = await keys.sign(
    utf8_to_bytes(`enrollment-confirm\n${enrollment_id}\n${sj.account_id}\n${keys.public_x}`),
  );
  const confirm_path = "/v1/machines/enrollments/confirm";
  const cbody = JSON.stringify({ enrollmentId: enrollment_id, accountId: sj.account_id, confirmation });
  const done = await api(rig.app, "POST", confirm_path, {
    headers: await machine_headers(enrollment_id, keys, "POST", confirm_path, cbody),
    raw_body: cbody });
  if (done.status !== 201) throw new Error(`confirm failed: ${done.text}`);
  return { machine_id: (done.json as { machine_id: string }).machine_id, keys };
}
