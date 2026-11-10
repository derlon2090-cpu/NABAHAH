import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local" });
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
const client = new pg.Client({ connectionString });
const expected = ["ai_generation_runs", "concept_mastery", "document_chunks", "question_embeddings", "student_attempts", "student_profiles"];
try {
  await client.connect();
  const extension = await client.query("SELECT extname FROM pg_extension WHERE extname='vector'");
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='nabaha_question_bank' AND table_name=ANY($1::text[]) ORDER BY table_name",
    [expected],
  );
  const found = tables.rows.map((row) => row.table_name);
  if (!extension.rowCount || found.length !== expected.length) {
    const missing = expected.filter((name) => !found.includes(name));
    throw new Error(`RAG schema is incomplete (vector=${Boolean(extension.rowCount)}, missing=${missing.join(",") || "none"})`);
  }
  const chunks = await client.query("SELECT count(*)::int AS count FROM nabaha_question_bank.document_chunks");
  const sources = await client.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE extracted_text IS NOT NULL)::int AS extracted FROM nabaha_question_bank.source_documents");
  const goldenQuestions = await client.query("SELECT count(*)::int AS count FROM nabaha_question_bank.questions WHERE source_internal LIKE 'golden_seed:%'");
  console.log(`Verified vector extension and ${found.length} RAG/learning tables (${chunks.rows[0].count} chunks indexed; ${sources.rows[0].extracted}/${sources.rows[0].total} sources extracted; ${goldenQuestions.rows[0].count} golden questions).`);
} finally {
  await client.end().catch(() => undefined);
}
