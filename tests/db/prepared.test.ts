// Pins the production query path: every Reylo query runs as a named
// prepared statement over the extended protocol, params or not. The
// Hyperdrive pool requires this; postgres.js `unsafe()` otherwise runs
// unprepared (and zero-param queries run on the simple protocol, which
// ignores `prepare` entirely). Uses fakes — no database needed. Real-PG
// validation was done separately against the local database (see docs).
import { describe, expect, it, vi } from "vitest";
import { prepareDb } from "../../src/db/prepared.ts";

function fakeQuery() {
  const q = { raw: () => Promise.resolve([] as unknown[]) };
  return q;
}

function fakeSql() {
  const calls: Array<{ text: string; params: unknown[]; options: Record<string, unknown> }> = [];
  const sql = {
    calls,
    unsafe: vi.fn(
      (text: string, params?: unknown[], options?: Record<string, unknown>) => {
        calls.push({ text, params: params ?? [], options: options ?? {} });
        return fakeQuery();
      },
    ),
  };
  return sql;
}

describe("prepareDb (Hyperdrive prepared-statement adapter)", () => {
  it("forces prepare+extended protocol on parameterized queries", async () => {
    const sql = fakeSql();
    const db = prepareDb(sql);
    const pending = (db as unknown as { unsafe(t: string, p: unknown[]): { raw(): Promise<unknown[]> } }).unsafe(
      "SELECT $1::int",
      [1],
    );
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]).toEqual({
      text: "SELECT $1::int",
      params: [1],
      options: { prepare: true, simple: false },
    });
    await expect(pending.raw()).resolves.toEqual([]);
  });

  it("forces prepare+extended protocol on zero-param queries (simple defaults true otherwise)", async () => {
    const sql = fakeSql();
    const db = prepareDb(sql);
    const pending = (db as unknown as { unsafe(t: string, p?: unknown[]): { raw(): Promise<unknown[]> } }).unsafe(
      "SELECT 1",
    );
    expect(sql.calls).toHaveLength(1);
    // params default to [] and simple is explicitly false: without this,
    // postgres.js would take the simple protocol and ignore prepare.
    expect(sql.calls[0]).toEqual({ text: "SELECT 1", params: [], options: { prepare: true, simple: false } });
    await expect(pending.raw()).resolves.toEqual([]);
  });

  it("passes the real Query object through untouched (`.raw()` intact)", () => {
    const sentinel = { raw: () => Promise.resolve([1]) };
    const sql = { unsafe: (_t?: string, _p?: unknown[], _o?: unknown) => sentinel };
    const db = prepareDb(sql);
    const out = (db as unknown as { unsafe(t: string, p: unknown[]): unknown }).unsafe("SELECT 1", []);
    expect(out).toBe(sentinel);
  });

  it("wraps transaction clients with the same adapter (txRunner path)", async () => {
    const sql = fakeSql();
    const tx = { unsafe: sql.unsafe };
    const wrapped = prepareDb(tx);
    await (wrapped as unknown as { unsafe(t: string, p: unknown[]): { raw(): Promise<unknown[]> } }).unsafe("SELECT $1::int", [2]);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.options).toEqual({ prepare: true, simple: false });
  });
});
