import { Effect } from "effect";
import type { CoreError } from "../../errors.ts";
import type { DbTag } from "../../services/deps.ts";
import { latest_bundle } from "./config.ts";

export const editor_config_version = (account_id: string) =>
  Effect.gen(function* () {
    const latest = yield* latest_bundle(account_id);
    return latest.bundle?.version ?? null;
  });
