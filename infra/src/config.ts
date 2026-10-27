import * as Redacted from "effect/Redacted";

// Pure deploy-input helpers for ast-core Alchemy IaC.
//
// All functions here are credential-free except for the explicit Redacted
// password holder returned by parsePostgresUrl. No function logs secrets,
// and error messages never embed secret material (public origins may be
// echoed for operator debuggability; the database URL/password never is).

export const STACK_NAME = "ast-core" as const;

// Stage names must match the Alchemy CLI constraint:
// [a-z0-9][-_a-z0-9]*
const STAGE_PATTERN = /^[a-z0-9][-_a-z0-9]*$/;

export function assertValidStage(stage: string): void {
  if (!STAGE_PATTERN.test(stage)) {
    throw new Error(
      `invalid stage ${JSON.stringify(stage)}: must match [a-z0-9][-_a-z0-9]* (see alchemy CLI --stage)`,
    );
  }
}

// Prebuilt bundle seam (existing Vite/Reylo build, NOT Alchemy rolldown).
//
// `npm run build` (core root, vite + @cloudflare/vite-plugin + reylo/vite)
// emits:
//   dist/ast_core/index.js (+ dist/ast_core/assets/*.js chunks, .map)
//   dist/ast_core/wrangler.json (generated, non-authoritative, ignored)
// The portal SPA is built separately:
//   web/dist/index.html + web/dist/assets/* (hashed)
//
// Alchemy MUST reuse these artifacts with bundle:false (Wrangler no_bundle
// contract). Plain Alchemy rolldown of src/index.ts would NOT resolve the
// Reylo `.sql` transforms. Paths below are relative to the core repo root;
// run all alchemy commands from the core root with
// `--config infra/alchemy.run.ts` so cwd-relative resolution stays inside cwd
// and state stores portable relative paths.
export const WORKER_PREBUILT_ENTRY = "dist/ast_core/index.js" as const;
export const WEB_DIST_DIR = "web/dist" as const;

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
export const CORE_SPA_APPROVE_PATH_VALUE = "/#/approve" as const;
export const MAIL_PROVIDER_VALUE = "resend" as const;

export function workerName(stage: string): string {
  assertValidStage(stage);
  return `ast-core-${stage}`;
}

export function bucketName(stage: string): string {
  assertValidStage(stage);
  // Stage-aware; wrangler local/test uses bare `ast-core-config`.
  // Alchemy prod uses `ast-core-config-prod` (authoritative prod).
  return `ast-core-config-${stage}`;
}

export function hyperdriveName(stage: string): string {
  assertValidStage(stage);
  // Matches wrangler one-time `ast-core-db` base, stage-qualified.
  return `ast-core-db-${stage}`;
}

// Public origin validation. Mirrors the runtime allowlist in src/http.ts
// shellHeadersFor (single exact origin, no wildcards/credentials, no
// path/query/fragment) so deploy-time and runtime agree and fail closed.
export function normalizeOrigin(raw: string | undefined, varName: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error(`${varName} is required`);
  if (trimmed.includes("*")) throw new Error(`${varName} must be a single exact origin (no wildcards)`);
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`${varName} must be a valid absolute URL (got ${JSON.stringify(trimmed)})`);
  }
  if (u.username || u.password) throw new Error(`${varName} must not embed credentials`);
  if (u.search || u.hash) throw new Error(`${varName} must not include query or fragment`);
  if ((u.pathname !== "/" && u.pathname !== "") || trimmed.endsWith("/")) {
    throw new Error(`${varName} must be a bare origin with no path (got ${JSON.stringify(trimmed)})`);
  }
  if (!u.hostname) throw new Error(`${varName} must include a hostname`);
  const host = u.hostname.toLowerCase();
  // Reject wildcards after URL parse too: percent-encoded forms (e.g.
  // https://%2A.example.com) contain no literal "*" pre-parse but normalize
  // to a wildcard hostname.
  if (host.includes("*")) throw new Error(`${varName} must be a single exact origin (no wildcards)`);
  const defPort = u.protocol === "https:" ? "443" : "80";
  const port = u.port && u.port !== defPort ? `:${u.port}` : "";
  return `${u.protocol}//${host}${port}`;
}

export function assertOriginForStage(origin: string, varName: string, stage: string): void {
  assertValidStage(stage);
  const u = new URL(origin);
  // All Alchemy-deployed stages attach an exact HTTPS custom domain
  // (stage-specific AST_*_ORIGIN); Wrangler remains the local-dev path
  // where http loopback is tolerated. Require https here so every
  // deployed stage is usable (issuer/redirects match the attached domain).
  if (u.protocol !== "https:") {
    throw new Error(`${varName} must be an exact https origin (got ${JSON.stringify(origin)})`);
  }
}

export function hostnameFromOrigin(origin: string): string {
  return new URL(origin).hostname.toLowerCase();
}

// Separate Workers cannot share the same custom-domain owner. Ownership is
// hostname-scoped (not port): Core and Relay must have distinct hostnames,
// otherwise the second custom-domain attach moves ownership away.
export function assertDistinctOrigins(coreOrigin: string, relayOrigin: string): void {
  let coreHost: string;
  let relayHost: string;
  try {
    coreHost = new URL(coreOrigin).hostname.toLowerCase();
    relayHost = new URL(relayOrigin).hostname.toLowerCase();
  } catch {
    throw new Error("AST_CORE_ORIGIN and AST_RELAY_ORIGIN must be valid absolute URLs");
  }
  if (!coreHost || !relayHost) {
    throw new Error("AST_CORE_ORIGIN and AST_RELAY_ORIGIN must include hostnames");
  }
  if (coreHost === relayHost) {
    throw new Error("AST_CORE_ORIGIN and AST_RELAY_ORIGIN must have distinct hostnames (separate Workers cannot share one custom-domain owner; ports do not separate ownership)");
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

export function parsePostgresUrl(urlString: string): ParsedPostgresOrigin {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error("invalid Postgres origin URL (unparseable)");
  }
  const proto = u.protocol.replace(/:$/, "");
  if (proto !== "postgres" && proto !== "postgresql") {
    throw new Error("invalid Postgres origin URL (scheme must be postgres or postgresql)");
  }
  if (!u.hostname) throw new Error("invalid Postgres origin URL (missing host)");
  if (u.username === "") throw new Error("invalid Postgres origin URL (missing user)");
  // Password may be empty for local dev URLs, but prod secrets must carry one.
  // Do not enforce here; Cloudflare will reject empty at provision time.
  const rawPassword = (() => {
    try {
      return decodeURIComponent(u.password);
    } catch {
      throw new Error("invalid Postgres origin URL (bad password encoding)");
    }
  })();
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
    password: Redacted.make(rawPassword),
  };
}
