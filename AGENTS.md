# AGENTS.md — Core (`ast-core`)

Independent sibling repo of `editor` (Rust Editor/Forge) and `relay`.
Do not edit `../editor` or `../relay`. Do not undo user changes elsewhere.

- Stack: TypeScript 7.1 (beta) + Effect + Reylo (TS content mappers, no
  codegen). ALL SQL lives in `.sql` files: `db/schema.sql`,
  `db/migrations/*.sql`, `src/db/queries/*.sql`. Never inline SQL in `.ts`.
- Runtime: Cloudflare Workers. Primary DB: PostgreSQL through Hyperdrive
  (`postgres.js` driver). Local dev DB for Reylo inference: real
  PostgreSQL 18 in Docker (`DATABASE_URL`, default
  `postgres://core:core@127.0.0.1:55432/core`); tests run behaviorally
  against in-process PGlite with `db/schema.sql` applied. SQL stays
  plain-Postgres (no exotic extensions) for parity.
- Contracts: Effect Schema is authoritative for every request/response/event
  and nested field. Strict requests (reject unknown fields);
  forward-compatible response reads (ignore unknown). OpenAPI exported from
  schemas where applicable. `docs/contracts.md` wins on drift; coordinate
  changes via root.
- Security: no hardcoded dev bypass in production (`CORE_ENV=production`
  refuses dev keys/log mail/preview endpoints). Secrets never in logs.
  Ownership is server-derived; never trust client-supplied account/machine
  ownership. Email link GET never consumes. Email alone never bypasses TOTP.
- Boundaries: Core owns identity/sessions/authorization/credentials/machines/
  activity. `src/services/*` is shared and never imports `src/products/*`;
  Editor product logic lives
  under `src/products/editor/` with its router composed by `src/http.ts`.
  Products depend on shared, never reverse. Core never stores
  threads/runs (Forge SQLite owns those). Relay owns routing/presence only:
  no shared DB, no Core internals import — JWKS + revocation list + grant
  verification only.
- Crypto: Ed25519 everywhere (machine keys, request proof, grant JWT
  `alg=EdDSA`). Vetted libs only: `jose` (JWT/JWKS), `@noble/hashes`
  (SHA-256, random), `@noble/ciphers` (AES-GCM), `@scure/base` (base64url),
  `@oslojs/otp` (TOTP). No homemade crypto, no fake
  OAuth, no invented provider APIs (API-key vault + opaque engine
  artifacts from the harness's own local login).
- Tests must be behavioral (HTTP + real PGlite DB), not mirrors of constants.
