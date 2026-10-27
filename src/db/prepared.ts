// Production Reylo driver: Hyperdrive-compatible prepared statements.
//
// Cloudflare Hyperdrive pools connections with transaction pooling; the
// Postgres.js driver only uses server-side prepared statements when the
// per-query options say so — the client-level `prepare: true` flag does
// NOT propagate into `unsafe()` (node_modules/postgres/src/index.js sets
// `prepare: false` per query unless the third options argument overrides).
// Worse, `unsafe()` defaults `simple` to true when there are no params,
// and the simple query protocol ignores `prepare` entirely (see
// `toBuffer` in node_modules/postgres/src/connection.js). Reylo calls
// `c.unsafe(text, params)` with no options, so without this adapter every
// query runs unprepared — unreliable under Hyperdrive pooling.
//
// prepareDb wraps a postgres.js client (or transaction client) and forces
// `{ prepare: true, simple: false }` on every Reylo query: named prepared
// statements over the extended protocol, params or not. The real Query
// object (including `.raw()`, which Reylo's decoder requires) passes
// through untouched — no reimplementation, no driver patching.
//
// Official reference:
// https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
import type { Db } from "../db.js";

/** Minimal surface Reylo needs: `unsafe(text, params?)`. */
export interface UnsafeLike {
  unsafe(text: string, params?: unknown[]): unknown;
}

/**
 * Wrap a postgres.js client or transaction client so every Reylo query
 * runs as a named prepared statement. Structurally satisfies Reylo's
 * UnsafeClient, so it stays a valid Db.
 */
export function prepareDb<C extends UnsafeLike>(client: C): Db {
  const db = {
    unsafe: (text: string, params?: unknown[]) =>
      (client as unknown as {
        unsafe(text: string, params: unknown[], options: { prepare: boolean; simple: boolean }): unknown;
      }).unsafe(text, params ?? [], { prepare: true, simple: false }),
  };
  return db as unknown as Db;
}
