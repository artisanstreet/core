import { Effect } from "effect";
import type { CoreError } from "../../errors.ts";
import type { DbTag } from "../../services/deps.ts";
import { latestBundle } from "./config.ts";

export const editor_config_version = (account_id: string) =>
  Effect.gen(function* () {
    const latest = yield* latestBundle(account_id);
    return latest.bundle?.version ?? null;
  });
