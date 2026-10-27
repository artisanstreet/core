import { Effect } from "effect";
import { DbTag, db_run } from "./deps.ts";
import { purge_due_accounts } from "./deletion.ts";
import expire_overdue_logins from "../db/queries/login/expire-overdue-logins.sql";
import expire_overdue_enrollments from "../db/queries/enrollments/expire-overdue-enrollments.sql";
import prune_nonces from "../db/queries/nonces/prune-nonces.sql";
import prune_sessions from "../db/queries/sessions/prune-sessions.sql";
import prune_rate_counters from "../db/queries/rate/prune-rate-counters.sql";
import prune_totp_steps from "../db/queries/totp/prune-totp-steps.sql";

// Scheduled maintenance: expire stale requests, drop used nonces and old
// counters, purge accounts past their deletion grace period.
export const janitor = (now_ms: number) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const now = new Date(now_ms).toISOString();
    const day_ago = new Date(now_ms - 24 * 60 * 60 * 1000).toISOString();
    const logins = yield* db_run(() => expire_overdue_logins.run(db, {}));
    const enrollments = yield* db_run(() => expire_overdue_enrollments.run(db, {}));
    const nonces = yield* db_run(() => prune_nonces.run(db, { before: day_ago }));
    const sessions = yield* db_run(() => prune_sessions.run(db, { before: day_ago }));
    const counters = yield* db_run(() => prune_rate_counters.run(db, { before: day_ago }));
    const steps = yield* db_run(() => prune_totp_steps.run(db, { before: day_ago }));
    const { purged } = yield* purge_due_accounts(now);
    return {
      expiredLogins: logins.length,
      expiredEnrollments: enrollments.length,
      prunedNonces: nonces.length,
      prunedSessions: sessions.length,
      prunedCounters: counters.length,
      prunedTotpSteps: steps.length,
      purgedAccounts: purged };
  });
