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
  readonly auth_public_base_url: string | null;
  readonly dashboard_public_base_url: string | null;
  readonly allowed_browser_origins: ReadonlyArray<string>;
  readonly session_cookie_domain: string | null;
  readonly master_key: MasterKey;
  readonly mailer: MailerKind;
  readonly resend_api_key?: string;
  readonly admin_token?: string;
  readonly now: () => number;
}

export class AppConfigTag extends Context.Tag("AppConfig")<AppConfigTag, AppConfig>() {}

const trim_or_null = (raw: string | undefined): string | null => {
  const trimmed = (raw ?? "").trim();
  return trimmed ? trimmed : null;
};

const API_PROD_ORIGIN = "https://api.artisan.st";
const AUTH_PROD_ORIGIN = "https://auth.artisan.st";
const DASHBOARD_PROD_ORIGIN = "https://dashboard.artisan.st";

export const normalize_browser_origin = (raw: string, var_name: string, core_env: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error(`${var_name} must not be empty`);
  if (trimmed.includes("*")) throw new Error(`${var_name} must be a single exact origin (no wildcards)`);
  if (!URL.canParse(trimmed)) throw new Error(`${var_name} must be a valid absolute URL`);
  const parsed = new URL(trimmed);
  if (parsed.username || parsed.password) throw new Error(`${var_name} must not embed credentials`);
  if (parsed.search || parsed.hash) throw new Error(`${var_name} must not include query or fragment`);
  if (parsed.pathname !== "/" && parsed.pathname !== "") throw new Error(`${var_name} must be a bare origin with no path`);
  if (!parsed.hostname) throw new Error(`${var_name} must include a hostname`);
  if (parsed.hostname.includes("*")) throw new Error(`${var_name} must be a single exact origin (no wildcards)`);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${var_name} must be http or https`);
  }
  if (core_env === "production" && parsed.protocol !== "https:") {
    throw new Error(`${var_name} must be an exact https origin in production`);
  }
  const host = parsed.hostname.toLowerCase();
  const is_default_port =
    (parsed.protocol === "https:" && (parsed.port === "" || parsed.port === "443")) ||
    (parsed.protocol === "http:" && (parsed.port === "" || parsed.port === "80"));
  const port_part = is_default_port ? "" : `:${parsed.port}`;
  return `${parsed.protocol}//${host}${port_part}`;
};

export const parse_cookie_domain = (raw: string | null, browser_origins: ReadonlyArray<string | null>): string | null => {
  if (!raw) return null;
  const domain = raw.toLowerCase().replace(/^\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    throw new Error("SESSION_COOKIE_DOMAIN must be a bare domain like artisan.st");
  }
  const outside = browser_origins
    .filter((origin): origin is string => origin !== null)
    .map((origin) => new URL(origin).hostname)
    .filter((host) => host !== domain && !host.endsWith(`.${domain}`));
  if (outside.length > 0) {
    throw new Error(`SESSION_COOKIE_DOMAIN ${domain} does not cover ${outside.join(", ")}`);
  }
  return domain;
};

const canonical_origin_of = (normalized_bare: string): string => new URL(normalized_bare).origin;

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
  const public_base_url = env.CORE_PUBLIC_BASE_URL ?? "http://127.0.0.1:8787";
  const raw_auth = trim_or_null(env.AUTH_PUBLIC_BASE_URL);
  const raw_dashboard = trim_or_null(env.DASHBOARD_PUBLIC_BASE_URL);
  const parsed_auth = raw_auth ? normalize_browser_origin(raw_auth, "AUTH_PUBLIC_BASE_URL", core_env) : null;
  const parsed_dashboard = raw_dashboard
    ? normalize_browser_origin(raw_dashboard, "DASHBOARD_PUBLIC_BASE_URL", core_env)
    : null;
  const public_normalized = (() => {
    if (!URL.canParse(public_base_url.trim().replace(/\/+$/, ""))) return null;
    return normalize_browser_origin(public_base_url, "CORE_PUBLIC_BASE_URL", core_env);
  })();
  const is_prod_api = core_env === "production" && public_normalized === API_PROD_ORIGIN;
  const auth_public_base_url = parsed_auth ?? (is_prod_api ? AUTH_PROD_ORIGIN : null);
  const dashboard_public_base_url = parsed_dashboard ?? (is_prod_api ? DASHBOARD_PROD_ORIGIN : null);
  const seen = new Set<string>();
  const allowed_browser_origins: Array<string> = [];
  const push_origin = (bare: string | null) => {
    if (!bare) return;
    const origin = canonical_origin_of(bare);
    if (!seen.has(origin)) {
      seen.add(origin);
      allowed_browser_origins.push(origin);
    }
  };
  if (public_normalized) push_origin(public_normalized);
  push_origin(auth_public_base_url);
  push_origin(dashboard_public_base_url);
  return {
    env,
    core_env,
    public_base_url,
    jwt_issuer: env.CORE_JWT_ISSUER ?? env.CORE_PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
    auth_public_base_url,
    dashboard_public_base_url,
    allowed_browser_origins,
    session_cookie_domain: parse_cookie_domain(trim_or_null(env.SESSION_COOKIE_DOMAIN), [
      auth_public_base_url,
      dashboard_public_base_url,
    ]),
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
