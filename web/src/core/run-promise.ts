// Promise boundary: `run_promise` rejects with `FiberFailure`, so typed
// failures go through `runPromiseExit` + `Cause.failureOption` here.

import { Cause, Effect } from "effect";
import { to_legacy_error } from "./api-error.ts";

/** UI/SDK boundary: typed failures become legacy `ApiError`, defects safe. */
export function run_promise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (exit._tag === "Success") return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw to_legacy_error(failure.value);
    const squashed = Cause.squash(exit.cause);
    throw to_legacy_error(squashed instanceof Error ? squashed : new Error("Something went wrong."));
  });
}

/** Internal flows: preserve `Error` instances, wrap anything else. */
export function run_effect<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (exit._tag === "Success") return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") {
      const value = failure.value;
      throw value instanceof Error ? value : new Error(typeof value === "string" ? value : "Operation failed.");
    }
    const squashed = Cause.squash(exit.cause);
    throw squashed instanceof Error ? squashed : new Error("Operation failed.");
  });
}
