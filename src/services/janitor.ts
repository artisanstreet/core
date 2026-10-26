import { Effect } from "effect";
import { DbTag, dbRun } from "./deps.js";
import { purgeDueAccounts } from "./deletion.js";
import expireOverdueLogins from "../db/queries/login/expireOverdueLogins.sql";
import expireOverdueEnrollments from "../db/queries/enrollments/expireOverdueEnrollments.sql";
import pruneNonces from "../db/queries/nonces/pruneNonces.sql";
import pruneSessions from "../db/queries/sessions/pruneSessions.sql";
import pruneRateCounters from "../db/queries/rate/pruneRateCounters.sql";
import pruneTotpSteps from "../db/queries/totp/pruneTotpSteps.sql";

// Scheduled maintenance: expire stale requests, drop used nonces and old
// counters, purge accounts past their deletion grace period.
export function janitor(nowMs: number) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const now = new Date(nowMs).toISOString();
    const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const logins = yield* dbRun(() => expireOverdueLogins.run(db, {}));
    const enrollments = yield* dbRun(() => expireOverdueEnrollments.run(db, {}));
    const nonces = yield* dbRun(() => pruneNonces.run(db, { before: dayAgo }));
    const sessions = yield* dbRun(() => pruneSessions.run(db, { before: dayAgo }));
    const counters = yield* dbRun(() => pruneRateCounters.run(db, { before: dayAgo }));
    const steps = yield* dbRun(() => pruneTotpSteps.run(db, { before: dayAgo }));
    const { purged } = yield* purgeDueAccounts(now);
    return {
      expiredLogins: logins.length,
      expiredEnrollments: enrollments.length,
      prunedNonces: nonces.length,
      prunedSessions: sessions.length,
      prunedCounters: counters.length,
      prunedTotpSteps: steps.length,
      purgedAccounts: purged,
    };
  });
}
