import { describe, expect, it } from "vitest";
import { Effect } from "effect";

describe("scoped db lifecycle", () => {
  it("finalizer runs after slow use completes, not before", async () => {
    const events: Array<string> = [];
    const fake_client = {
      query_delayed: () =>
        Effect.gen(function* () {
          events.push("query-start");
          yield* Effect.sleep("50 millis");
          events.push("query-end");
          return "ok";
        }),
      end: () =>
        Effect.gen(function* () {
          events.push("close");
        }) };
    const program = Effect.acquireUseRelease(
      Effect.sync(() => fake_client),
      (client) => client.query_delayed(),
      (client) => client.end(),
    );
    const result = await Effect.runPromise(program);
    expect(result).toBe("ok");
    expect(events).toEqual(["query-start", "query-end", "close"]);
  });
});
