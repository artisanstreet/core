import { Effect } from "effect";
import { rate_limited } from "../errors.ts";
import { DbTag, db_run } from "./deps.ts";
import bump_rate_counter from "../db/queries/rate/bump-rate-counter.sql"

// Fixed-window budgets backed by the database so every isolate enforces the
// same limits. Wrong/absent codes cannot map to an enrollment or request,
// so budgets are keyed per account, per IP, and globally — never "per
// unknown target".
export const check_budget = (
  key: string,
  window_seconds: number,
  max: number,
  now_ms: number,
) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const bucket_start = new Date(
      Math.floor(now_ms / (window_seconds * 1000)) * window_seconds * 1000,
    ).toISOString();
    const row = yield* db_run(() => bump_rate_counter.run(db, { key, bucket_start: bucket_start }));
    if (row.count > max) return yield* Effect.fail(rate_limited("too many attempts"));
  });
