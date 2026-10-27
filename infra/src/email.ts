import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { MAIL_SENDING_SUBDOMAIN, MAIL_ZONE_ID } from "./config.ts";

// Native Cloudflare Email Service sending-domain onboarding. The
// SendingSubdomain provisions SPF/DKIM/return-path on the dedicated
// mail.artisan.st subdomain; root artisan.st MX records (existing mail)
// are never touched. previewEnabled stays false so the dashboard never
// retains magic-link message contents.
export const CoreMailSending = Effect.gen(function* () {
  return yield* Cloudflare.Email.SendingSubdomain("MailSending", {
    zoneId: MAIL_ZONE_ID,
    name: MAIL_SENDING_SUBDOMAIN,
    previewEnabled: false,
  });
});
