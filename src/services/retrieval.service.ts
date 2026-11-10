import type pg from "pg";

const schema = "nabaha_question_bank";

export interface RetrievalResult {
  chunkId: string;
  content: string;
  sourceName: string;
  pageNumber: number | null;
  subjectId: string;
  topicId: string | null;
  curriculumVersion: string;
  finalScore: number;
}

export interface RetrievalParams {
  queryText: string;
  queryVector?: number[] | null;
  subjectId?: string | null;
  topicId?: string | null;
  curriculumVersion?: string | null;
  limit?: number;
  candidateLimit?: number;
}

function vectorLiteral(vector?: number[] | null) {
  if (!vector?.length) return null;
  if (vector.length !== 1536 || vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError("queryVector must contain exactly 1536 finite numbers");
  }
  return `[${vector.join(",")}]`;
}

function lexicalTsQuery(value: string) {
  const stopWords = new Set(["إذا", "فإن", "كيف", "ماذا", "بين", "على", "إلى", "عند", "من", "في", "ما", "هل"]);
  return [...new Set(value.toLocaleLowerCase("ar").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u)
    .filter((token) => token.length >= 3 && !stopWords.has(token)).slice(0, 12))].join(" | ");
}

export async function hybridRetrieve(
  pool: pg.Pool | pg.PoolClient,
  params: RetrievalParams,
): Promise<RetrievalResult[]> {
  const queryText = params.queryText.trim().slice(0, 2_000);
  if (!queryText) return [];
  const limit = Math.min(Math.max(params.limit ?? 5, 1), 20);
  const candidateLimit = Math.min(Math.max(params.candidateLimit ?? 30, limit), 100);
  const vector = vectorLiteral(params.queryVector);
  const lexicalQuery = lexicalTsQuery(queryText);
  if (!vector && !lexicalQuery) return [];

  const result = await pool.query(
    `WITH vector_matches AS (
       SELECT id, content, source_name, page_number, subject_id, topic_id, curriculum_version,
              row_number() OVER (ORDER BY embedding <=> $1::vector(1536)) AS rank
       FROM ${schema}.document_chunks
       WHERE $1::text IS NOT NULL
         AND embedding IS NOT NULL
         AND ($2::uuid IS NULL OR subject_id = $2::uuid)
         AND ($3::uuid IS NULL OR topic_id = $3::uuid)
         AND ($4::text IS NULL OR curriculum_version = $4::text)
       ORDER BY embedding <=> $1::vector(1536)
       LIMIT $6
     ),
     text_matches AS (
       SELECT id, content, source_name, page_number, subject_id, topic_id, curriculum_version,
              row_number() OVER (ORDER BY ts_rank_cd(tsv_content, to_tsquery('simple', $5)) DESC) AS rank
       FROM ${schema}.document_chunks
       WHERE $5::text <> '' AND tsv_content @@ to_tsquery('simple', $5)
         AND ($2::uuid IS NULL OR subject_id = $2::uuid)
         AND ($3::uuid IS NULL OR topic_id = $3::uuid)
         AND ($4::text IS NULL OR curriculum_version = $4::text)
       ORDER BY ts_rank_cd(tsv_content, to_tsquery('simple', $5)) DESC
       LIMIT $6
     )
     SELECT coalesce(v.id, t.id) AS chunk_id,
            coalesce(v.content, t.content) AS content,
            coalesce(v.source_name, t.source_name) AS source_name,
            coalesce(v.page_number, t.page_number) AS page_number,
            coalesce(v.subject_id, t.subject_id) AS subject_id,
            coalesce(v.topic_id, t.topic_id) AS topic_id,
            coalesce(v.curriculum_version, t.curriculum_version) AS curriculum_version,
            coalesce(1.0 / (60 + v.rank), 0.0) + coalesce(1.0 / (60 + t.rank), 0.0) AS rrf_score
     FROM vector_matches v
     FULL OUTER JOIN text_matches t ON v.id = t.id
     ORDER BY rrf_score DESC
     LIMIT $7`,
    [vector, params.subjectId ?? null, params.topicId ?? null, params.curriculumVersion ?? null, lexicalQuery, candidateLimit, limit],
  );

  return result.rows.map((row) => ({
    chunkId: row.chunk_id,
    content: row.content,
    sourceName: row.source_name,
    pageNumber: row.page_number,
    subjectId: row.subject_id,
    topicId: row.topic_id,
    curriculumVersion: row.curriculum_version,
    finalScore: Number(row.rrf_score),
  }));
}
