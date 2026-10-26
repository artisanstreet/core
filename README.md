# ast-core

AST account authority: magic-link identity (TOTP optional), Forge machine
enrollment into accounts, short-lived signed grants (EdDSA JWT + JWKS),
encrypted provider-credential vault with per-machine assignment, versioned
Editor MCP/skill configuration (content hashes, R2 manifests, applied
revisions), activity log, and account deletion lifecycle.

- Spec: `docs/contracts.md` (normative for Relay/Rust integration).
- Machine-readable: `contracts/v1.openapi.json`, `fixtures/v1/*.json`.
- Decisions/ops: `docs/decisions.md`, `docs/deployment.md`.
- Stack: TypeScript 7.1 beta + Effect + Reylo (all SQL in `.sql` files),
  Cloudflare Workers, PostgreSQL via Hyperdrive, R2 assets.

## Quick start (local, no Cloudflare account needed)

```sh
npm install
cp .env.example .env        # points at the local Docker Postgres below
# docker: ast-core-dev-pg on 127.0.0.1:55432 (Postgres 18)
npm run db:setup            # applies db/migrations/*.sql (transactional + locked)
npm run typecheck           # tsc --noEmit --runExternalCode (Reylo content mappers, live PG types)
npm run test                # vitest, real PGlite DB per test file, behavioral tests
npm run contracts:check     # emitted OpenAPI + fixtures match the runtime schemas
npm run contracts:emit      # regenerate contracts/v1.openapi.json + fixtures/v1/*
npm run dev             # vite dev (worker) on :8787
npm run build           # vite build -> dist/
npx wrangler deploy --dry-run   # Workers config check (needs wrangler login only for real deploy)
```

## Layout

- `docs/contracts.md` — normative wire contract (Relay/Rust build against it)
- `contracts/v1.openapi.json` — generated from the runtime route registry
- `fixtures/v1/` — cross-language vectors (incl. TEST-ONLY `core-issued.json`)
- `db/` — `schema.sql`, `migrations/*.sql`, `migrate-helpers/*.sql` (all SQL)
- `src/contracts/` — Effect Schema authority + OpenAPI builder + registry
- `src/services/` — shared: auth, sessions, machines, grants, vault, activity, deletion
- `src/products/editor/` — Editor product: config, artifacts, providers, routes
- `src/http.ts` — central router composing product routers
- `tests/` — behavioral tests (no mirrors of constants)

Env (see `.env.example`): `DATABASE_URL` (optional; defaults to PGlite file),
`CORE_MASTER_KEY` (base64url 32B; dev default only when `CORE_ENV=dev`),
`CORE_JWT_ISSUER`, `MAIL_PROVIDER=log`, `CORE_ENV=dev`.
