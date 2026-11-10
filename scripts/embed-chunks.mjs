import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local" });
const { embedTexts, embeddingDimensions, embeddingModel, embeddingsConfigured } = await import("../src/services/embedding-client.mjs");
if (!embeddingsConfigured()) throw new Error("AI_API_BASE_URL, AI_API_KEY, and AI_EMBEDDING_MODEL are required");
if (embeddingDimensions !== 1536) {
  throw new Error(`The current Neon columns are vector(1536), but AI_EMBEDDING_DIMENSIONS=${embeddingDimensions}. Add a reviewed dimension migration before using this model.`);
}
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
const batchSize = Math.min(Math.max(Number(process.env.EMBEDDING_BATCH_SIZE ?? 50), 1), 100);
const client = new pg.Client({ connectionString });
let updated = 0;

try {
  await client.connect();
  while (true) {
    const pending = await client.query(
      `SELECT id,content FROM nabaha_question_bank.document_chunks
       WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM $1
       ORDER BY created_at,id LIMIT $2`,
      [embeddingModel, batchSize],
    );
    if (!pending.rowCount) break;
    const vectors = await embedTexts(pending.rows.map((row) => row.content));
    await client.query("BEGIN");
    try {
      for (let index = 0; index < pending.rows.length; index++) {
        await client.query(
          `UPDATE nabaha_question_bank.document_chunks
           SET embedding=$2::vector(1536),embedding_model=$3,embedding_dimensions=$4,embedding_updated_at=now()
           WHERE id=$1`,
          [pending.rows[index].id, `[${vectors[index].join(",")}]`, embeddingModel, embeddingDimensions],
        );
      }
      await client.query("COMMIT");
      updated += pending.rows.length;
      console.log(`Embedded ${updated} chunks...`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  console.log(`Embedding complete: ${updated} chunks updated with ${embeddingModel}.`);
} finally {
  await client.end().catch(() => undefined);
}
