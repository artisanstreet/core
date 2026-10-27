import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

// Pure deploy-input helpers for ast-core Alchemy IaC.
//
// All functions here are credential-free except for the explicit Redacted
// password holder returned by parse_postgres_url. No function logs secrets,
// and error messages never embed secret material (public origins may be
// echoed for operator debuggability; the database URL/password never is).

export const STACK_NAME = "ast-core" as const;

// Stage names must match the Alchemy CLI constraint:
// [a-z0-9][-_a-z0-9]*
const STAGE_PATTERN = /^[a-z0-9][-_a-z0-9]*$/;

export function assert_valid_stage(stage: string): void {
  if (!STAGE_PATTERN.test(stage)) {
    throw new Error(
      `invalid stage ${JSON.stringify(stage)}: must match [a-z0-9][-_a-z0-9]* (see alchemy CLI --stage)`,
    );
  }
}

// Prebuilt bundle seam (existing Vite/Reylo build, NOT Alchemy rolldown).
//
// `pnpm run build` (core root, vite + @cloudflare/vite-plugin + reylo/vite)
// emits:
//   dist/ast_core/index.js (+ dist/ast_core/assets/*.js chunks, .map)
//
// Alchemy MUST reuse these artifacts with bundle:false (Wrangler no_bundle
// contract). Plain Alchemy rolldown of src/index.ts would NOT resolve the
// Reylo `.sql` transforms. Paths below are relative to the core repo root;
// run all alchemy commands from the core root with
// `--config infra/alchemy.run.ts` so cwd-relative resolution stays inside cwd
// and state stores portable relative paths.
export const WORKER_PREBUILT_ENTRY = "dist/ast_core/index.js" as const;

// Wrangler parity preserved for local/test only.
export const WORKER_COMPATIBILITY_DATE = "2026-10-01" as const;
export const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;

// Hyperdrive server-side caching MUST stay disabled. Core is the authority
// for sessions, machine keys, vault assignments, and revocation state;
// Hyperdrive does not invalidate cached rows on writes, so a cached
// revoked_at/revocations read would keep honoring revoked credentials.
// Local dev never emulates this (direct Postgres, no cache); only prod is
// at risk. Verified by tests + `wrangler hyperdrive get` semantics.
export const HYPERDRIVE_CACHING = { disabled: true } as const;

// Fixed service env (persisted from wrangler.jsonc/docs).
export const CORE_ENV_VALUE = "production" as const;
export const MAIL_PROVIDER_VALUE = "cloudflare" as const;

// Native Cloudflare Email Service sender domain (no root MX changes).
// SendingSubdomain provisions SPF/DKIM/return-path on the dedicated
// sending subdomain; the sender address lives on that subdomain. Root
// artisan.st MX records (existing mail) are never touched.
export const MAIL_ZONE_NAME = "artisan.st" as const;
export const MAIL_ZONE_ID = "6320d0c37a89c14abb9ae3d7b9d17339" as const;
export const MAIL_SENDING_SUBDOMAIN = "mail.artisan.st" as const;
export const MAIL_SENDER_EMAIL = "auth@mail.artisan.st" as const;
export const MAIL_SENDER_NAME = "Artisan Street" as const;

// Known production browser + API origins. Deploy defaults to these ONLY
// when the stage is prod and validation confirms consistency; preview
// stages must use stage-specific origins (never reuse prod — the second
// custom-domain attach would move ownership).
export const API_PROD_ORIGIN = "https://api.artisan.st" as const;
export const AUTH_PROD_ORIGIN = "https://auth.artisan.st" as const;
export const DASHBOARD_PROD_ORIGIN = "https://dashboard.artisan.st" as const;

export function sender_email_from_mail_from(mail_from: string): string {
  const trimmed = mail_from.trim();
  const angled = trimmed.match(/^(.*)<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (!angled) return trimmed.toLowerCase();
  return (angled[2] ?? "").trim().toLowerCase();
}

export function assert_valid_mail_from(mail_from: string): string {
  if (!mail_from.trim()) {
    throw new Error("MAIL_FROM is required (verified Cloudflare sender; no default)");
  }
  const sender_email = sender_email_from_mail_from(mail_from);
  const at = sender_email.lastIndexOf("@");
  if (at < 0) {
    throw new Error("MAIL_FROM must be a verified Cloudflare sender address");
  }
  const domain = sender_email.slice(at + 1).toLowerCase();
  const sending_host = MAIL_SENDING_SUBDOMAIN.toLowerCase();
  if (domain !== sending_host && domain !== MAIL_ZONE_NAME.toLowerCase()) {
    throw new Error("MAIL_FROM sender domain must be the onboarded sending domain");
  }
  return sender_email;
}

export function worker_name(stage: string): string {
  assert_valid_stage(stage);
  return `ast-core-${stage}`;
}

export function bucket_name(stage: string): string {
  assert_valid_stage(stage);
  // Stage-aware; wrangler local/test uses bare `ast-core-config`.
  // Alchemy prod uses `ast-core-config-prod` (authoritative prod).
  return `ast-core-config-${stage}`;
}

export function hyperdrive_name(stage: string): string {
  assert_valid_stage(stage);
  // Matches wrangler one-time `ast-core-db` base, stage-qualified.
  return `ast-core-db-${stage}`;
}

// Public origin validation. Mirrors the runtime allowlist in src/http.ts
// shellHeadersFor (single exact origin, no wildcards/credentials, no
// path/query/fragment) so deploy-time and runtime agree and fail closed.
export function normalize_origin(raw: string | undefined, var_name: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error(`${var_name} is required`);
  if (trimmed.includes("*")) throw new Error(`${var_name} must be a single exact origin (no wildcards)`);
  const parsed = Result.try(() => new URL(trimmed));
  if (Result.isFailure(parsed)) {
    throw new Error(`${var_name} must be a valid absolute URL (got ${JSON.stringify(trimmed)})`);
  }
  const u = parsed.success;
  if (u.username || u.password) throw new Error(`${var_name} must not embed credentials`);
  if (u.search || u.hash) throw new Error(`${var_name} must not include query or fragment`);
  if ((u.pathname !== "/" && u.pathname !== "") || trimmed.endsWith("/")) {
    throw new Error(`${var_name} must be a bare origin with no path (got ${JSON.stringify(trimmed)})`);
  }
  if (!u.hostname) throw new Error(`${var_name} must include a hostname`);
  const host = u.hostname.toLowerCase();
  // Reject wildcards after URL parse too: percent-encoded forms (e.g.
  // https://%2A.example.com) contain no literal "*" pre-parse but normalize
  // to a wildcard hostname.
  if (host.includes("*")) throw new Error(`${var_name} must be a single exact origin (no wildcards)`);
  const def_port = u.protocol === "https:" ? "443" : "80";
  const port = u.port && u.port !== def_port ? `:${u.port}` : "";
  return `${u.protocol}//${host}${port}`;
}

export function assert_origin_for_stage(origin: string, var_name: string, stage: string): void {
  assert_valid_stage(stage);
  const u = new URL(origin);
  // All Alchemy-deployed stages attach an exact HTTPS custom domain
  // (stage-specific AST_*_ORIGIN); Wrangler remains the local-dev path
  // where http loopback is tolerated. Require https here so every
  // deployed stage is usable (issuer/redirects match the attached domain).
  if (u.protocol !== "https:") {
    throw new Error(`${var_name} must be an exact https origin (got ${JSON.stringify(origin)})`);
  }
}

export function hostname_from_origin(origin: string): string {
  return new URL(origin).hostname.toLowerCase();
}

// Separate Workers cannot share the same custom-domain owner. Ownership is
// hostname-scoped (not port): Core and Relay must have distinct hostnames,
// otherwise the second custom-domain attach moves ownership away.
export function assert_distinct_origins(core_origin: string, relay_origin: string): void {
  const parsed_hosts = Result.try(() => ({
    core_host: new URL(core_origin).hostname.toLowerCase(),
    relay_host: new URL(relay_origin).hostname.toLowerCase(),
  }));
  if (Result.isFailure(parsed_hosts)) {
    throw new Error("AST_CORE_ORIGIN and AST_RELAY_ORIGIN must be valid absolute URLs");
  }
  const { core_host, relay_host } = parsed_hosts.success;
  if (!core_host || !relay_host) {
    throw new Error("AST_CORE_ORIGIN and AST_RELAY_ORIGIN must include hostnames");
  }
  if (core_host === relay_host) {
    throw new Error("AST_CORE_ORIGIN and AST_RELAY_ORIGIN must have distinct hostnames (separate Workers cannot share one custom-domain owner; ports do not separate ownership)");
  }
}

export function assert_all_origins_distinct(
  core_origin: string,
  relay_origin: string,
  auth_origin: string,
  dashboard_origin: string,
): void {
  const parsed = Result.try(() => [
    new URL(core_origin).hostname.toLowerCase(),
    new URL(relay_origin).hostname.toLowerCase(),
    new URL(auth_origin).hostname.toLowerCase(),
    new URL(dashboard_origin).hostname.toLowerCase(),
  ]);
  if (Result.isFailure(parsed)) {
    throw new Error("AST_*_ORIGIN values must be valid absolute URLs");
  }
  const hosts = parsed.success;
  if (hosts.some((h) => !h)) {
    throw new Error("AST_*_ORIGIN values must include hostnames");
  }
  if (new Set(hosts).size !== hosts.length) {
    throw new Error("AST_CORE/RELAY/AUTH/DASHBOARD origins must have distinct hostnames (separate Workers cannot share one custom-domain owner)");
  }
}

export function assert_browser_origins_for_stage(
  auth_origin: string,
  dashboard_origin: string,
  stage: string,
): void {
  assert_valid_stage(stage);
  assert_origin_for_stage(auth_origin, "AST_AUTH_ORIGIN", stage);
  assert_origin_for_stage(dashboard_origin, "AST_DASHBOARD_ORIGIN", stage);
  if (stage === "prod") {
    if (auth_origin !== AUTH_PROD_ORIGIN) {
      throw new Error(`AST_AUTH_ORIGIN must be ${AUTH_PROD_ORIGIN} in prod`);
    }
    if (dashboard_origin !== DASHBOARD_PROD_ORIGIN) {
      throw new Error(`AST_DASHBOARD_ORIGIN must be ${DASHBOARD_PROD_ORIGIN} in prod`);
    }
  } else {
    if (auth_origin === AUTH_PROD_ORIGIN || dashboard_origin === DASHBOARD_PROD_ORIGIN) {
      throw new Error("preview stages must not reuse prod browser origins (second custom-domain attach would move ownership)");
    }
  }
}

// Secret Postgres origin URL -> Hyperdrive PublicOrigin (password stays Redacted).
//
// Input is the full connection string from secret env
// (AST_CORE_DATABASE_URL). Only generic shape errors are thrown; messages
// never include the URL, host, user, or password.
export interface ParsedPostgresOrigin {
  readonly scheme: "postgres" | "postgresql";
  readonly host: string;
  readonly port?: number;
  readonly database: string;
  readonly user: string;
  readonly password: Redacted.Redacted<string>;
}

export function parse_postgres_url(url_string: string): ParsedPostgresOrigin {
  const parsed_url = Result.try(() => new URL(url_string));
  if (Result.isFailure(parsed_url)) {
    throw new Error("invalid Postgres origin URL (unparseable)");
  }
  const u = parsed_url.success;
  const proto = u.protocol.replace(/:$/, "");
  if (proto !== "postgres" && proto !== "postgresql") {
    throw new Error("invalid Postgres origin URL (scheme must be postgres or postgresql)");
  }
  if (!u.hostname) throw new Error("invalid Postgres origin URL (missing host)");
  if (u.username === "") throw new Error("invalid Postgres origin URL (missing user)");
  // Password may be empty for local dev URLs, but prod secrets must carry one.
  // Do not enforce here; Cloudflare will reject empty at provision time.
  const decoded_password = Result.try(() => decodeURIComponent(u.password));
  if (Result.isFailure(decoded_password)) {
    throw new Error("invalid Postgres origin URL (bad password encoding)");
  }
  const raw_password = decoded_password.success;
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!db) throw new Error("invalid Postgres origin URL (missing database)");
  if (u.search || u.hash) throw new Error("invalid Postgres origin URL (must not include query or fragment)");
  const port = u.port ? Number(u.port) : undefined;
  if (u.port && !Number.isInteger(port)) throw new Error("invalid Postgres origin URL (bad port)");
  return {
    scheme: proto,
    host: u.hostname.toLowerCase(),
    ...(port !== undefined ? { port } : {}),
    database: db,
    user: decodeURIComponent(u.username),
    password: Redacted.make(raw_password) };
}
