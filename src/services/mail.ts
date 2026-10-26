import { Context, Effect, Layer } from "effect";
import { internal, type CoreError } from "../errors.js";
import type { AppConfig } from "./deps.js";
import { AppConfigTag } from "./deps.js";

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly confirmUrl: string;
}

export class MailTag extends Context.Tag("Mail")<MailTag, { readonly send: (m: Mail) => Effect.Effect<void, CoreError> }>() {}

// "log" is a dev/test delivery mechanism: it prints the confirmation URL to
// the server log so a developer can click it. The token inside is a live
// credential, so this mailer refuses to run in production (see deps.ts).
// Production uses "resend" (or another HTTP mail API configured at deploy;
// the request below is plain fetch, no SDK), which never logs the link.
export const MailLive = Layer.effect(
  MailTag,
  Effect.gen(function* () {
    const cfg: AppConfig = yield* AppConfigTag;
    const send = (m: Mail): Effect.Effect<void, CoreError> =>
      Effect.tryPromise({
        try: async () => {
          if (cfg.mailer === "log") {
            console.log(`[ast-core mail] to=${m.to} subject=${m.subject} confirm=${m.confirmUrl}`);
            return;
          }
          if (!cfg.resendApiKey) throw new Error("RESEND_API_KEY is not set");
          const from = cfg.env.MAIL_FROM ?? "Ast <noreply@example.invalid>";
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cfg.resendApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
          });
          if (!res.ok) throw new Error(`mail provider answered ${res.status}`);
        },
        catch: () => internal("mail delivery failed"),
      });
    return { send };
  }),
);

// Test mailer: captures deliveries in memory for behavioral tests.
export function memoryMailBox() {
  const out: Mail[] = [];
  const layer = Layer.succeed(MailTag, {
    send: (m: Mail) => Effect.sync(() => void out.push(m)),
  });
  return { out, layer };
}
