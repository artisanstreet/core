import { Effect } from "effect";
import { newId } from "../ids.ts";
import { DbTag, dbRun } from "./deps.ts";
import insertActivity from "../db/queries/activity/insertActivity.sql";
import listActivityByAccount from "../db/queries/activity/listActivityByAccount.sql";

export function record(
  accountId: string,
  kind: string,
  opts: { machineId?: string | null; detail?: Record<string, unknown>; ip?: string | null },
) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    yield* dbRun(() =>
      insertActivity.run(db, {
        id: newId("evt"),
        accountId,
        machineId: opts.machineId ?? null,
        kind,
        detail: JSON.stringify(opts.detail ?? {}),
        ip: opts.ip ?? null,
      }),
    );
  });
}

export function listForAccount(accountId: string, limit: number) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* dbRun(() => listActivityByAccount.run(db, { accountId, limit }));
    return {
      events: rows.map((r) => ({
        id: r.id,
        machineId: r.machine_id,
        kind: r.kind,
        detail: typeof r.detail === "string" ? (JSON.parse(r.detail) as unknown) : r.detail,
        ip: r.ip,
        createdAt: r.created_at,
      })),
    };
  });
}
