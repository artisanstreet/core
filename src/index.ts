import { Effect, Layer } from "effect";
import postgres from "postgres";
import { createApp, type RequestContext } from "./http.js";
import type { Db, R2Like } from "./db.js";
import { prepareDb, type UnsafeLike } from "./db/prepared.js";

// Cloudflare Worker entry. Local dev (vite dev / wrangler dev) reads
// .dev.vars; production uses Hyperdrive + R2 bindings + secrets.
interface WorkerEnv {
  readonly HYPERDRIVE?: { readonly connectionString: string };
  readonly CONFIG_BUCKET?: {
    put(key: string, body: Uint8Array | string): Promise<unknown>;
    get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  };
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
  readonly DATABASE_URL?: string;
  readonly RESEND_API_KEY?: string;
  readonly CORE_ADMIN_TOKEN?: string;
  readonly [k: string]: unknown;
}

function stringVars(env: WorkerEnv): Record<string, string | undefined> {
  const pick = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    CORE_ENV: pick(env.CORE_ENV),
    CORE_PUBLIC_BASE_URL: pick(env.CORE_PUBLIC_BASE_URL),
    CORE_JWT_ISSUER: pick(env.CORE_JWT_ISSUER),
    CORE_MASTER_KEY: pick(env.CORE_MASTER_KEY),
    MAIL_PROVIDER: pick(env.MAIL_PROVIDER),
    MAIL_FROM: pick(env.MAIL_FROM),
    CORE_SPA_APPROVE_PATH: pick(env.CORE_SPA_APPROVE_PATH),
    CORE_RELAY_ORIGIN: pick(env.CORE_RELAY_ORIGIN),
  };
}

function r2Adapter(bucket: NonNullable<WorkerEnv["CONFIG_BUCKET"]>): R2Like {
  return {
    put: (key: string, body: Uint8Array | string) => bucket.put(key, body).then(() => undefined),
    get: (key: string) =>
      bucket.get(key).then((o) => (o ? o.arrayBuffer().then((b) => new Uint8Array(b)) : null)),
  };
}

function memoryR2(): R2Like {
  const store = new Map<string, Uint8Array>();
  return {
    put: (key: string, body: Uint8Array | string) =>
      Promise.resolve(
        void store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body),
      ),
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
  };
}

/**
 * Per-request database client. Cloudflare forbids reusing I/O handles
 * across requests (the old global `postgres()` cache caused alternating
 * query failures in production): every handler builds its own client and
 * Hyperdrive owns the pooling. Options follow the official postgres.js
 * example (max 5, no type fetching, prepared statements). The client is
 * closed via waitUntil/after the request (and the scheduled task finally),
 * never cached globally.
 */
function openDb(env: WorkerEnv) {
  const cs = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!cs) throw new Error("no database: bind HYPERDRIVE or set DATABASE_URL");
  return postgres(cs, { max: 5, fetch_types: false, prepare: true });
}

function getContext(env: WorkerEnv): { ctx: RequestContext; done: () => Promise<unknown> } {
  const client = openDb(env);
  const db = prepareDb(client);
  const bucket = env.CONFIG_BUCKET;
  const ctx: RequestContext = {
    db,
    env: { vars: stringVars(env), hyperdriveConnectionString: env.HYPERDRIVE?.connectionString, adminToken: env.CORE_ADMIN_TOKEN },
    mailer: (stringVars(env).MAIL_PROVIDER ?? "log") === "resend" ? "resend" : "log",
    resendApiKey: env.RESEND_API_KEY,
    r2: bucket ? r2Adapter(bucket) : memoryR2(),
    assets: env.ASSETS,
    txRunner: ((fn: (db: Db) => Promise<unknown>) =>
      (client as unknown as { begin: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin((tx) =>
        fn(prepareDb(tx as unknown as UnsafeLike)),
      )) as RequestContext["txRunner"],
  };
  return { ctx, done: () => client.end() };
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const { ctx: rc, done } = getContext(env);
    try {
      const app = createApp(rc);
      return await app.fetch(request);
    } finally {
      ctx.waitUntil(done());
    }
  },
  async scheduled(_event: unknown, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const { janitor } = await import("./services/janitor.js");
    const { configFromEnv, AppConfigTag, DbTag } = await import("./services/deps.js");
    const { ctx: rc, done } = getContext(env);
    const cfg = configFromEnv(rc.env.vars);
    const program = Effect.provide(
      janitor(cfg.now()),
      Layer.mergeAll(Layer.succeed(DbTag, { db: rc.db }), Layer.succeed(AppConfigTag, cfg)),
    );
    try {
      ctx.waitUntil(Effect.runPromise(program as Effect.Effect<unknown>));
    } finally {
      await done();
    }
  },
};
