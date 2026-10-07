import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import pg from "pg";

dotenv.config({ path: ".env.local" });
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('nabaha_question_bank_migrations'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS nabaha_question_bank");
  await client.query("CREATE TABLE IF NOT EXISTS nabaha_question_bank.schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const name = "001_nabaha_question_bank.sql";
  const already = await client.query("SELECT 1 FROM nabaha_question_bank.schema_migrations WHERE name=$1", [name]);
  if (!already.rowCount) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await client.query(sql);
    await client.query("INSERT INTO nabaha_question_bank.schema_migrations(name) VALUES($1)", [name]);
  }
  await client.query("COMMIT");
  console.log(already.rowCount ? "Migration already applied." : "Question-bank migration applied.");
} catch {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error("Migration failed; details withheld.");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
