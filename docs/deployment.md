# Core deployment (Cloudflare)

Status: **not deployed**. No real Cloudflare resources have been created
from this repo; do not claim otherwise.

Authoritative production path: **Alchemy** (`infra/`, stack `ast-core`,
`Cloudflare.state()` account backend, stage from CLI).
`wrangler.jsonc` remains for **local dev and dry-run checks only**.
Alchemy owns prod; Wrangler never deploys prod.

## Alchemy (authoritative prod)

See `infra/README.md` for the reproducible flow and `infra/.env.example`
for all inputs. Summary:

- Build both artifacts from a single `pnpm install --frozen-lockfile`
  (fresh-clone safe): `pnpm run infra:build` (root worker
  `dist/ast_core/index.js` via Vite+/Reylo, and portal `web/dist`).
  Root `pnpm run build` alone only emits the worker bundle; the portal
  needs `pnpm run build:web`. Alchemy reuses these with `bundle: false`
  (Wrangler `no_bundle` contract); plain Alchemy rolldown of
  `src/index.ts` would miss Reylo `.sql` transforms.
- Deploy with the project-local binary (never a global install):
  `pnpm run infra:deploy --stage <stage>` (prebuilds + verifies, then
  `pnpm exec alchemy deploy`; pnpm forwards flags directly, no `--`
  separator). Preview with `pnpm run infra:plan --stage <stage>`.
  Direct equivalent from `infra/`:
  `pnpm exec alchemy deploy --config alchemy.run.ts --stage <stage>`.
  Worker `ast-core-<stage>` via REAL factory `buildCoreWorkerProps`
  (async `main` + `env`, `runWorkerFirst: true`,
  `notFoundHandling: "none"`), canonical literal origins
  (`CORE_PUBLIC_BASE_URL`/`CORE_JWT_ISSUER` = normalized `AST_CORE_ORIGIN`,
  `CORE_RELAY_ORIGIN` = normalized relay; only secrets stay
  `Config.Redacted`), `MAIL_FROM` required (verified sender, no default),
  R2 `ast-core-config-<stage>`,
  Hyperdrive `ast-core-db-<stage>` with `caching: { disabled: true }`
  explicit (the flag lives on the Alchemy resource, not in wrangler
  config), exact HTTPS custom domain on EVERY stage
  (stage-specific `AST_CORE_ORIGIN`; `workersDev: false`).
- Shared public inputs (same names in both repos):
  `AST_CORE_ORIGIN`, `AST_RELAY_ORIGIN` — exact https bare origins for
  ALL stages, distinct HOSTNAMES (`Core != Relay` by hostname, ports do
  not separate custom-domain ownership). **Stage-specific values only**:
  never demonstrate or run prod and preview/dev with the same `.env`
  domains — the second custom-domain attach would move ownership.
- Secrets (operator-supplied, `Config.Redacted`, never logged/output):
  `AST_CORE_DATABASE_URL` (external Postgres direct URL; no hosting
  choice here), `CORE_MASTER_KEY` (32B base64url), `CORE_ADMIN_TOKEN`,
  `RESEND_API_KEY`, plus required `MAIL_FROM`. Stage files
  (`infra/.env.<stage>`, `.env.*`) are gitignored; only
  `infra/.env.example` is committed.
- State: `Cloudflare.state()` (account default `alchemy-state-store`).
  First `plan`/`dev`/`deploy` bootstraps the store Worker; `CI=true`
  missing-store fails (pre-provision via
  `pnpm exec alchemy state bootstrap --backend cloudflare --profile <name>`).
  Never run `plan`/`dev`/`deploy` for “verification” — they ensure cloud
  state. Offline checks only: `pnpm run infra:check`
  (build + typecheck + tests).
- Outputs are public URLs/names/ids only; no secrets.

Auth: `pnpm exec alchemy profile edit --add Cloudflare`
(OAuth/token → default profile); CI uses `CLOUDFLARE_ACCOUNT_ID` + token.

## Wrangler (local dev and dry-run checks only)

Wrangler never deploys production. Local flows only:

- `pnpm run dev` (vp dev, port 8787) with `.env` / `.dev.vars` local vars.
- `pnpm exec wrangler dev` for the local Worker runtime.
- `pnpm run build && pnpm exec wrangler deploy --dry-run` as a local template
  check (no cloud mutations).

Production Hyperdrive/R2/domain/secrets are owned by Alchemy (see
above): Hyperdrive caching stays disabled via the Alchemy resource
(`caching: { disabled: true }`), R2 via `ast-core-config-<stage>`,
domains via stage-specific `AST_CORE_ORIGIN`, secrets via
`Config.Redacted` deploy inputs. There is no `wrangler hyperdrive
create/update`, `wrangler secret put`, or `wrangler deploy` production
path in this repo.

## Database migrations (explicit, unchanged)

`DATABASE_URL=<direct postgres url> pnpm run db:setup` (migrations run
in transactions under an advisory lock; concurrent migrators serialize).
Run against the direct Postgres origin before deploying the Worker that
pools it via Hyperdrive.

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

1. `DATABASE_URL=<direct postgres url> pnpm run db:setup` (migrations run
   in transactions under an advisory lock; concurrent migrators serialize).
2. `pnpm run typecheck && pnpm run test` (needs the dev DB reachable for Reylo
   inference: default `postgres://core:core@127.0.0.1:55432/core`).
3. `pnpm run infra:build && pnpm run infra:check` (offline; builds both
   artifacts from the workspace lockfile, then typecheck/tests/verify), then
   `pnpm run infra:plan --stage <stage>` / `pnpm run infra:deploy --stage <stage>`.
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
