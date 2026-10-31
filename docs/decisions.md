# Core decisions (2026-10-26/27)

Owner: Core. Coordinated via root; Relay/Rust contributors read
`docs/contracts.md` (normative) + `contracts/v1.openapi.json` + `fixtures/v1/`.

## Stack (user-approved, verified in use)

- TypeScript 7.1 beta (`typescript@7.1.0-beta`) + Effect 3 + Reylo 0.5.0
  (`@reylosql/postgres`). All SQL lives in `.sql` files: `db/schema.sql`,
  `db/migrations/*.sql`, `src/db/queries/**/*.sql`. Typecheck is
  `tsc --noEmit --runExternalCode`; Reylo content-mapper errors surface at
  file/line/column and fail the build (observed live: duplicate-parameter
  and stale-column errors during development).
- Query results use Reylo-inferred types directly — no `as unknown` casts,
  no hand-maintained row mirrors, no generic cardinality normalization.
  A migration that a query does not reflect is a compile error (observed:
  new `totp_pending_secret_enc` unreadable until the SELECT listed it).
- Cloudflare Workers (vite + @cloudflare/vite-plugin + `reylo/vite`;
  `.sql` imported by relative path only), PostgreSQL through Hyperdrive
  (`postgres.js`), R2 for config manifests. Local dev/test DB is real
  PostgreSQL 18 in Docker (`ast-core-dev-pg`, `127.0.0.1:55432`); tests run
  behaviorally against in-process PGlite with `db/schema.sql` applied.
- `db/schema.sql` is the canonical full schema; `db/migrations/` is the
  deploy path. A parity test diffs information_schema (tables, columns,
  constraints) of both. Pre-release: migrations squash with a note here;
  no production data exists yet.

## Product split (ecosystem rule)

- `src/services/*` (identity, sessions, authz, machines, grants, generic
  encrypted vault, activity, deletion, janitor, mail, storage) is shared
  and never imports product code (enforced by `tests/architecture.test.ts`).
- `src/products/editor/*` owns Editor MCP/skill/config/provider-adapter
  logic: `config.ts` (bundles/manifests/revisions), `artifacts.ts`
  (envelope validation), `providers.ts` (API-key adapter rules),
  `routes.ts` (product router). Central `src/http.ts` composes it.
- `src/contracts/*` is shared wire language (Effect Schema authoritative,
  strict requests, forward-compatible reads, OpenAPI generated from the
  runtime registry). Product-domain validation lives in the product layer.

## Auth model (as built)

- Every person is an AST account (`accounts`); how they get in is a separate
  set of sign-in methods (`sign_in_methods`: `email`, `google`, `github`),
  Better Auth style. There are no passwords. An account created through
  Google or GitHub is an ordinary account whose only method is that
  provider; signing up through a provider only prefills the account form
  (verified email, name, avatar). OAuth rows match on the provider's stable
  user id, never on email. Every live account keeps at least one method;
  removing a method needs TOTP when enrolled.
- Email links: request secret (held by the originating session) completes
  login; the emailed token only marks approval. GET never consumes.
  Cross-browser flow requires explicit original-session approval with safe
  binding. Signing up by email creates the `email` method. An account with
  email sign-in off gets a notice instead of a link, with an identical
  response (no enumeration), and finalize re-checks the method.
- Google/GitHub sign-in (authorization code + PKCE): `oauth_flows` holds the
  state and a browser-held flow secret as hashes and the verifier
  encrypted. The callback claims the flow before talking to the provider,
  so a flow completes once and only in the browser that started it.
  Outcomes: signed in, second factor required, signup required (prefill),
  linked, linked elsewhere, email taken (an existing account with that
  email is never linked silently; the person links from settings),
  no verified email. Providers without client credentials answer 503.
- TOTP optional with recovery codes. Pending vs active secret columns:
  enrollment stages pending (refused while active; replacing MFA goes
  through disable with a live code). Email alone never bypasses TOTP;
  outstanding logins re-check current factor state at finalize.
- TOTP single-use is durable: per-account attempt budgets (DB counters)
  plus atomic `totp_used_steps(account_id, step)` claims; replays and
  racers lose. Tests pin a mutable rig clock (no production test branch).
- finalize is atomic (completion + session + audit in one transaction).
- Machine enrollment: Ed25519 proof-of-possession at start, short single-use
  code (rejection-sampled over the 31-char alphabet), authenticated claim,
  polling reveals the exact claiming identity, local Forge confirms with a
  confirmation signature binding (enrollment, account, key). Guesses alone
  create nothing. Nonce replay protection is a durable unique insert, and
  signatures verify BEFORE nonce claims (no poisoning).
- Grants are standard JWT EdDSA (`v:1`, `iss`, `aud` singular exact,
  `sub` account, `mid` explicit target, `role` client|forge, `cnf` JWK,
  scopes `relay:connect|forge:execute|machine:sync`, TTL ≤300 s) + JWKS +
  revocation list. No `rev` epoch (short TTL + list is the mechanism).
  Editor grants carry ephemeral `cnf` submitted by the session; machine
  grants pin `cnf` to the enrolled key. Noise XX transcript binding is
  Relay/Forge's job; Core supplies keys + JWTs only (no X25519 registry).

## Vault (two stores, no fake OAuth)

- `provider_connections`: API keys ONLY (anthropic/openai/openrouter/
  google). The only OAuth Core performs is Google/GitHub account sign-in;
  it never runs OAuth against AI providers. Encrypted at rest, released
  solely to assigned live machines of the same account.
- `engine_artifacts`: opaque envelopes from the harness's OWN local login
  (claude/codex/opencode subscription or key flows — the only OAuth that
  exists runs locally in the harness). Core validates envelope shape,
  encrypts the blob, releases only to assigned machines where Forge
  imports the files. Machine-authenticated discovery lists only the
  caller's own assigned metadata (no secrets, no other machines).
- Assignment mutations bind BOTH ends to the caller's account in SQL;
  config state reports additionally refuse version regressions (409 vs 403).
- `config_bundles` uniqueness is per account (a global content hash would
  collide across tenants). Publishing is insert-or-nothing + bounded retry
  (concurrency-safe without error-shape coupling); identical content dedups.
  Sync is checksum-based: content-hash ETags, `If-None-Match` → 304,
  private cache directives; auth runs before conditional evaluation.

## Pre-release schema corrections (all squashed into 0001, documented)

- `config_bundles`: `unique(content_hash)` → `unique(account_id, content_hash)`.
- `accounts.totp_pending_secret_enc` added (pending vs active factor).
- `totp_used_steps(account_id, step)` added (replay protection).
- Deletion purge deletes the request row before the account row (FK).
- Enrollment code alphabet is 31 symbols (~39.6 bits), rejection-sampled.
- Machine-proof verifies signature before claiming the nonce.

## Mail, storage, rate limits

- `MAIL_PROVIDER=log` prints the confirmation URL and is refused in
  production; production uses `resend` (plain fetch, no SDK). No link
  logging in production paths.
- R2 holds content-addressed manifest blobs; the DB row carries identical
  bytes as fallback (hash-verified either way).
- Budgets are DB-backed fixed windows: login per-email 10/h, per-IP 20/h,
  global 200/h; TOTP per-account 10/h (+per-IP 30/h at finalize); claim
  per-account/per-IP/global; enrollment per-IP. Wrong/absent codes map to
  no target, so budgets never key on unknown enrollments/requests.

## Portal handoff (2026-10-27, API-only since 2026-10-27)

- Email links (`/v1/auth/magic/confirm?token=`) return read-only JSON
  instructions and never consume (mail-scanner safe). Approval is explicit
  `POST /v1/auth/magic/consume`; completion is `POST
  /v1/auth/magic/finalize`. The former SPA redirect/backend-page behavior
  is removed.
- Worker binds no static assets and serves no HTML; `web/` is a separate
  product on its own host and untouched by Core. Credential responses are
  no-store with the shared API security headers. Web author contract:
  same `/v1/` API, `?token=` approval param driving consume/finalize.
- Local smoke needs no mail credentials (log mailer + mail sink in tests).

## Not built / not claimed

- No real deployment performed (dry-run only); Hyperdrive ID, R2 bucket,
  and secrets are still placeholders — see `docs/deployment.md`.
- No portal UI: only minimal auth-confirm/claim pages; `core/web/` (or
  `core/src/portal/`) hosting hook is reserved for the portal contributor.
- Relay/Forge verification code is theirs; this repo proves the JWT +
  JWKS + revocation + proof vectors verify via `fixtures/v1/core-issued.json`
  (TEST-ONLY artifact regenerated by the suite).
