import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// The reproducible dev/test schema (db/schema.sql) and the deploy
// migrations must describe the same database. Applies both to scratch
// databases and diffs information_schema: tables, columns (name + type +
// nullability), and constraints. Any drift fails the suite.
async function shape(db: PGlite) {
  const tables = (await db.query(
    `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  const columns = (await db.query(
    `select table_name, column_name, data_type, udt_name, is_nullable from information_schema.columns where table_schema = 'public' order by 1, 2`,
  )) as unknown as { rows: Array<Record<string, string>> };
  const constraints = (await db.query(
    `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace order by 1`,
  )) as unknown as { rows: Array<Record<string, string>> };
  return {
    tables: tables.rows.map((r) => r.table_name),
    columns: columns.rows,
    constraints: constraints.rows.map((r) => `${r.conname} ${r.contype} ${r.def}`).sort(),
  };
}

describe("schema parity", () => {
  it("db/schema.sql equals db/migrations/*.sql applied in order", async () => {
    const root = new URL("..", import.meta.url);
    const schemaSql = await readFile(new URL("db/schema.sql", root), "utf8");
    const a = new PGlite();
    await a.exec(schemaSql);

    const b = new PGlite();
    const { readdir, readFile: read } = await import("node:fs/promises");
    const path = (await import("node:path")).default;
    const dir = new URL("db/migrations/", root);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      await b.exec(await read(path.join(dir.pathname, f), "utf8"));
    }

    const sa = await shape(a);
    const sb = await shape(b);
    expect(sb.tables).toEqual(sa.tables);
    expect(sb.columns).toEqual(sa.columns);
    expect(sb.constraints).toEqual(sa.constraints);
  });
});
