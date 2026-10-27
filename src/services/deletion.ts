import { Effect } from "effect";
import { forbidden, gone } from "../errors.ts";
import { DbTag, dbRun } from "./deps.ts";
import { AppConfigTag } from "./deps.ts";
import { record } from "./activity.ts";
import upsertDeletionRequest from "../db/queries/deletion/upsertDeletionRequest.sql";
import getDeletionRequest from "../db/queries/deletion/getDeletionRequest.sql";
import listDueDeletionRequests from "../db/queries/deletion/listDueDeletionRequests.sql";
import cancelDeletionRequest from "../db/queries/deletion/cancelDeletionRequest.sql";
import completeDeletionRequest from "../db/queries/deletion/completeDeletionRequest.sql";
import purgeActivity from "../db/queries/deletion/purgeActivity.sql";
import purgeSessions from "../db/queries/deletion/purgeSessions.sql";
import purgeEnrollments from "../db/queries/deletion/purgeEnrollments.sql";
import purgeMachines from "../db/queries/deletion/purgeMachines.sql";
import purgeProviderConnections from "../db/queries/deletion/purgeProviderConnections.sql";
import purgeEngineArtifacts from "../db/queries/deletion/purgeEngineArtifacts.sql";
import purgeConfigBundles from "../db/queries/deletion/purgeConfigBundles.sql";
import purgeRecoveryCodes from "../db/queries/deletion/purgeRecoveryCodes.sql";
import purgeDeletionRequest from "../db/queries/deletion/purgeDeletionRequest.sql";
import deleteAccount from "../db/queries/accounts/deleteAccount.sql";
import requestDeletion from "../db/queries/accounts/requestDeletion.sql";

const GRACE_DAYS = 30;

export const requestAccountDeletion = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const purgeAfter = new Date(cfg.now() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rows = yield* dbRun(() => upsertDeletionRequest.run(db, { accountId, purgeAfter }));
    const row = rows[0] ?? null;
    if (!row) return yield* Effect.fail(forbidden("could not open deletion request"));
    yield* dbRun(() => requestDeletion.run(db, { id: accountId }));
    yield* record(accountId, "account.deletion_requested", {});
    return { status: row.status, requestedAt: row.requested_at, purgeAfter: row.purge_after };
  });

export const deletionStatus = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => getDeletionRequest.run(db, { accountId }));
    if (!row) return { status: "none" as const, requestedAt: null, purgeAfter: null, completedAt: null };
    return {
      status: row.status as "pending" | "cancelled" | "done",
      requestedAt: row.requested_at,
      purgeAfter: row.purge_after,
      completedAt: row.completed_at,
    };
  });

export const cancelAccountDeletion = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => cancelDeletionRequest.run(db, { accountId }));
    if (!row) return yield* Effect.fail(gone("no pending deletion request"));
    yield* record(accountId, "account.deletion_cancelled", {});
    return { status: row.status };
  });

const purgeAccount = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    // Order respects foreign keys; cascades carry assignments and states.
    yield* dbRun(() => purgeActivity.run(db, { accountId }));
    yield* dbRun(() => purgeSessions.run(db, { accountId }));
    yield* dbRun(() => purgeEnrollments.run(db, { accountId }));
    yield* dbRun(() => purgeMachines.run(db, { accountId }));
    yield* dbRun(() => purgeProviderConnections.run(db, { accountId }));
    yield* dbRun(() => purgeEngineArtifacts.run(db, { accountId }));
    yield* dbRun(() => purgeConfigBundles.run(db, { accountId }));
    yield* dbRun(() => purgeRecoveryCodes.run(db, { accountId }));
    yield* dbRun(() => completeDeletionRequest.run(db, { accountId }));
    yield* dbRun(() => purgeDeletionRequest.run(db, { accountId }));
    yield* dbRun(() => deleteAccount.run(db, { id: accountId }));
  });

// Purge every account whose grace period passed. Called by the scheduled
// worker; covered by tests directly.
export const purgeDueAccounts = (now: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const due = yield* dbRun(() => listDueDeletionRequests.run(db, { now }));
    const purged: string[] = [];
    for (const r of due) {
      yield* purgeAccount(r.account_id);
      purged.push(r.account_id);
    }
    return { purged };
  });
