import { Cause, Effect, Layer } from "effect";
import postgres from "postgres";
import { create_app, type RequestContext } from "./http.ts";
import type { Db, R2Like } from "./db.ts";
import { prepare_db, type UnsafeLike } from "./db/prepared.ts";
import { config_from_env, DbTag } from "./services/deps.ts";
import { CoreError, internal } from "./errors.ts";
import { make_service_layers } from "./http/context.ts";
import { http_effect } from "./http/app.ts";
import { with_scoped_db } from "./db/lifecycle.ts";

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

function string_vars(env: WorkerEnv): Record<string, string | undefined> {
  const pick = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    CORE_ENV: pick(env.CORE_ENV),
    CORE_PUBLIC_BASE_URL: pick(env.CORE_PUBLIC_BASE_URL),
    CORE_JWT_ISSUER: pick(env.CORE_JWT_ISSUER),
    CORE_MASTER_KEY: pick(env.CORE_MASTER_KEY),
    MAIL_PROVIDER: pick(env.MAIL_PROVIDER),
    MAIL_FROM: pick(env.MAIL_FROM),
    CORE_SPA_APPROVE_PATH: pick(env.CORE_SPA_APPROVE_PATH),
    CORE_RELAY_ORIGIN: pick(env.CORE_RELAY_ORIGIN) };
}

function r2_adapter(bucket: NonNullable<WorkerEnv["CONFIG_BUCKET"]>): R2Like {
  return {
    put: (key: string, body: Uint8Array | string) => bucket.put(key, body).then(() => undefined),
    get: (key: string) =>
      bucket.get(key).then((o) => (o ? o.arrayBuffer().then((b) => new Uint8Array(b)) : null)) };
}

function memory_r2(): R2Like {
  const store = new Map<string, Uint8Array>();
  return {
    put: (key: string, body: Uint8Array | string) =>
      Promise.resolve(
        void store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body),
      ),
    get: (key: string) => Promise.resolve(store.get(key) ?? null) };
}

function open_db(env: WorkerEnv) {
  const cs = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!cs) throw new Error("no database: bind HYPERDRIVE or set DATABASE_URL");
  return postgres(cs, { max: 5, fetch_types: false, prepare: true });
}

function request_layers_from_client(
  env: WorkerEnv,
  client: ReturnType<typeof open_db>,
): ReturnType<typeof make_service_layers> {
  const db = prepare_db(client);
  const bucket = env.CONFIG_BUCKET;
  const vars = string_vars(env);
  if (!bucket && (vars.CORE_ENV ?? "dev").toLowerCase() === "production") {
    throw new Error("CONFIG_BUCKET is required in production");
  }
  // Driver-boundary Promise bridge: postgres.js begin() takes a callback.
  // Uninterruptible so aborts wait for commit/rollback instead of closing
  // the client mid-transaction; typed failures roll back and rethrow.
  const tx_runner: RequestContext["tx_runner"] = {
    transaction: <A, E>(effect: Effect.Effect<A, E, DbTag>): Effect.Effect<A, E | CoreError> =>
      Effect.uninterruptible(
        Effect.tryPromise({
          try: () =>
            (client as unknown as { begin: (f: (tx: unknown) => Promise<A>) => Promise<A> }).begin(async (tx) => {
              const exit = await Effect.runPromiseExit(
                Effect.provide(effect, Layer.succeed(DbTag, { db: prepare_db(tx as unknown as UnsafeLike) })),
              );
              if (exit._tag === "Success") return exit.value;
              const failure = Cause.failureOption(exit.cause);
              if (failure._tag === "Some") throw failure.value;
              throw internal("database unavailable", { cause: exit.cause });
            }),
          catch: (cause) => (cause instanceof CoreError ? cause : internal("database unavailable", { cause })) }),
      ) };
  const ctx: RequestContext = {
    db,
    env: { vars, hyperdrive_connection_string: env.HYPERDRIVE?.connectionString, admin_token: env.CORE_ADMIN_TOKEN },
    mailer: (vars.MAIL_PROVIDER ?? "log") === "resend" ? "resend" : "log",
    resend_api_key: env.RESEND_API_KEY,
    r2: bucket ? r2_adapter(bucket) : memory_r2(),
    assets: env.ASSETS,
    tx_runner: tx_runner };
  return make_service_layers(ctx);
}

export const with_request_scope = <R, E, A>(
  env: WorkerEnv,
  use: (layers: ReturnType<typeof make_service_layers>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  with_scoped_db(
    Effect.sync(() => open_db(env)),
    (client) => use(request_layers_from_client(env, client)),
    (client) => Effect.promise(() => client.end()),
  );

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    void ctx;
    return Effect.runPromise(
      Effect.scoped(with_request_scope(env, (layers) => http_effect(request, layers))),
    );
  },
  async scheduled(_event: unknown, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const { janitor } = await import("./services/janitor.ts");
    const program = with_scoped_db(
      Effect.sync(() => open_db(env)),
      (client) => {
        const db = prepare_db(client);
        const cfg = config_from_env(string_vars(env));
        return janitor(cfg.now()).pipe(Effect.provide(Layer.succeed(DbTag, { db })));
      },
      (client) => Effect.promise(() => client.end()),
    );
    const task = Effect.runPromise(program as Effect.Effect<unknown>);
    ctx.waitUntil(task);
    await task;
  } };

export { create_app };
