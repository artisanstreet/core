// Applies db/migrations/*.sql in filename order. Every migration runs in
// its own transaction holding a transaction-scoped advisory lock, and the
// version row is recorded in the same transaction — concurrent migrators
// serialize and never double-apply. Migration bodies execute in the
// driver's simple-query mode (multi-statement files), bookkeeping through
// the driver's file loader. No SQL lives in this script: every statement
// is in db/migrations/*.sql or db/migrate-helpers/*.sql.
//
// Env comes from `varlock run` (validates .env.schema, explicit DATABASE_URL
// in the ambient environment wins); no custom dotenv parsing here.
import { readdir, readFile as read_file } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath as file_url_to_path } from "node:url";
import postgres from "postgres";

const root = path.dirname(path.dirname(file_url_to_path(import.meta.url)));
const migrations_dir = path.join(root, "db", "migrations");
const helpers_dir = path.join(root, "db", "migrate-helpers");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (run via `varlock run`, see .env.schema)");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

const files = (await readdir(migrations_dir)).filter((f) => f.endsWith(".sql")).sort();
if (!files.includes("0000_schema_migrations.sql")) {
  console.error("missing 0000_schema_migrations.sql");
  process.exit(1);
}

const lock_path = path.join(helpers_dir, "lock.sql");
const applied_path = path.join(helpers_dir, "applied.sql");
const record_path = path.join(helpers_dir, "record.sql");

for (const f of files) {
  const outcome = await sql.begin(async (tx) => {
    await tx.file(lock_path);
    if (f !== "0000_schema_migrations.sql") {
      const rows = await tx.file(applied_path, [f]);
      if (rows.length > 0) return "skip";
    }
    const body = await read_file(path.join(migrations_dir, f), "utf8");
    // Driver-supported multi-statement execution (simple query protocol).
    await tx.unsafe(body).simple();
    if (f !== "0000_schema_migrations.sql") {
      await tx.file(record_path, [f]);
    }
    return "apply";
  });
  console.log(`${outcome} ${f}`);
}
await sql.end();
console.log("migrations up to date");
