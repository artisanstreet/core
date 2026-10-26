import { Context, Effect, Layer } from "effect";
import type { Db } from "../db.js";
import type { MasterKey } from "../crypto.js";
import { loadMasterKey } from "../crypto.js";
import { internal } from "../errors.js";

export interface AppConfig {
  readonly env: Record<string, string | undefined>;
  readonly coreEnv: string;
  readonly publicBaseUrl: string;
  readonly jwtIssuer: string;
  readonly masterKey: MasterKey;
  readonly mailer: "log" | "resend";
  readonly resendApiKey?: string;
  readonly adminToken?: string;
  readonly now: () => number;
}

export class AppConfigTag extends Context.Tag("AppConfig")<AppConfigTag, AppConfig>() {}

export function configFromEnv(
  env: Record<string, string | undefined>,
  now: () => number = Date.now,
): AppConfig {
  const coreEnv = (env.CORE_ENV ?? "dev").toLowerCase();
  const mailer = (env.MAIL_PROVIDER ?? "log").toLowerCase();
  if (mailer !== "log" && mailer !== "resend") throw new Error("MAIL_PROVIDER must be log|resend");
  if (coreEnv === "production" && mailer === "log") {
    throw new Error("MAIL_PROVIDER=log is refused in production");
  }
  return {
    env,
    coreEnv,
    publicBaseUrl: env.CORE_PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
    jwtIssuer: env.CORE_JWT_ISSUER ?? env.CORE_PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
    masterKey: loadMasterKey(env),
    mailer,
    resendApiKey: env.RESEND_API_KEY,
    adminToken: env.CORE_ADMIN_TOKEN,
    now,
  };
}

export class DbTag extends Context.Tag("Db")<DbTag, { readonly db: Db }>() {}
export const DbLive = (db: Db) => Layer.succeed(DbTag, { db });

// Transaction runner: executes fn with a transactional client. The login
// finalize path commits its state changes atomically; without this, a crash
// between completion and session insert would burn the request and strand
// the user. Provided per runtime (postgres.js in the Worker, PGlite tests).
export type TxRunner = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
export class TxTag extends Context.Tag("Tx")<TxTag, TxRunner>() {}

export function dbRun<A>(attempt: () => Promise<A>) {
  return Effect.tryPromise({
    try: attempt,
    // Never leak driver detail to callers or logs.
    catch: () => internal("database unavailable"),
  });
}
