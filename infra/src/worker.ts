import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Path from "node:path";
import { fileURLToPath as file_url_to_path } from "node:url";
import { CORE_ENV_VALUE, CORE_SPA_APPROVE_PATH_VALUE, MAIL_PROVIDER_VALUE, WORKER_COMPATIBILITY_DATE, WORKER_COMPATIBILITY_FLAGS, WORKER_PREBUILT_ENTRY, WEB_DIST_DIR, assert_distinct_origins, assert_origin_for_stage, hostname_from_origin, normalize_origin, worker_name } from "./config.ts";
import type { ConfigBucket } from "./storage.ts";
import type { CoreHyperdrive } from "./hyperdrive.ts";

type BucketHandle = Effect.Success<typeof ConfigBucket>;
type HyperdriveHandle = Effect.Success<typeof CoreHyperdrive>;

// Absolute artifact paths (cwd-independent). Canonical CLI cwd is the core
// repo root (`--config infra/alchemy.run.ts`); absolute paths keep
// `npm run deploy` (cwd=infra) and core-root invocations identical, and
// Alchemy stores them as portable relative paths when inside cwd.
const CORE_ROOT = Path.resolve(Path.dirname(file_url_to_path(import.meta.url)), "../..");
export const WORKER_ENTRY_ABS = Path.join(CORE_ROOT, WORKER_PREBUILT_ENTRY);
export const WEB_DIST_ABS = Path.join(CORE_ROOT, WEB_DIST_DIR);

export interface CoreWorkerPropsInput {
  readonly stage: string;
  /** Canonical normalized origins (already validated). Bound as literals. */
  readonly core_origin: string;
  readonly relay_origin: string;
  readonly mail_from: string;
  readonly bucket: BucketHandle;
  readonly hyperdrive: HyperdriveHandle;
}

// REAL props factory used by the deployed Worker AND tests (no mirrors).
// Public origins are canonical literals so deploy-time and runtime agree
// (raw Config values with trailing slash/uppercase would otherwise diverge
// CORE_JWT_ISSUER from Relay's normalized issuer). Only secrets stay as
// Config.Redacted (bind as secret_text).
export function build_core_worker_props(input: CoreWorkerPropsInput) {
  if (!input.mail_from.trim()) {
    throw new Error("MAIL_FROM is required (verified Resend sender; no default)");
  }
  const domain_host = hostname_from_origin(input.core_origin);
  return {
    name: worker_name(input.stage),
    // Prebuilt ESM from `npm run build` (core root). No re-bundling:
    // Reylo .sql transforms are already compiled in.
    main: WORKER_ENTRY_ABS,
    bundle: false as const,
    compatibility: {
      date: WORKER_COMPATIBILITY_DATE,
      flags: [...WORKER_COMPATIBILITY_FLAGS] as ["nodejs_compat"] },
    assets: {
      directory: WEB_DIST_ABS,
      runWorkerFirst: true as const,
      notFoundHandling: "none" as const },
    env: {
      CORE_ENV: CORE_ENV_VALUE,
      CORE_PUBLIC_BASE_URL: input.core_origin,
      CORE_JWT_ISSUER: input.core_origin,
      CORE_SPA_APPROVE_PATH: CORE_SPA_APPROVE_PATH_VALUE,
      CORE_RELAY_ORIGIN: input.relay_origin,
      MAIL_PROVIDER: MAIL_PROVIDER_VALUE,
      MAIL_FROM: input.mail_from,
      CORE_MASTER_KEY: Config.Redacted("CORE_MASTER_KEY"),
      CORE_ADMIN_TOKEN: Config.Redacted("CORE_ADMIN_TOKEN"),
      RESEND_API_KEY: Config.Redacted("RESEND_API_KEY"),
      CONFIG_BUCKET: input.bucket,
      HYPERDRIVE: input.hyperdrive },
    // Exact HTTPS custom domain for EVERY deployed stage (stage-specific
    // AST_CORE_ORIGIN). A supplied origin that is never attached is an
    // unusable stage (issuer/redirects point nowhere). Wrangler remains
    // the local-dev path; no invented workers.dev preview URLs.
    domain: domain_host,
    workersDev: false as const };
}

// Async/plain-module Worker (Alchemy v2 async Workers: main + env).
// Handles are passed in from the composition root (single declaration);
// this factory never re-yields ConfigBucket/CoreHyperdrive.
export const make_core_worker = (deps: { bucket: BucketHandle; hyperdrive: HyperdriveHandle }) =>
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;

    const core_origin_raw = yield* Config.String("AST_CORE_ORIGIN");
    const relay_origin_raw = yield* Config.String("AST_RELAY_ORIGIN");
    // MAIL_FROM is REQUIRED: it must be a verified Resend sender. No
    // example.invalid fallback — silently deploying broken auth email is
    // worse than failing fast here.
    const mail_from_raw = yield* Config.String("MAIL_FROM");
    if (!mail_from_raw.trim()) {
      throw new Error("MAIL_FROM is required (verified Resend sender; no default)");
    }
    const core_origin = normalize_origin(core_origin_raw, "AST_CORE_ORIGIN");
    const relay_origin = normalize_origin(relay_origin_raw, "AST_RELAY_ORIGIN");
    assert_origin_for_stage(core_origin, "AST_CORE_ORIGIN", stage);
    assert_origin_for_stage(relay_origin, "AST_RELAY_ORIGIN", stage);
    assert_distinct_origins(core_origin, relay_origin);

    const props = build_core_worker_props({
      stage,
      core_origin,
      relay_origin,
      mail_from: mail_from_raw,
      bucket: deps.bucket,
      hyperdrive: deps.hyperdrive });
    return yield* Cloudflare.Worker("CoreWorker", props);
  });
