/// <reference types="@cloudflare/workers-types" />
import { Context, Effect, Layer, Match, Schedule } from "effect";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import * as HttpBody from "@effect/platform/HttpBody";
import { FetchHttpClient } from "@effect/platform";
import { internal, type CoreError } from "../errors.ts";
import type { AppConfig } from "./deps.ts";
import { AppConfigTag } from "./deps.ts";

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly confirm_url: string;
}

export class MailTag extends Context.Tag("Mail")<MailTag, { readonly send: (m: Mail) => Effect.Effect<void, CoreError> }>() {}

export type SendEmailBinding = Pick<SendEmail, "send">;

const resend_retry_schedule = Schedule.exponential("200 millis").pipe(Schedule.compose(Schedule.recurs(2)));

const send_with_client = (
  cfg: AppConfig,
  client: HttpClient.HttpClient,
  m: Mail,
) => {
  const program = Effect.gen(function* () {
    if (cfg.mailer === "log") {
      return yield* Effect.sync(() => {
        console.log(`[ast-core mail] to=${m.to} subject=${m.subject} confirm=${m.confirm_url}`);
      });
    }
    if (cfg.mailer === "cloudflare") {
      return yield* Effect.fail(internal("mail delivery failed"));
    }
    if (!cfg.resend_api_key) return yield* Effect.fail(internal("mail delivery failed"));
    const from = cfg.env.MAIL_FROM ?? "Ast <noreply@example.invalid>";
    const req = HttpClientRequest.post("https://api.resend.com/emails").pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${cfg.resend_api_key}`),
      HttpClientRequest.setBody(HttpBody.unsafeJson({ from, to: [m.to], subject: m.subject, text: m.text })),
    );
    const execute_resend = Effect.gen(function* () {
      const r = yield* client.execute(req).pipe(Effect.mapError(() => internal("mail delivery failed")));
      if (r.status === 429 || r.status >= 500) {
        return yield* Effect.fail(internal("mail delivery failed"));
      }
      return r;
    });
    const res = yield* execute_resend.pipe(
      Effect.retry(resend_retry_schedule),
    );
    if (res.status !== 200 && res.status !== 202) {
      return yield* Effect.fail(internal("mail delivery failed"));
    }
  });
  return program;
};

const send_with_native = (
  cfg: AppConfig,
  native: SendEmailBinding,
  m: Mail,
) => {
  const program = Effect.gen(function* () {
    const from = (cfg.env.MAIL_FROM ?? "").trim();
    if (!from) return yield* Effect.fail(internal("mail delivery failed"));
    yield* Effect.tryPromise({
      try: () => native.send({ from, to: m.to, subject: m.subject, text: m.text }),
      catch: (cause) => internal("mail delivery failed", { cause }),
    });
  });
  return program;
};

const mail_live_effect = Effect.gen(function* () {
  const cfg: AppConfig = yield* AppConfigTag;
  const client = yield* HttpClient.HttpClient;
  const kind = Match.value(cfg.mailer).pipe(
    Match.when("cloudflare", () => "cloudflare" as const),
    Match.when("resend", () => "resend" as const),
    Match.orElse(() => "log" as const),
  );
  if (kind === "cloudflare") {
    return { send: (_m: Mail) => Effect.fail(internal("mail delivery failed")) };
  }
  return { send: (m: Mail) => send_with_client(cfg, client, m) };
});

export const MailLive = Layer.effect(
  MailTag,
  mail_live_effect,
);

export const mail_cloudflare_live = (native: SendEmailBinding) => {
  const program = Effect.gen(function* () {
    const cfg: AppConfig = yield* AppConfigTag;
    if (cfg.mailer !== "cloudflare") {
      return { send: (_m: Mail) => Effect.fail(internal("mail delivery failed")) };
    }
    if (!cfg.env.MAIL_FROM || !cfg.env.MAIL_FROM.trim()) {
      return { send: (_m: Mail) => Effect.fail(internal("mail delivery failed")) };
    }
    return { send: (m: Mail) => send_with_native(cfg, native, m) };
  });
  return Layer.effect(MailTag, program);
};

export function memory_mail_box() {
  const out: Mail[] = [];
  const layer = Layer.succeed(MailTag, {
    send: (m: Mail) => Effect.sync(() => void out.push(m)) });
  return { out, layer };
}

export const MailFetchLive = FetchHttpClient.layer.pipe(Layer.provideMerge(MailLive));
