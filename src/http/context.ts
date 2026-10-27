import { Effect, Layer } from "effect";
import type { Db, R2Like } from "../db.ts";
import type { AppEnv } from "../db.ts";
import { config_from_env } from "../services/deps.ts";
import { AppConfigTag, DbTag, TxTag, type TxRunner } from "../services/deps.ts";
import { MailTag, MailLive, mail_cloudflare_live, type Mail, type SendEmailBinding } from "../services/mail.ts";
import { internal } from "../errors.ts";
import { FetchHttpClient } from "@effect/platform";
import { StorageTag } from "../services/storage.ts";
import { AssetsTag } from "./assets.ts";
import { KeyCacheLive, type KeyCacheTag } from "../services/grants.ts";

export interface RequestContext {
  readonly db: Db;
  readonly env: AppEnv;
  readonly mailer: "log" | "resend" | "cloudflare";
  readonly resend_api_key?: string;
  readonly send_email?: SendEmailBinding;
  readonly r2: R2Like;
  readonly tx_runner: TxRunner;
  readonly mail_sink?: (m: { to: string; subject: string; text: string; confirm_url: string }) => void;
  readonly assets?: { fetch(request: Request): Promise<Response> };
  readonly now?: () => number;
}

export type ServiceEnv = DbTag | AppConfigTag | MailTag | StorageTag | TxTag | AssetsTag | KeyCacheTag;

export function make_service_layers(ctx: RequestContext): Layer.Layer<ServiceEnv, never, never> {
  const combined_vars: Record<string, string | undefined> = {
    ...ctx.env.vars,
    ...(ctx.env.admin_token && !ctx.env.vars.CORE_ADMIN_TOKEN ? { CORE_ADMIN_TOKEN: ctx.env.admin_token } : {}),
    ...(ctx.resend_api_key && !ctx.env.vars.RESEND_API_KEY ? { RESEND_API_KEY: ctx.resend_api_key } : {}) };
  const cfg = config_from_env(combined_vars, ctx.now);
  const db_layer = Layer.succeed(DbTag, { db: ctx.db });
  const config_layer = Layer.succeed(AppConfigTag, cfg);
  const tx_layer = Layer.succeed(TxTag, ctx.tx_runner);
  const storage_layer = Layer.succeed(StorageTag, { r2: ctx.r2 });
  const assets_layer = Layer.succeed(AssetsTag, {
    fetch: ctx.assets ? (r: Request) => ctx.assets!.fetch(r) : (_r: Request) => Promise.resolve(new Response("not found", { status: 404 })) });
  const key_cache_layer = KeyCacheLive;
  if (ctx.mail_sink) {
    const sink = ctx.mail_sink;
    const mem_layer = Layer.succeed(MailTag, {
      send: (m: Mail) => Effect.sync(() => void sink(m)) });
    return Layer.mergeAll(db_layer, config_layer, tx_layer, storage_layer, assets_layer, mem_layer, key_cache_layer);
  }
  if (cfg.mailer === "cloudflare") {
    if (!ctx.send_email) {
      const missing_binding = Layer.succeed(MailTag, {
        send: (_m: Mail) => Effect.fail(internal("mail delivery failed")) });
      return Layer.mergeAll(db_layer, config_layer, tx_layer, storage_layer, assets_layer, missing_binding, key_cache_layer);
    }
    const native = ctx.send_email;
    const mail_layer = mail_cloudflare_live(native).pipe(Layer.provide(config_layer));
    return Layer.mergeAll(db_layer, config_layer, tx_layer, storage_layer, assets_layer, mail_layer, key_cache_layer);
  }
  const http_layer = FetchHttpClient.layer;
  const mail_layer = MailLive.pipe(Layer.provide(Layer.mergeAll(config_layer, http_layer)));
  return Layer.mergeAll(db_layer, config_layer, tx_layer, storage_layer, assets_layer, mail_layer, key_cache_layer);
}
