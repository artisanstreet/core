# Core deployment (Cloudflare)

Status: **not deployed**. No real Cloudflare resources have been created
from this repo; do not claim otherwise.

Authoritative production path: **Alchemy** (`infra/`, stack `ast-core`,
`Cloudflare.state()` account backend, stage from CLI).
`wrangler.jsonc` remains for **local/test only** (`wrangler dev`,
`--dry-run` template checks). Do not treat them as two competing
production sources: Alchemy owns prod; Wrangler never deploys prod.

## Alchemy (authoritative prod)

See `infra/README.md` for the reproducible flow. Summary:

- Prebuild first (core root): `npm ci && npm run build`
  (`dist/ast_core/index.js` + `dist/ast_core/assets/*` via Vite/Reylo;
  `web/dist` portal). Alchemy reuses these with `bundle: false`
  (Wrangler `no_bundle` contract); plain Alchemy rolldown of
  `src/index.ts` would miss Reylo `.sql` transforms.
- Deploy from `infra/` with the project-local binary
  (`npm run deploy -- --stage <stage>`, never bare global `alchemy`):
  Worker `ast-core-<stage>` via REAL factory `buildCoreWorkerProps`
  (async `main` + `env`, `runWorkerFirst: true`,
  `notFoundHandling: "none"`), canonical literal origins
  (`CORE_PUBLIC_BASE_URL`/`CORE_JWT_ISSUER` = normalized `AST_CORE_ORIGIN`,
  `CORE_RELAY_ORIGIN` = normalized relay; only secrets stay
  `Config.Redacted`), R2 `ast-core-config-<stage>`,
  Hyperdrive `ast-core-db-<stage>` with `caching: { disabled: true }`
  explicit, exact HTTPS custom domain on EVERY stage
  (stage-specific `AST_CORE_ORIGIN`; `workersDev: false`).
- Shared public inputs (both repos, same names):
  `AST_CORE_ORIGIN`, `AST_RELAY_ORIGIN` — exact https bare origins for
  ALL stages, distinct HOSTNAMES (`Core != Relay` by hostname, ports do
  not separate custom-domain ownership). **Stage-specific values only**:
  never demonstrate or run prod and preview/dev with the same `.env`
  domains — the second custom-domain attach would move ownership.
- Secrets (operator-supplied, `Config.Redacted`, never logged/output):
  `AST_CORE_DATABASE_URL` (external Postgres direct URL; no hosting
  choice here), `CORE_MASTER_KEY` (32B base64url), `CORE_ADMIN_TOKEN`,
  `RESEND_API_KEY`, plus resolved literal `MAIL_FROM`.
- State: `Cloudflare.state()` (account default `alchemy-state-store`).
  First `plan`/`dev`/`deploy` bootstraps the store Worker; `CI=true`
  missing-store fails (pre-provision via
  `alchemy state bootstrap --backend cloudflare`). Never run
  `plan`/`dev`/`deploy` for “verification” — they ensure cloud state.
  Offline checks only: `npm run check`, `npm run verify:bundle`
  (deploy-exact `readPrebuiltWorkerBundle` + entry import execution).
- Outputs are public URLs/names/ids only; no secrets.

Auth: `alchemy profile edit --add Cloudflare` (OAuth/token → default
profile); CI uses `CLOUDFLARE_ACCOUNT_ID` + token. Relay coordinates via
root only (distinct stack `ast-relay`, same input names, same backend).

## Wrangler one-time provisioning (local/test reference)

Kept coherent for local/test; not the prod path. If ever used directly:

1. Hyperdrive to the production PostgreSQL:
   `wrangler hyperdrive create ast-core-db --connection-string='postgres://…' --caching-disabled`
   then put the returned `id` in `wrangler.jsonc` (`hyperdrive[0].id`,
   currently `replace-with-hyperdrive-id`). Postgres 14+ is fine; SQL is
   plain (no exotic extensions).
   Caching MUST stay disabled (`--caching-disabled`): Core is an authority
   for sessions, machine enrollment/keys, vault assignments, and revocation
   state, and Hyperdrive does not invalidate cached rows on writes — a
   cached `revoked_at`/`revocations` read would keep honoring revoked
   sessions, keys, and machines until TTL. Local dev never emulates this
   (direct Postgres, no cache), so only production is at risk.
   If the config already exists, disable caching in place (no re-create):
   `wrangler hyperdrive update <id> --caching-disabled`.
   Verify before every deploy (genuine external prerequisite alongside the
   Hyperdrive id itself; production is NOT verified from this repo):
   `wrangler hyperdrive get <id>` must show caching disabled.
2. R2 bucket `ast-core-config` (or rename in `wrangler.jsonc`).
3. Custom domain for `https://core.artisanstreet.dev` (or set
   `CORE_PUBLIC_BASE_URL` / `CORE_JWT_ISSUER` to the real origin —
   both must match the deployed origin or grants fail closed).

## Secrets (wrangler secret put; never commit)

- `CORE_MASTER_KEY`: 32 random bytes, base64url, no padding. Generates:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
  Boot refuses the dev default (`AAA…`) in production.
- `RESEND_API_KEY`: required when `MAIL_PROVIDER=resend` (the production
  template value). The log mailer is refused in production by a boot guard.
- `CORE_ADMIN_TOKEN`: bearer for `/v1/admin/*` (key rotation, janitor
  trigger-as-HTTP). Without it those endpoints 404.
- No `DATABASE_URL` in production: the Worker uses the Hyperdrive binding.

## Hyperdrive + Postgres.js driver contract

- One `postgres()` client per request (`src/index.ts` `openDb`, closed via
  `waitUntil`); never cache clients across requests — Workers reuse of I/O
  handles is forbidden and caused alternating query failures. Hyperdrive
  owns pooling. Official reference:
  https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
- Client options follow that example: `max: 5, fetch_types: false,
  prepare: true`. `fetch_types: false` is required: Reylo decodes column
  types itself from text.
- Every Reylo query runs as a named prepared statement via
  `src/db/prepared.ts` (`prepareDb` forces `{ prepare: true, simple:
  false }` on `unsafe()`). The client-level flag alone does NOT
  propagate, and `unsafe()` defaults zero-param queries to the simple
  protocol, which ignores `prepare` — the adapter is what makes pooling
  safe. Pinned by `tests/db-prepared.test.ts`; validated against real
  PostgreSQL (named statements visible in `pg_prepared_statements` for
  params, zero-param, request and transaction paths).

## Apply schema + verify

1. `DATABASE_URL=<direct postgres url> npm run db:setup` (migrations run
   in transactions under an advisory lock; concurrent migrators serialize).
2. `npm run typecheck && npm test` (needs the dev DB reachable for Reylo
   inference: default `postgres://core:core@127.0.0.1:55432/core`).
3. `npm run build && npx wrangler deploy --dry-run` (local template check
   only), then Alchemy deploy per `infra/README.md`.
4. Post-deploy smoke: `GET /v1/version`, `GET /.well-known/jwks.json`
   (after first grant issuance a key exists), `POST /v1/admin/janitor`
   with `x-admin-token`.

## Rotation / ops

- Grant keys: `POST /v1/admin/keys/rotate`; retired kids stay in JWKS for
  a 15-minute grace window (in-flight ≤300 s grants keep verifying).
- Sessions/machines/vault: revoke via API; revocation list polling (60 s
  cache) + short TTLs bound exposure. There is no operator-proof E2E
  claim: Core (operator) can technically decrypt vault blobs — documented
  in contracts, not hidden.
- Backups: standard Postgres PITR for the Hyperdrive origin; R2 objects
  are content-addressed and re-publishable from account manifests.
