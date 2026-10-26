# Core deployment (Cloudflare)

Status: **not deployed**. `npx wrangler deploy --dry-run` passes against
the committed template. No real Cloudflare resources have been created
from this repo; do not claim otherwise.

## One-time provisioning (real account required)

1. Hyperdrive to the production PostgreSQL:
   `wrangler hyperdrive create ast-core-db --connection-string='postgres://…'`
   then put the returned `id` in `wrangler.jsonc` (`hyperdrive[0].id`,
   currently `replace-with-hyperdrive-id`). Postgres 14+ is fine; SQL is
   plain (no exotic extensions).
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

## Apply schema + verify

1. `DATABASE_URL=<direct postgres url> npm run db:setup` (migrations run
   in transactions under an advisory lock; concurrent migrators serialize).
2. `npm run typecheck && npm test` (needs the dev DB reachable for Reylo
   inference: default `postgres://core:core@127.0.0.1:55432/core`).
3. `npm run build && npx wrangler deploy --dry-run`, then deploy.
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
