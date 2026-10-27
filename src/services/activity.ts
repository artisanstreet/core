import { Effect, Either } from "effect";
import { new_id } from "../ids.ts";
import { DbTag, db_run } from "./deps.ts";
import insert_activity from "../db/queries/activity/insert-activity.sql"
import list_activity_by_account from "../db/queries/activity/list-activity-by-account.sql"

export const record = (
  account_id: string,
  kind: string,
  opts: { machine_id?: string | null; detail?: Record<string, unknown>; ip?: string | null },
) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    yield* db_run(() =>
      insert_activity.run(db, {
        id: new_id("evt"),
        account_id: account_id,
        machine_id: opts.machine_id ?? null,
        kind,
        detail: JSON.stringify(opts.detail ?? {}),
        ip: opts.ip ?? null }),
    );
  });

export const list_for_account = (account_id: string, limit: number) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* db_run(() => list_activity_by_account.run(db, { account_id: account_id, limit }));
    return {
      events: rows.map((r) => {
        const raw_detail: unknown = r.detail;
        const detail = typeof raw_detail === "string"
          ? Either.getOrNull(Either.try(() => JSON.parse(raw_detail) as unknown)) ?? raw_detail
          : raw_detail;
        return {
          id: r.id,
          machineId: r.machine_id,
          kind: r.kind,
          detail,
          ip: r.ip,
          createdAt: r.created_at };
      }) };
  });
