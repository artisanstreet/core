import { describe, expect, it, vi, afterEach } from "vitest";
import { Cause, Effect, Layer } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { AppConfigTag, config_from_env } from "../../src/services/deps.ts";
import { MailLive, MailTag, mail_cloudflare_live, type SendEmailBinding } from "../../src/services/mail.ts";
import { make_service_layers } from "../../src/http/context.ts";
import { load_master_key } from "../../src/crypto.ts";
import { CoreError } from "../../src/errors.ts";

const MASTER_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";

function test_config() {
  return {
    env: {
      CORE_ENV: "test",
      CORE_PUBLIC_BASE_URL: "http://test.invalid",
      CORE_JWT_ISSUER: "http://test.invalid",
      CORE_MASTER_KEY: MASTER_KEY,
      MAIL_PROVIDER: "resend",
      MAIL_FROM: "Ast <noreply@example.invalid>",
      RESEND_API_KEY: "test-key" } as Record<string, string | undefined>,
    core_env: "test",
    public_base_url: "http://test.invalid",
    jwt_issuer: "http://test.invalid",
    master_key: load_master_key({ CORE_MASTER_KEY: MASTER_KEY, CORE_ENV: "test" }),
    mailer: "resend" as const,
    resend_api_key: "test-key",
    now: Date.now };
}

function mail_layers() {
  const config_layer = Layer.succeed(AppConfigTag, test_config());
  const http_layer = FetchHttpClient.layer;
  return MailLive.pipe(Layer.provide(Layer.mergeAll(config_layer, http_layer)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mail http client", () => {
  it("retries a transient 500 then delivers", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response("oops", { status: 500 });
        return new Response("{}", { status: 200 });
      }),
    );
    const program = Effect.gen(function* () {
      const mail = yield* MailTag;
      yield* mail.send({ to: "a@example.com", subject: "s", text: "t", confirm_url: "http://x" });
    }).pipe(Effect.provide(mail_layers()));
    await Effect.runPromise(program);
    expect(calls).toBe(2);
  });

  it("fails closed after repeated provider errors without leaking the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    const program = Effect.gen(function* () {
      const mail = yield* MailTag;
      return yield* Effect.exit(mail.send({ to: "a@example.com", subject: "s", text: "t", confirm_url: "http://x" }));
    }).pipe(Effect.provide(mail_layers()));
    const exit = await Effect.runPromise(program);
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).not.toContain("test-key");
  });
});

function cloudflare_config() {
  const base = test_config();
  return {
    ...base,
    env: {
      ...base.env,
      MAIL_PROVIDER: "cloudflare",
      MAIL_FROM: "auth@mail.artisan.st",
      MAIL_FROM_NAME: "Artisan Street",
      RESEND_API_KEY: undefined } as Record<string, string | undefined>,
    mailer: "cloudflare" as const,
    resend_api_key: undefined };
}

describe("mail native cloudflare binding", () => {
  it("delivers from/to/subject/text through the binding", async () => {
    const seen: Array<{ from: unknown; to: unknown; subject: unknown; text: unknown }> = [];
    const native = {
      send: async (msg: {
        readonly from: unknown;
        readonly to: unknown;
        readonly subject: unknown;
        readonly text: unknown;
      }) => {
        seen.push({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text });
        return { messageId: "mid-1" };
      } } as unknown as SendEmailBinding;
    const config_layer = Layer.succeed(AppConfigTag, cloudflare_config());
    const layers = mail_cloudflare_live(native).pipe(Layer.provide(config_layer));
    const program = Effect.gen(function* () {
      const mail = yield* MailTag;
      yield* mail.send({ to: "user@example.com", subject: "Sign in to Ast", text: "body http://x", confirm_url: "http://x" });
    }).pipe(Effect.provide(layers));
    await Effect.runPromise(program);
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({
      from: { email: "auth@mail.artisan.st", name: "Artisan Street" },
      to: "user@example.com",
      subject: "Sign in to Ast",
      text: "body http://x",
    });
  });

  it("sends a bare address when no display name is configured", async () => {
    const seen: Array<{ from: unknown; to: unknown; subject: unknown; text: unknown }> = [];
    const native = {
      send: async (msg: {
        readonly from: unknown;
        readonly to: unknown;
        readonly subject: unknown;
        readonly text: unknown;
      }) => {
        seen.push({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text });
        return { messageId: "mid-2" };
      } } as unknown as SendEmailBinding;
    const cfg = cloudflare_config();
    const bare_cfg = {
      ...cfg,
      env: { ...cfg.env, MAIL_FROM_NAME: undefined } as Record<string, string | undefined> };
    const config_layer = Layer.succeed(AppConfigTag, bare_cfg);
    const layers = mail_cloudflare_live(native).pipe(Layer.provide(config_layer));
    const program = Effect.gen(function* () {
      const mail = yield* MailTag;
      yield* mail.send({ to: "user@example.com", subject: "s", text: "t", confirm_url: "http://x" });
    }).pipe(Effect.provide(layers));
    await Effect.runPromise(program);
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({
      from: "auth@mail.artisan.st",
      to: "user@example.com",
      subject: "s",
      text: "t",
    });
  });

  it("preserves the provider cause behind a generic public response", async () => {
    const failure = Object.assign(new Error("E_SENDER_NOT_VERIFIED"), { code: "E_SENDER_NOT_VERIFIED" });
    const native = {
      send: async (_msg: never) => {
        throw failure;
      } } as unknown as SendEmailBinding;
    const config_layer = Layer.succeed(AppConfigTag, cloudflare_config());
    const layers = mail_cloudflare_live(native).pipe(Layer.provide(config_layer));
    const program = Effect.gen(function* () {
      const mail = yield* MailTag;
      return yield* Effect.exit(mail.send({ to: "a@example.com", subject: "s", text: "t", confirm_url: "http://x" }));
    }).pipe(Effect.provide(layers));
    const exit = await Effect.runPromise(program);
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const failure_option = Cause.failureOption(exit.cause);
    expect(failure_option._tag).toBe("Some");
    if (failure_option._tag !== "Some") return;
    const err = failure_option.value as CoreError;
    expect(err).toBeInstanceOf(CoreError);
    expect(err.message).toBe("mail delivery failed");
    expect(err.cause).toBe(failure);
    expect(JSON.stringify(exit)).not.toContain("auth@mail.artisan.st");
  });

  it("fails closed without a binding at the Effect seam", async () => {
    const ctx = {
      db: {} as never,
      env: {
        vars: {
          CORE_ENV: "test",
          CORE_PUBLIC_BASE_URL: "http://test.invalid",
          CORE_JWT_ISSUER: "http://test.invalid",
          CORE_MASTER_KEY: MASTER_KEY,
          MAIL_PROVIDER: "cloudflare",
          MAIL_FROM: "auth@mail.artisan.st",
          MAIL_FROM_NAME: "Artisan Street" } },
      mailer: "cloudflare" as const,
      r2: {
        put: (_key: string, _body: Uint8Array | string) => Promise.resolve(undefined),
        get: (_key: string) => Promise.resolve(null) } as never,
      tx_runner: {
        transaction: <A, E>(effect: Effect.Effect<A, E, never>) => effect } as never };
    const layers = make_service_layers(ctx);
    const program = Effect.gen(function* () {
      const mail = yield* MailTag;
      return yield* Effect.exit(mail.send({ to: "a@example.com", subject: "s", text: "t", confirm_url: "http://x" }));
    }).pipe(Effect.provide(layers));
    const exit = await Effect.runPromise(program);
    expect(exit._tag).toBe("Failure");
  });

  it("refuses log mail in production while allowing native without a resend key", () => {
    expect(() =>
      config_from_env({
        CORE_ENV: "production",
        CORE_MASTER_KEY: MASTER_KEY,
        MAIL_PROVIDER: "log",
      }),
    ).toThrow();
    const cfg = config_from_env({
      CORE_ENV: "production",
      CORE_MASTER_KEY: MASTER_KEY,
      MAIL_PROVIDER: "cloudflare",
      MAIL_FROM: "auth@mail.artisan.st",
      MAIL_FROM_NAME: "Artisan Street",
    });
    expect(cfg.mailer).toBe("cloudflare");
    expect(cfg.resend_api_key).toBeUndefined();
  });
});
