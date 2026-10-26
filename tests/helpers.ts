import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { decodeBase32 } from "@oslojs/encoding";
import { generateHOTP, generateTOTP } from "@oslojs/otp";
import { createApp, type RequestContext } from "../src/http.js";
import type { Db } from "../src/db.js";

const MASTER_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI"; // 32x 0x42, TEST ONLY

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  confirmUrl: string;
}

export interface TestRig {
  app: ReturnType<typeof createApp>;
  db: PGlite;
  mail: SentMail[];
  tokenForEmail(email: string): string;
  /** Pin the rig clock (test-only CORE_TEST_NOW_MS). */
  setNow(ms: number): void;
  now(): number;
}

export async function setupRig(): Promise<TestRig> {
  const db = new PGlite();
  await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const mail: SentMail[] = [];
  const store = new Map<string, Uint8Array>();
  let nowMs = Date.now();
  const vars: Record<string, string | undefined> = {
    CORE_ENV: "test",
    CORE_PUBLIC_BASE_URL: "http://test.invalid",
    CORE_JWT_ISSUER: "http://test.invalid",
    CORE_MASTER_KEY: MASTER_KEY,
    MAIL_PROVIDER: "log",
  };
  const ctx: RequestContext = {
    db: db as unknown as Db,
    env: { vars, adminToken: "test-admin-token" },
    mailer: "log",
    r2: {
      put: (key: string, body: Uint8Array | string) =>
        Promise.resolve(
          void store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body),
        ),
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
    },
    txRunner: ((fn: (t: Db) => Promise<unknown>) =>
      (db as unknown as { transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).transaction(
        (tx) => fn(tx as unknown as Db),
      )) as RequestContext["txRunner"],
    mailSink: (m) => void mail.push(m),
    now: () => nowMs,
  };
  return {
    app: createApp(ctx),
    db,
    mail,
    tokenForEmail(email: string) {
      const m = [...mail].reverse().find((x) => x.to === email);
      if (!m) throw new Error(`no mail for ${email}`);
      return new URL(m.confirmUrl).searchParams.get("token")!;
    },
    setNow(ms: number) {
      nowMs = ms;
    },
    now() {
      return nowMs;
    },
  };
}

export function totpCodeAt(otpauthUrl: string, timeMs: number): string {
  const secret = decodeBase32(new URL(otpauthUrl).searchParams.get("secret")!);
  return generateHOTP(secret, BigInt(Math.floor(timeMs / 30000)), 6);
}

export interface ApiResponse {
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
}

export async function api(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; rawBody?: string } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
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
  accountId: string;
  token: string;
  cookie: string;
}

// Full magic-link sign-in through the HTTP boundary.
export async function signup(rig: TestRig, email: string): Promise<Account> {
  const q1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email } });
  if (q1.status !== 200) throw new Error(`request failed: ${q1.text}`);
  const { requestId, requestSecret } = q1.json as { requestId: string; requestSecret: string };
  const token = rig.tokenForEmail(email);
  const q2 = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token } });
  if (q2.status !== 200) throw new Error(`consume failed: ${q2.text}`);
  const q3 = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId, requestSecret } });
  if (q3.status !== 200) throw new Error(`finalize failed: ${q3.text}`);
  const j = q3.json as { accountId: string };
  const setCookie = q3.headers.get("set-cookie") ?? "";
  const sessionCookie = setCookie.split(";")[0]!;
  return { accountId: j.accountId, token: (q3.json as { rawToken?: string }).rawToken ?? "", cookie: sessionCookie };
}

export function totpCodeFor(otpauthUrl: string): string {
  const secret = new URL(otpauthUrl).searchParams.get("secret")!;
  return generateTOTP(decodeBase32(secret), 30, 6);
}

// Client-side Ed25519 identity for Forge enrollment / machine proof.
export interface MachineKeys {
  publicX: string;
  sign(bytes: Uint8Array): Promise<string>;
}

export async function newMachineKeys(): Promise<MachineKeys> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { x?: string };
  const b64 = (b: Uint8Array) => {
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  };
  return {
    publicX: jwk.x!,
    sign: async (bytes: Uint8Array) => {
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes.buffer as ArrayBuffer);
      return b64(new Uint8Array(sig));
    },
  };
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256HexStr(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Authenticated machine-proof headers for a raw body.
export async function machineHeaders(
  subjectId: string,
  keys: MachineKeys,
  method: string,
  pathAndQuery: string,
  rawBody: string,
  timestamp?: string,
  nonce?: string,
): Promise<Record<string, string>> {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const n = nonce ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  const bodyHash = await sha256HexStr(rawBody);
  const canonical = `${ts}\n${n}\n${method}\n${pathAndQuery}\n${bodyHash}`;
  return {
    "x-ast-machine": subjectId,
    "x-ast-timestamp": ts,
    "x-ast-nonce": n,
    authorization: `AST-Machine ${await keys.sign(new TextEncoder().encode(canonical))}`,
  };
}

// Full Forge enrollment through the HTTP boundary. Returns the machine id.
export async function enrollMachine(
  rig: TestRig,
  session: { cookie: string },
  label: string,
): Promise<{ machineId: string; keys: MachineKeys }> {
  const keys = await newMachineKeys();
  const ts = Math.floor(Date.now() / 1000);
  const proof = await keys.sign(new TextEncoder().encode(`enrollment-request\n${keys.publicX}\n${label}\n${ts}`));
  const start = await api(rig.app, "POST", "/v1/machines/enrollments", {
    body: { publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicX }, label, timestamp: ts, proof },
  });
  if (start.status !== 201) throw new Error(`enroll start failed: ${start.text}`);
  const { enrollmentId, code } = start.json as { enrollmentId: string; code: string };
  const claim = await api(rig.app, "POST", "/v1/machines/enrollments/claim", {
    headers: { cookie: session.cookie, origin: "http://localhost" },
    body: { code },
  });
  if (claim.status !== 200) throw new Error(`claim failed: ${claim.text}`);
  const statusPath = `/v1/machines/enrollments/${enrollmentId}/status`;
  const st = await api(rig.app, "GET", statusPath, { headers: await machineHeaders(enrollmentId, keys, "GET", statusPath, "") });
  if (st.status !== 200) throw new Error(`status failed: ${st.text}`);
  const sj = st.json as { accountId: string };
  const confirmation = await keys.sign(
    new TextEncoder().encode(`enrollment-confirm\n${enrollmentId}\n${sj.accountId}\n${keys.publicX}`),
  );
  const confirmPath = "/v1/machines/enrollments/confirm";
  const cbody = JSON.stringify({ enrollmentId, accountId: sj.accountId, confirmation });
  const done = await api(rig.app, "POST", confirmPath, {
    headers: await machineHeaders(enrollmentId, keys, "POST", confirmPath, cbody),
    rawBody: cbody,
  });
  if (done.status !== 201) throw new Error(`confirm failed: ${done.text}`);
  return { machineId: (done.json as { machineId: string }).machineId, keys };
}
