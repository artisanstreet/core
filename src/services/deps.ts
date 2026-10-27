import { Context, Effect, Layer } from "effect";
import type { Db } from "../db.ts";
import type { MasterKey } from "../crypto.ts";
import { load_master_key } from "../crypto.ts";
import { internal, type CoreError } from "../errors.ts";

export type MailerKind = "log" | "resend" | "cloudflare";

export interface AppConfig {
  readonly env: Record<string, string | undefined>;
  readonly core_env: string;
  readonly public_base_url: string;
  readonly jwt_issuer: string;
  readonly master_key: MasterKey;
  readonly mailer: MailerKind;
  readonly resend_api_key?: string;
  readonly admin_token?: string;
  readonly now: () => number;
}

export class AppConfigTag extends Context.Tag("AppConfig")<AppConfigTag, AppConfig>() {}

export function config_from_env(
  env: Record<string, string | undefined>,
  now: () => number = Date.now,
): AppConfig {
  const core_env = (env.CORE_ENV ?? "dev").toLowerCase();
  const mailer = (env.MAIL_PROVIDER ?? "log").toLowerCase();
  if (mailer !== "log" && mailer !== "resend" && mailer !== "cloudflare") {
    throw new Error("MAIL_PROVIDER must be log|resend|cloudflare");
  }
  if (core_env === "production" && mailer === "log") {
    throw new Error("MAIL_PROVIDER=log is refused in production");
  }
  return {
    env,
    core_env,
    public_base_url: env.CORE_PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
    jwt_issuer: env.CORE_JWT_ISSUER ?? env.CORE_PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
    master_key: load_master_key(env),
    mailer,
    resend_api_key: env.RESEND_API_KEY,
    admin_token: env.CORE_ADMIN_TOKEN,
    now };
}

export class DbTag extends Context.Tag("Db")<DbTag, { readonly db: Db }>() {}
export const db_live = (db: Db) => Layer.succeed(DbTag, { db });

// Transaction runner: Effect-composed atomic unit run with a
// transactional client (postgres.js/PGlite adapters only).
export interface TxRunner {
  readonly transaction: <A, E>(effect: Effect.Effect<A, E, DbTag>) => Effect.Effect<A, E | CoreError>;
}
export class TxTag extends Context.Tag("Tx")<TxTag, TxRunner>() {}

export const db_run = <A,>(attempt: () => Promise<A>) =>
  Effect.tryPromise({
    try: attempt,
    // Never leak driver detail to callers or logs: the driver error is
    // preserved opaquely as .cause for internal Cause chains, while HTTP
    // responses and logs only ever carry the redacted code/message.
    catch: (cause) => internal("database unavailable", { cause }) });
