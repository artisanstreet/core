# ast-core infra (Alchemy IaC, isolated)

Deploy tooling only. The service stays on Effect 3.22.4; this package uses
Effect 4 per Alchemy peers with its own tsconfig (workspace pnpm-lock).

Pinned (verified 2026-10-27, `npm view alchemy dist-tags`):
- `alchemy@2.0.0-beta.84` (`latest`; `next` is `2.0.0-beta.72`)
- `@alchemy.run/cloudflare@2.0.0-beta.84`
- `@alchemy.run/domain@2.0.0-beta.84`, `@alchemy.run/frontend-frameworks@2.0.0-beta.84`
- `effect@4.0.6`, `@effect/platform-node@4.0.6` (satisfies `^4.0.5` peers)
- `typescript@7.1.0-beta`, Node `>=24.11.1`

API evidence: installed `beta84` types
(`infra/node_modules/@alchemy.run/cloudflare/src/…`) + official docs
`https://alchemy.run/llms.txt` (index) and guide pages
(`…/cloudflare/compute/workers#async-workers`,
`…/cloudflare/data/hyperdrive`, `…/cloudflare/data/r2`,
`…/cloudflare/networking/custom-domains`,
`…/cloudflare/security/secrets-env`, `…/state-store`,
`…/environments/stages`, `…/environments/secrets`,
`…/getting-started`, `…/cli`). No v1 API.

## What is deployed

- Worker `ast-core-<stage>` (async plain module via REAL factory
  `buildCoreWorkerProps` in `src/worker.ts`, used by both the deployed
  `Cloudflare.Worker` and tests — no duplicate test-only descriptors):
  `main` = absolute `dist/ast_core/index.js` (prebuilt via root
  `pnpm run build`; Reylo `.sql` transforms already compiled in),
  `bundle: false` (Wrangler `no_bundle` contract; sibling
  `dist/ast_core/assets/*.js` chunks upload as additional modules,
  `.map` excluded by `defaultModuleRules`), `compatibility`
  `{ date: "2026-10-01", flags: ["nodejs_compat"] }`,
  `assets` = absolute `web/dist` (prebuilt via `pnpm run build:web` from the root)
  with `runWorkerFirst: true` (REQUIRED; worker-first auth/CSP; API/UI/metadata
  never fall through; SPA fallback in `src/http.ts` via `ASSETS`),
  `notFoundHandling: "none"`, `env` = canonical literals +
  `Config.Redacted` secrets + resources (below), exact HTTPS custom
  `domain` on EVERY stage (stage-specific `AST_CORE_ORIGIN` hostname),
  `workersDev: false` (no invented workers.dev preview URLs).
- R2 `ast-core-config-<stage>` (`CONFIG_BUCKET` binding).
- Hyperdrive `ast-core-db-<stage>` (`HYPERDRIVE` binding) with
  `caching: { disabled: true }` EXPLICIT. Origin comes from secret
  `AST_CORE_DATABASE_URL` (external Postgres; no hosting provisioned).
- Env (persisted schema, canonical literals): `CORE_ENV=production`,
  `CORE_PUBLIC_BASE_URL=<canonical coreOrigin>`,
  `CORE_JWT_ISSUER=<canonical coreOrigin>` (same literal, so issuer
  matches the normalized issuer even for uppercase/trailing-slash
  inputs), `CORE_SPA_APPROVE_PATH=/#/approve`,
  `CORE_RELAY_ORIGIN=<canonical relayOrigin>`,
  `MAIL_PROVIDER=resend`, `MAIL_FROM=<required verified sender>`, plus secrets
  `CORE_MASTER_KEY`, `CORE_ADMIN_TOKEN`, `RESEND_API_KEY` via
  `Config.Redacted` ONLY (bind as `secret_text`). No generated/rotated keys.
  Single declaration: bucket/hyperdrive yielded once in `alchemy.run.ts`
  and passed to `makeCoreWorker({ bucket, hyperdrive })`
  (Worker never re-yields them).
- Stack `ast-core`, stage from CLI,
  state `Cloudflare.state()` (account default `alchemy-state-store`,
  Cloudflare-backed remote). No sibling source imports.

Shared public inputs (same names in both repos):
`AST_CORE_ORIGIN`, `AST_RELAY_ORIGIN`. Exact https bare origins for ALL
deployed stages (no path/query, no wildcard, no credentials; https
required even for preview — every stage attaches a custom domain).
`Core != Relay` by HOSTNAME (ports do not separate ownership; separate
Workers cannot share one custom-domain owner — the second attach would
move ownership). Stage-specific values: never reuse prod domains for
preview/dev stages; never demonstrate prod and preview with the same
`.env` domains. All inputs documented in `infra/.env.example`
(stage files `infra/.env.<stage>` are gitignored).

## Reproducible flow (no global install)

The project-local `alchemy` binary resolves via the workspace
(`pnpm exec alchemy`) or the `infra:*` pnpm wrappers below.

One ordered fresh-clone sequence (run from the repo root — a single
`pnpm install --frozen-lockfile` covers the whole workspace from
`pnpm-lock.yaml`, then the local build DB is prepared before
`infra:check`):

```sh
pnpm install --frozen-lockfile
cp -n .env.example .env     # local DATABASE_URL -> 127.0.0.1:55432 (see README quickstart)
# docker: ast-core-dev-pg on 127.0.0.1:55432 (Postgres 18), must be running
pnpm run db:setup            # applies db/migrations/*.sql (transactional + locked)
pnpm run infra:check      # portal-first build + typecheck + tests + verify (see below)
```

Why the build needs that local DB (distinct from deploy secrets): the
worker build runs the Reylo Vite plugin `sqlModule`, which
`Session.analyze`s every `.sql` import against the schema (`.reylo.yaml`
`direct_url: ${DATABASE_URL}`, `env: [.env, .env.local]`). A fresh
checkout has no `.reylo/` cache (gitignored), so without the
schema-populated DB above the worker build fails; with explicit
`DATABASE_URL` and clean outputs (`.reylo/`, `dist/ast_core/`,
`web/dist/` removed) it re-analyzes and succeeds (exit 0). So
infra unit tests are DB-free, but `build` is NOT
truly offline — it may touch that local DB. Never substitute production
creds here: `AST_CORE_DATABASE_URL` (secret Hyperdrive deploy origin) is
a different variable for a different purpose; the build only ever uses
local/CI `DATABASE_URL`.

`pnpm run build` = `build:web` + `build:worker` (portal first):
- `build:web`: `pnpm --dir ../web run build` (portal Vite+ build,
  emits `web/dist/index.html` + `web/dist/assets/*`).
- `build:worker`: `pnpm --dir .. run build` (root `vp build`, emits the
  single-file worker bundle `dist/ast_core/index.js`; no `assets/`
  chunks, no sourcemaps).
  `wrangler.jsonc` `assets.directory` (`./web/dist`) is the static-asset
  source the worker serves at runtime, so the portal builds first and a
  fresh checkout never loads the worker build against a missing assets
  dir. Root `pnpm run build` alone does NOT emit `web/dist`.
`check`/`plan`/`deploy` all prebuild first, so a
fresh clone never silently uses stale or missing artifacts.

pnpm appends extra args to the end of the script, so stage flags
forward through the wrappers as-is (no `--` separator needed):

```sh
cd /home/sander/projects/artisanstreet/core
pnpm run infra:build    # -> pnpm --dir infra run build
pnpm run infra:check    # -> pnpm --dir infra run check
pnpm run infra:plan --stage prod
pnpm run infra:deploy --stage prod
```

Benign forwarding check (no state bootstrap, help only):

```sh
pnpm exec alchemy --help   # from infra/: project-local binary, no npx
pnpm --dir infra exec alchemy deploy --help   # from core root
```

Plan/deploy (need real Cloudflare + Postgres + secrets; DO NOT run
without them — first `plan`/`dev` bootstraps account state, see below).
`plan`/`deploy` prebuild first:

```sh
# prod (example; use stage-specific env files, never share domains)
AST_CORE_ORIGIN=https://core.artisanstreet.dev \
AST_RELAY_ORIGIN=https://relay.artisanstreet.dev \
AST_CORE_DATABASE_URL='postgres://…' \
CORE_MASTER_KEY='…' CORE_ADMIN_TOKEN='…' RESEND_API_KEY='…' MAIL_FROM='Ast <ops@example.com>' \
pnpm run deploy --stage prod --profile default

# preview (different origins; same .env domains would move ownership)
AST_CORE_ORIGIN=https://core-pr-42.example.dev \
AST_RELAY_ORIGIN=https://relay-pr-42.example.dev \
… pnpm run deploy --stage pr-42

# preview what would change (same bootstrap caveat as deploy)
pnpm run plan --stage prod
# or: pnpm exec alchemy deploy --dry-run --config alchemy.run.ts --stage prod
```

## Auth / bootstrap / migration (accurate)

- Auth: `pnpm exec alchemy profile edit --add Cloudflare` (OAuth or
  API token, saved to `~/.alchemy/profiles.json`, default profile).
  CI uses `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (or key+email).
  See `…/cloudflare/setup`.
- State: `Cloudflare.state()` (recommended for CF-only infra). First
  `plan`/`dev`/`deploy` against an account with no store deploys the
  store Worker once (`alchemy-state-store` + Secrets Store entries;
  reused across stacks/stages). In CI (`CI=true`) a missing store fails
  instead — pre-provision with
  `pnpm exec alchemy state bootstrap --backend cloudflare --profile <name>`.
  See `https://alchemy.run/state-store`. NEVER run `plan`/`dev`/`deploy`
  here for “verification” — they mutate/ensure cloud state.
- Migration from wrangler: wrangler template used `ast-core` /
  `ast-core-config` / hyperdrive id placeholder. Alchemy stages qualify
  names (`ast-core-prod`, …). Either adopt existing resources
  (`--adopt`, see `…/cli/adopting-resources`) or let Alchemy create
  stage-qualified ones and cut over DNS. Alchemy is authoritative for
  prod; `wrangler.jsonc` remains for local dev/dry-run only (see
  `docs/deployment.md`). Generated `dist/ast_core/wrangler.json`
  (`no_bundle:true`) is non-authoritative and ignored for modules
  (`.json` not in `defaultModuleRules`).
- Secrets: operator-supplied only (`Config.Redacted`), never logged,
  never in outputs, never generated per-deploy. `CI=true` missing-store
  fails (no silent bootstrap).

## External prerequisites (genuine, not verified here)

Cloudflare account + zone for the prod hostname, external Postgres
14+ reachable for Hyperdrive (direct URL in `AST_CORE_DATABASE_URL`),
verified Resend sender/key (`MAIL_FROM` required, no default),
32-byte base64url `CORE_MASTER_KEY`, `CORE_ADMIN_TOKEN`. No deploys were
performed from this repo; do not claim otherwise.
