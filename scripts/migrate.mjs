import dotenv from "dotenv";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

dotenv.config({ path: ".env.local" });
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('nabaha_question_bank_migrations'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS nabaha_question_bank");
  await client.query("CREATE TABLE IF NOT EXISTS nabaha_question_bank.schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(migrationDirectory)).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort();
  const applied = [];
  for (const name of names) {
    const already = await client.query("SELECT 1 FROM nabaha_question_bank.schema_migrations WHERE name=$1", [name]);
    if (already.rowCount) continue;
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await client.query(sql);
    await client.query("INSERT INTO nabaha_question_bank.schema_migrations(name) VALUES($1)", [name]);
    applied.push(name);
  }
  await client.query("COMMIT");
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "All migrations already applied.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error("Migration failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
