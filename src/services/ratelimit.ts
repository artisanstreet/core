import { Effect } from "effect";
import { rateLimited } from "../errors.js";
import { DbTag, dbRun } from "./deps.js";
import bumpRateCounter from "../db/queries/rate/bumpRateCounter.sql";

// Fixed-window budgets backed by the database so every isolate enforces the
// same limits. Wrong/absent codes cannot map to an enrollment or request,
// so budgets are keyed per account, per IP, and globally — never "per
// unknown target".
export function checkBudget(
  key: string,
  windowSeconds: number,
  max: number,
  nowMs: number,
) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const bucketStart = new Date(
      Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000,
    ).toISOString();
    const row = yield* dbRun(() => bumpRateCounter.run(db, { key, bucketStart }));
    if (row.count > max) return yield* Effect.fail(rateLimited("too many attempts"));
  });
}
