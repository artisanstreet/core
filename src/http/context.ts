import { Effect, Layer } from "effect";
import type { Db, R2Like } from "../db.ts";
import type { AppEnv } from "../db.ts";
import { configFromEnv } from "../services/deps.ts";
import { AppConfigTag, DbTag, TxTag, type TxRunner } from "../services/deps.ts";
import { MailTag, MailLive, type Mail } from "../services/mail.ts";
import { FetchHttpClient } from "@effect/platform";
import { StorageTag } from "../services/storage.ts";
import { AssetsTag } from "./assets.ts";
import { KeyCacheLive, type KeyCacheTag } from "../services/grants.ts";

export interface RequestContext {
  readonly db: Db;
  readonly env: AppEnv;
  readonly mailer: "log" | "resend";
  readonly resendApiKey?: string;
  readonly r2: R2Like;
  readonly txRunner: TxRunner;
  readonly mailSink?: (m: { to: string; subject: string; text: string; confirmUrl: string }) => void;
  readonly assets?: { fetch(request: Request): Promise<Response> };
  readonly now?: () => number;
}

export type ServiceEnv = DbTag | AppConfigTag | MailTag | StorageTag | TxTag | AssetsTag | KeyCacheTag;

export function make_service_layers(ctx: RequestContext): Layer.Layer<ServiceEnv, never, never> {
  const combined_vars: Record<string, string | undefined> = {
    ...ctx.env.vars,
    ...(ctx.env.adminToken && !ctx.env.vars.CORE_ADMIN_TOKEN ? { CORE_ADMIN_TOKEN: ctx.env.adminToken } : {}),
    ...(ctx.resendApiKey && !ctx.env.vars.RESEND_API_KEY ? { RESEND_API_KEY: ctx.resendApiKey } : {}),
  };
  const cfg = configFromEnv(combined_vars, ctx.now);
  const db_layer = Layer.succeed(DbTag, { db: ctx.db });
  const config_layer = Layer.succeed(AppConfigTag, cfg);
  const tx_layer = Layer.succeed(TxTag, ctx.txRunner);
  const storage_layer = Layer.succeed(StorageTag, { r2: ctx.r2 });
  const assets_layer = Layer.succeed(AssetsTag, {
    fetch: ctx.assets ? (r: Request) => ctx.assets!.fetch(r) : (_r: Request) => Promise.resolve(new Response("not found", { status: 404 })),
  });
  const key_cache_layer = KeyCacheLive;
  if (ctx.mailSink) {
    const sink = ctx.mailSink;
    const mem_layer = Layer.succeed(MailTag, {
      send: (m: Mail) => Effect.sync(() => void sink(m)),
    });
    return Layer.mergeAll(db_layer, config_layer, tx_layer, storage_layer, assets_layer, mem_layer, key_cache_layer);
  }
  const http_layer = FetchHttpClient.layer;
  const mail_layer = MailLive.pipe(Layer.provide(Layer.mergeAll(config_layer, http_layer)));
  return Layer.mergeAll(db_layer, config_layer, tx_layer, storage_layer, assets_layer, mail_layer, key_cache_layer);
}
