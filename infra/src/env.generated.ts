/**
 * Generated from .env.schema by Varlock for Effect 4. Do not edit by hand.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"

function redactErrors<A>(config: Config.Config<A>, key: string): Config.Config<A> {
  return Config.orElse(config, () => {
    const error = new Schema.SchemaError(
      new SchemaIssue.Pointer([key], new SchemaIssue.InvalidValue({ message: "<redacted>" })),
    )
    // Config.fail is typed as Config<unknown> in this Effect release, but never succeeds.
    return Config.fail(error) as Config.Config<never>
  })
}


export const config = Config.all({
  /**
   * Exact https bare origin. Stage-specific; never reuse prod for previews.
   */
  "AST_CORE_ORIGIN": Config.String("AST_CORE_ORIGIN"),
  "AST_RELAY_ORIGIN": Config.String("AST_RELAY_ORIGIN"),
  /**
   * Browser origins for exact credentialed CORS (auth + dashboard).
   * Stage-specific; never reuse prod for previews (second custom-domain
   * attach would move ownership).
   */
  "AST_AUTH_ORIGIN": Config.String("AST_AUTH_ORIGIN"),
  "AST_DASHBOARD_ORIGIN": Config.String("AST_DASHBOARD_ORIGIN"),
  /**
   * External Postgres direct URL (secret; no pooled URL).
   */
  "AST_CORE_DATABASE_URL": redactErrors(Config.map(Config.String("AST_CORE_DATABASE_URL"), Redacted.make), "AST_CORE_DATABASE_URL"),
  /**
   * 32B base64url, no padding.
   */
  "CORE_MASTER_KEY": redactErrors(Config.map(Config.String("CORE_MASTER_KEY"), Redacted.make), "CORE_MASTER_KEY"),
  "CORE_ADMIN_TOKEN": redactErrors(Config.map(Config.String("CORE_ADMIN_TOKEN"), Redacted.make), "CORE_ADMIN_TOKEN"),
  /**
   * Verified Cloudflare sender on mail.artisan.st.
   */
  "MAIL_FROM": Config.String("MAIL_FROM"),
  /**
   * Display name (defaults to Artisan Street).
   */
  "MAIL_FROM_NAME": Config.option(Config.String("MAIL_FROM_NAME")),
  /**
   * Legacy resend secret (dev compat); cloudflare mailer needs none.
   */
  "RESEND_API_KEY": redactErrors(Config.option(Config.map(Config.String("RESEND_API_KEY"), Redacted.make)), "RESEND_API_KEY"),
})

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
