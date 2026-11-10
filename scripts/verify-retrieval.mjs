import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local" });
const { embedTexts, embeddingsConfigured } = await import("../src/services/embedding-client.mjs");
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
const queryText = process.argv.slice(2).join(" ").trim() || "إذا تضاعفت المسافة بين كتلتين فكيف تتغير قوة الجذب؟";
const stopWords = new Set(["إذا", "فإن", "كيف", "ماذا", "بين", "على", "إلى", "عند", "من", "في", "ما", "هل"]);
const lexicalQuery = [...new Set(queryText.toLocaleLowerCase("ar").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u).filter((token) => token.length >= 3 && !stopWords.has(token)).slice(0, 12))].join(" | ");
const client = new pg.Client({ connectionString });

try {
  await client.connect();
  const vector = embeddingsConfigured() ? (await embedTexts([queryText]))[0] : null;
  const result = await client.query(
    `WITH vector_matches AS (
       SELECT id,row_number() OVER(ORDER BY embedding <=> $1::vector(1536)) rank
       FROM nabaha_question_bank.document_chunks
       WHERE $1::text IS NOT NULL AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector(1536) LIMIT 20
     ), text_matches AS (
       SELECT id,row_number() OVER(ORDER BY ts_rank_cd(tsv_content,to_tsquery('simple',$2)) DESC) rank
       FROM nabaha_question_bank.document_chunks
       WHERE tsv_content @@ to_tsquery('simple',$2)
       ORDER BY ts_rank_cd(tsv_content,to_tsquery('simple',$2)) DESC LIMIT 20
     )
     SELECT c.source_name,c.page_number,left(c.content,180) content,
       coalesce(1.0/(60+v.rank),0)+coalesce(1.0/(60+t.rank),0) rrf_score,
       v.rank vector_rank,t.rank text_rank
     FROM vector_matches v FULL JOIN text_matches t ON v.id=t.id
     JOIN nabaha_question_bank.document_chunks c ON c.id=coalesce(v.id,t.id)
     ORDER BY rrf_score DESC LIMIT 5`,
    [vector ? `[${vector.join(",")}]` : null, lexicalQuery],
  );
  console.table(result.rows);
  if (!result.rowCount) throw new Error("No retrieval results; seed content first");
} finally {
  await client.end().catch(() => undefined);
}
