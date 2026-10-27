// Applies db/migrations/*.sql in filename order. Every migration runs in
// its own transaction holding a transaction-scoped advisory lock, and the
// version row is recorded in the same transaction — concurrent migrators
// serialize and never double-apply. Migration bodies execute in the
// driver's simple-query mode (multi-statement files), bookkeeping through
// the driver's file loader. No SQL lives in this script: every statement
// is in db/migrations/*.sql or db/migrate-helpers/*.sql.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, "db", "migrations");
const helpersDir = path.join(root, "db", "migrate-helpers");

// Minimal .env loader (config, not SQL): KEY=VALUE lines, no interpolation.
for (const name of [".env.local", ".env"]) {
  try {
    const text = await readFile(path.join(root, name), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
      }
    }
  } catch { /* optional */ }
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example)");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
if (!files.includes("0000_schema_migrations.sql")) {
  console.error("missing 0000_schema_migrations.sql");
  process.exit(1);
}

const lockPath = path.join(helpersDir, "lock.sql");
const appliedPath = path.join(helpersDir, "applied.sql");
const recordPath = path.join(helpersDir, "record.sql");

for (const f of files) {
  const outcome = await sql.begin(async (tx) => {
    await tx.file(lockPath);
    if (f !== "0000_schema_migrations.sql") {
      const rows = await tx.file(appliedPath, [f]);
      if (rows.length > 0) return "skip";
    }
    const body = await readFile(path.join(migrationsDir, f), "utf8");
    // Driver-supported multi-statement execution (simple query protocol).
    await tx.unsafe(body).simple();
    if (f !== "0000_schema_migrations.sql") {
      await tx.file(recordPath, [f]);
    }
    return "apply";
  });
  console.log(`${outcome} ${f}`);
}
await sql.end();
console.log("migrations up to date");
