# ast-core infra (Alchemy IaC, isolated)

Deploy tooling only. The service stays on Effect 3.22.4; this package uses
Effect 4 per Alchemy peers with its own lockfile + tsconfig.

Pinned (verified 2026-10-27, `npm view alchemy dist-tags`):
- `alchemy@2.0.0-beta.84` (`latest`; `next` is `2.0.0-beta.72`)
- `@alchemy.run/cloudflare@2.0.0-beta.84`
- `@alchemy.run/domain@2.0.0-beta.84`, `@alchemy.run/frontend-frameworks@2.0.0-beta.84`
- `effect@4.0.6`, `@effect/platform-node@4.0.6` (satisfies `^4.0.5` peers)
- `typescript@7.1.0-beta` (aligns with service + Relay), Node >=24

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
  `main` = absolute `dist/ast_core/index.js` (prebuilt via `npm run build`
  at the core root; Reylo `.sql` transforms already compiled in),
  `bundle: false` (Wrangler `no_bundle` contract; sibling
  `dist/ast_core/assets/*.js` chunks upload as additional modules,
  `.map` excluded by `defaultModuleRules`), `compatibility`
  `{ date: "2026-10-01", flags: ["nodejs_compat"] }` (wrangler parity),
  `assets` = absolute `web/dist` with `runWorkerFirst: true` (REQUIRED;
  worker-first auth/CSP; API/UI/metadata never fall through; SPA fallback
  in `src/http.ts` via `ASSETS`), `notFoundHandling: "none"` (wrangler
  parity), `env` = canonical literals + `Config.Redacted` secrets +
  resources (below), exact HTTPS custom `domain` on EVERY stage
  (stage-specific `AST_CORE_ORIGIN` hostname; Wrangler remains local dev),
  `workersDev: false` (no invented workers.dev preview URLs).
- R2 `ast-core-config-<stage>` (`CONFIG_BUCKET` binding).
- Hyperdrive `ast-core-db-<stage>` (`HYPERDRIVE` binding) with
  `caching: { disabled: true }` EXPLICIT. Origin comes from secret
  `AST_CORE_DATABASE_URL` (external Postgres; no hosting provisioned).
- Env (persisted schema, canonical literals): `CORE_ENV=production`,
  `CORE_PUBLIC_BASE_URL=<canonical coreOrigin>`,
  `CORE_JWT_ISSUER=<canonical coreOrigin>` (same literal, so issuer
  matches Relay's normalized issuer even for uppercase/trailing-slash
  inputs), `CORE_SPA_APPROVE_PATH=/#/approve`,
  `CORE_RELAY_ORIGIN=<canonical relayOrigin>`,
  `MAIL_PROVIDER=resend`, `MAIL_FROM=<resolved literal>`, plus secrets
  `CORE_MASTER_KEY`, `CORE_ADMIN_TOKEN`, `RESEND_API_KEY` via
  `Config.Redacted` ONLY (no `Config.String` bindings remain; bind as
  `secret_text`). No generated/rotated keys. Single declaration:
  bucket/hyperdrive yielded once in `alchemy.run.ts` and passed to
  `makeCoreWorker({ bucket, hyperdrive })` (Worker never re-yields them).
- Stack `ast-core` (Relay uses its own stack), stage from CLI,
  state `Cloudflare.state()` (account default `alchemy-state-store`,
  Cloudflare-backed remote). No sibling source imports.

Shared public inputs (both repos, same names):
`AST_CORE_ORIGIN`, `AST_RELAY_ORIGIN`. Exact https bare origins for ALL
deployed stages (no path/query, no wildcard, no credentials; https
required even for preview — every stage attaches a custom domain).
`Core != Relay` by HOSTNAME (ports do not separate ownership; separate
Workers cannot share one custom-domain owner — the second attach would
move ownership). Stage-specific values: never reuse prod domains for
preview/dev stages; never demonstrate prod and preview with the same
`.env` domains.

## Reproducible flow (no global install)

Bare `alchemy` is NOT installed by `npm ci`. From `infra/` use the
project-local binary via npm scripts or `npx --no-install`:

```sh
cd /home/sander/projects/artisanstreet/core/infra
npm ci
npm run check                 # typecheck + tests (offline, no creds)
npm run verify:bundle         # deploy-exact prebuilt collector + import execution (offline)
```

Root convenience wrappers (if any) MUST keep a trailing `--` in the
script definition so stage flags forward through nested npm:

```json
// root package.json (illustrative; owned by root, not this repo)
{ "scripts": { "infra:deploy": "npm --prefix infra run deploy --" } }
```

```sh
# then this forwards --stage correctly (verified via --help, no cloud):
npm run infra:deploy -- --stage prod
# without the trailing `--` in the definition, npm swallows --stage and
# the wrong default stage (live_$USER) would deploy — never rely on that.
```

Benign forwarding check used here (no state bootstrap, help only):

```sh
npm run deploy -- --help
npx --no-install alchemy --help
npm --prefix infra run deploy -- --help   # from core root
```

`verify:bundle` runs deploy's exact collector
(`@alchemy.run/cloudflare/lib/Workers/Sources/Prebuilt.js`
`readPrebuiltWorkerBundle`, needs only `FileSystem+Path` via
`@effect/platform-node/NodeServices.layer`) and dynamic-imports
`dist/ast_core/index.js` to assert `default.fetch` + `default.scheduled`
are functions (not substring matching). For `bundle: true` Workers the
offline equivalent is `…/Sources/Rolldown.js` `WorkerBundle`
(`Effect.gen` → `{ build, watch }`, options
`{ id, main, compatibility: { date, flags }, entry: { kind: "external" }, stack: { name, stage }, extraOptions: undefined }`,
same `NodeServices.layer`). Relay can reuse this pattern via root —
no separate esbuild approximation, no cloud state.

Plan/deploy (need real Cloudflare + Postgres + secrets; DO NOT run
without them — first `plan`/`dev` bootstraps account state, see below):

```sh
# prod (example; use stage-specific env files, never share domains)
AST_CORE_ORIGIN=https://core.artisanstreet.dev \
AST_RELAY_ORIGIN=https://relay.artisanstreet.dev \
AST_CORE_DATABASE_URL='postgres://…' \
CORE_MASTER_KEY='…' CORE_ADMIN_TOKEN='…' RESEND_API_KEY='…' MAIL_FROM='Ast <…>' \
npm run deploy -- --stage prod --profile default

# preview (different origins; same .env domains would move ownership)
AST_CORE_ORIGIN=https://core-pr-42.example.dev \
AST_RELAY_ORIGIN=https://relay-pr-42.example.dev \
… npm run deploy -- --stage pr-42

# preview what would change (same bootstrap caveat as deploy)
npm run plan -- --stage prod
# or: npx --no-install alchemy deploy --dry-run --config alchemy.run.ts --stage prod
```

Build the artifacts first (core root, service toolchain unchanged):

```sh
cd /home/sander/projects/artisanstreet/core
npm ci && npm run build          # dist/ast_core/index.js + web/dist
```

## Auth / bootstrap / migration (accurate)

- Auth: `alchemy profile edit --add Cloudflare` (OAuth or API token,
  saved to `~/.alchemy/profiles.json`, default profile). No
  `wrangler login` needed. CI uses `CLOUDFLARE_ACCOUNT_ID` +
  `CLOUDFLARE_API_TOKEN` (or key+email). See `…/cloudflare/setup`.
- State: `Cloudflare.state()` (recommended for CF-only infra). First
  `plan`/`dev`/`deploy` against an account with no store deploys the
  store Worker once (`alchemy-state-store` + Secrets Store entries;
  reused across stacks/stages). In CI (`CI=true`) a missing store fails
  instead — pre-provision with
  `alchemy state bootstrap --backend cloudflare --profile <name>`.
  See `https://alchemy.run/state-store`. NEVER run `plan`/`dev`/`deploy`
  here for “verification” — they mutate/ensure cloud state.
- Migration from wrangler: wrangler template used `ast-core` /
  `ast-core-config` / hyperdrive id placeholder. Alchemy stages qualify
  names (`ast-core-prod`, …). Either adopt existing resources
  (`--adopt`, see `…/cli/adopting-resources`) or let Alchemy create
  stage-qualified ones and cut over DNS. Alchemy is authoritative for
  prod; `wrangler.jsonc` remains for local/test only (see
  `docs/deployment.md`). Generated `dist/ast_core/wrangler.json`
  (`no_bundle:true`) is non-authoritative and ignored for modules
  (`.json` not in `defaultModuleRules`).
- Secrets: operator-supplied only (`Config.Redacted`), never logged,
  never in outputs, never generated per-deploy. `CI=true` missing-store
  fails (no silent bootstrap).

## External prerequisites (genuine, not verified here)

Cloudflare account + zone for the prod hostname, external Postgres
14+ reachable for Hyperdrive (direct URL in `AST_CORE_DATABASE_URL`),
Resend sender/key, 32-byte base64url `CORE_MASTER_KEY`,
`CORE_ADMIN_TOKEN`, `MAIL_FROM`. No deploys were performed from this
repo; do not claim otherwise.
