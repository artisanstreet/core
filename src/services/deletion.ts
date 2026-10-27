import { Effect } from "effect";
import { forbidden, gone } from "../errors.ts";
import { DbTag, db_run } from "./deps.ts";
import { AppConfigTag } from "./deps.ts";
import { record } from "./activity.ts";
import upsert_deletion_request from "../db/queries/deletion/upsert-deletion-request.sql"
import get_deletion_request from "../db/queries/deletion/get-deletion-request.sql"
import list_due_deletion_requests from "../db/queries/deletion/list-due-deletion-requests.sql"
import cancel_deletion_request from "../db/queries/deletion/cancel-deletion-request.sql"
import complete_deletion_request from "../db/queries/deletion/complete-deletion-request.sql"
import purge_activity from "../db/queries/deletion/purge-activity.sql"
import purge_sessions from "../db/queries/deletion/purge-sessions.sql"
import purge_enrollments from "../db/queries/deletion/purge-enrollments.sql"
import purge_machines from "../db/queries/deletion/purge-machines.sql"
import purge_provider_connections from "../db/queries/deletion/purge-provider-connections.sql"
import purge_engine_artifacts from "../db/queries/deletion/purge-engine-artifacts.sql"
import purge_config_bundles from "../db/queries/deletion/purge-config-bundles.sql"
import purge_recovery_codes from "../db/queries/deletion/purge-recovery-codes.sql"
import purge_deletion_request from "../db/queries/deletion/purge-deletion-request.sql"
import delete_account from "../db/queries/accounts/delete-account.sql"
import request_deletion from "../db/queries/accounts/request-deletion.sql"

const GRACE_DAYS = 30;

export const request_account_deletion = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const purge_after = new Date(cfg.now() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rows = yield* db_run(() => upsert_deletion_request.run(db, { account_id: account_id, purge_after: purge_after }));
    const row = rows[0] ?? null;
    if (!row) return yield* Effect.fail(forbidden("could not open deletion request"));
    yield* db_run(() => request_deletion.run(db, { id: account_id }));
    yield* record(account_id, "account.deletion_requested", {});
    return { status: row.status, requestedAt: row.requested_at, purgeAfter: row.purge_after };
  });

export const deletion_status = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => get_deletion_request.run(db, { account_id: account_id }));
    if (!row) return { status: "none" as const, requestedAt: null, purgeAfter: null, completedAt: null };
    return {
      status: row.status as "pending" | "cancelled" | "done",
      requestedAt: row.requested_at,
      purgeAfter: row.purge_after,
      completedAt: row.completed_at };
  });

export const cancel_account_deletion = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => cancel_deletion_request.run(db, { account_id: account_id }));
    if (!row) return yield* Effect.fail(gone("no pending deletion request"));
    yield* record(account_id, "account.deletion_cancelled", {});
    return { status: row.status };
  });

const purge_account = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    // Order respects foreign keys; cascades carry assignments and states.
    yield* db_run(() => purge_activity.run(db, { account_id: account_id }));
    yield* db_run(() => purge_sessions.run(db, { account_id: account_id }));
    yield* db_run(() => purge_enrollments.run(db, { account_id: account_id }));
    yield* db_run(() => purge_machines.run(db, { account_id: account_id }));
    yield* db_run(() => purge_provider_connections.run(db, { account_id: account_id }));
    yield* db_run(() => purge_engine_artifacts.run(db, { account_id: account_id }));
    yield* db_run(() => purge_config_bundles.run(db, { account_id: account_id }));
    yield* db_run(() => purge_recovery_codes.run(db, { account_id: account_id }));
    yield* db_run(() => complete_deletion_request.run(db, { account_id: account_id }));
    yield* db_run(() => purge_deletion_request.run(db, { account_id: account_id }));
    yield* db_run(() => delete_account.run(db, { id: account_id }));
  });

// Purge every account whose grace period passed. Called by the scheduled
// worker; covered by tests directly.
export const purge_due_accounts = (now: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const due = yield* db_run(() => list_due_deletion_requests.run(db, { now }));
    const purged: string[] = [];
    for (const r of due) {
      yield* purge_account(r.account_id);
      purged.push(r.account_id);
    }
    return { purged };
  });
