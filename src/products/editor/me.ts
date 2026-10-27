import { Effect } from "effect";
import type { CoreError } from "../../errors.ts";
import type { DbTag } from "../../services/deps.ts";
import { latestBundle } from "./config.ts";

export function editor_config_version(account_id: string): Effect.Effect<number | null, CoreError, DbTag> {
  return Effect.gen(function* () {
    const latest = yield* latestBundle(account_id);
    return latest.bundle?.version ?? null;
  });
}
