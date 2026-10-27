import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Path from "node:path";
import { fileURLToPath as file_url_to_path } from "node:url";
import { CORE_ENV_VALUE, CORE_SPA_APPROVE_PATH_VALUE, MAIL_PROVIDER_VALUE, MAIL_SENDER_EMAIL, MAIL_SENDER_NAME, WORKER_COMPATIBILITY_DATE, WORKER_COMPATIBILITY_FLAGS, WORKER_PREBUILT_ENTRY, WEB_DIST_DIR, assert_distinct_origins, assert_origin_for_stage, assert_valid_mail_from, hostname_from_origin, normalize_origin, worker_name } from "./config.ts";
import type { ConfigBucket } from "./storage.ts";
import type { CoreHyperdrive } from "./hyperdrive.ts";
import { config as deploy_config } from "./env.generated.ts";

type BucketHandle = Effect.Success<typeof ConfigBucket>;
type HyperdriveHandle = Effect.Success<typeof CoreHyperdrive>;
type EmailHandle = Effect.Success<ReturnType<typeof Cloudflare.Email.SendEmail>>;

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
  readonly mail_from_name: string;
  /** Loaded Redacted secrets. Bound as secret_text (never plain strings). */
  readonly master_key: Redacted.Redacted<string>;
  readonly admin_token: Redacted.Redacted<string>;
  readonly email: EmailHandle;
  readonly bucket: BucketHandle;
  readonly hyperdrive: HyperdriveHandle;
}

// REAL props factory used by the deployed Worker AND tests (no mirrors).
// Public origins are canonical literals so deploy-time and runtime agree
// (raw Config values with trailing slash/uppercase would otherwise diverge
// CORE_JWT_ISSUER from Relay's normalized issuer). Secrets arrive as loaded
// Redacted values and bind as secret_text.
export function build_core_worker_props(input: CoreWorkerPropsInput) {
  if (assert_valid_mail_from(input.mail_from) !== MAIL_SENDER_EMAIL.toLowerCase()) {
    throw new Error("MAIL_FROM must be the verified Cloudflare sender");
  }
  if (!input.mail_from_name.trim()) {
    throw new Error("MAIL_FROM_NAME is required");
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
      MAIL_FROM_NAME: input.mail_from_name,
      CORE_MASTER_KEY: input.master_key,
      CORE_ADMIN_TOKEN: input.admin_token,
      EMAIL: input.email,
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
export const make_core_worker = (deps: { bucket: BucketHandle; hyperdrive: HyperdriveHandle }) => {
  const program = Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;

    const deploy_env = yield* deploy_config;
    const core_origin_raw = deploy_env.AST_CORE_ORIGIN;
    const relay_origin_raw = deploy_env.AST_RELAY_ORIGIN;
    // MAIL_FROM is REQUIRED: it must be a verified Cloudflare sender on the
    // onboarded sending subdomain. No example.invalid fallback — silently
    // deploying broken auth email is worse than failing fast here.
    const mail_from_raw = deploy_env.MAIL_FROM;
    const mail_from_name_opt = deploy_env.MAIL_FROM_NAME;
    const mail_from_name_trimmed = (Option.getOrUndefined(mail_from_name_opt) ?? "").trim();
    const mail_from_name_raw = mail_from_name_trimmed ? mail_from_name_trimmed : MAIL_SENDER_NAME;
    const core_origin = normalize_origin(core_origin_raw, "AST_CORE_ORIGIN");
    const relay_origin = normalize_origin(relay_origin_raw, "AST_RELAY_ORIGIN");
    assert_origin_for_stage(core_origin, "AST_CORE_ORIGIN", stage);
    assert_origin_for_stage(relay_origin, "AST_RELAY_ORIGIN", stage);
    assert_distinct_origins(core_origin, relay_origin);

    const email = yield* Cloudflare.Email.SendEmail("EMAIL", {
      allowedSenderAddresses: [MAIL_SENDER_EMAIL],
    });
    const props = build_core_worker_props({
      stage,
      core_origin,
      relay_origin,
      mail_from: mail_from_raw,
      mail_from_name: mail_from_name_raw,
      master_key: deploy_env.CORE_MASTER_KEY,
      admin_token: deploy_env.CORE_ADMIN_TOKEN,
      email,
      bucket: deps.bucket,
      hyperdrive: deps.hyperdrive });
    return yield* Cloudflare.Worker("CoreWorker", props);
  });
  return program;
};
