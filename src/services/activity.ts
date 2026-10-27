import { Effect, Either } from "effect";
import { newId } from "../ids.ts";
import { DbTag, dbRun } from "./deps.ts";
import insertActivity from "../db/queries/activity/insertActivity.sql";
import listActivityByAccount from "../db/queries/activity/listActivityByAccount.sql";

export const record = (
  accountId: string,
  kind: string,
  opts: { machineId?: string | null; detail?: Record<string, unknown>; ip?: string | null },
) =>
  Effect.gen(function* () {
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

export const listForAccount = (accountId: string, limit: number) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* dbRun(() => listActivityByAccount.run(db, { accountId, limit }));
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
          createdAt: r.created_at,
        };
      }),
    };
  });
