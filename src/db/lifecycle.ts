import { Effect } from "effect";

export const with_scoped_db = <C, R, E, A>(
  open: Effect.Effect<C, E, R>,
  use: (client: C) => Effect.Effect<A, E, R>,
  close: (client: C) => Effect.Effect<void, never, R>,
) =>
  Effect.acquireUseRelease(open, use, (client) => close(client).pipe(Effect.orElseSucceed(() => undefined)));
