import { describe, expect, it, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { AppConfigTag } from "../../src/services/deps.ts";
import { MailLive, MailTag } from "../../src/services/mail.ts";
import { load_master_key } from "../../src/crypto.ts";

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
