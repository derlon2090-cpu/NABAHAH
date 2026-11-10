import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local" });
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
const seedUrl = new URL("../seed/golden-physics-motion.json", import.meta.url);
const raw = await readFile(seedUrl, "utf8");
const seed = JSON.parse(raw);
const schema = "nabaha_question_bank";
const client = new pg.Client({ connectionString });

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('nabaha_golden_seed'))");
  const subject = await client.query(`SELECT id FROM ${schema}.subjects WHERE slug=$1`, [seed.subject]);
  if (!subject.rowCount) throw new Error(`Unknown subject: ${seed.subject}`);
  const topic = await client.query(
    `INSERT INTO ${schema}.topics(subject_id,name_ar) VALUES($1,$2)
     ON CONFLICT(subject_id,name_ar) DO UPDATE SET name_ar=excluded.name_ar RETURNING id`,
    [subject.rows[0].id, seed.topic],
  );
  const concepts = new Map();
  for (const name of [...new Set(seed.questions.map((question) => question.concept))]) {
    const result = await client.query(
      `INSERT INTO ${schema}.concepts(topic_id,name_ar) VALUES($1,$2)
       ON CONFLICT(topic_id,name_ar) DO UPDATE SET name_ar=excluded.name_ar RETURNING id`,
      [topic.rows[0].id, name],
    );
    concepts.set(name, result.rows[0].id);
  }
  const objectKey = `seed/${seed.version}.json`;
  const extractedText = seed.chunks.map((chunk) => chunk.content).join("\n\n");
  const document = await client.query(
    `INSERT INTO ${schema}.source_documents(object_key,original_filename,content_type,byte_size,sha256,rights_status,processing_status,extracted_text,uploaded_by)
     VALUES($1,$2,'application/json',$3,$4,$5,'pending_review',$6,'golden_seed')
     ON CONFLICT(object_key) DO UPDATE SET original_filename=excluded.original_filename,byte_size=excluded.byte_size,sha256=excluded.sha256,rights_status=excluded.rights_status,extracted_text=excluded.extracted_text,updated_at=now()
     RETURNING id`,
    [objectKey, `${seed.version}.json`, Buffer.byteLength(raw), createHash("sha256").update(raw).digest("hex"), seed.rights, extractedText],
  );
  for (let index = 0; index < seed.chunks.length; index++) {
    const chunk = seed.chunks[index];
    await client.query(
      `INSERT INTO ${schema}.document_chunks(source_document_id,subject_id,topic_id,curriculum_version,source_name,page_number,chunk_index,content,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(source_document_id,chunk_index) WHERE source_document_id IS NOT NULL AND chunk_index IS NOT NULL
       DO UPDATE SET subject_id=excluded.subject_id,topic_id=excluded.topic_id,curriculum_version=excluded.curriculum_version,source_name=excluded.source_name,page_number=excluded.page_number,content=excluded.content,metadata=excluded.metadata,embedding=NULL,embedding_model=NULL,embedding_dimensions=NULL,embedding_updated_at=NULL`,
      [document.rows[0].id, subject.rows[0].id, topic.rows[0].id, seed.curriculumVersion, seed.title, chunk.pageNumber, index + 1, chunk.content, JSON.stringify({ seed: seed.version, rights: seed.rights, review_status: "approved" })],
    );
  }
  for (const question of seed.questions) {
    const sourceInternal = `golden_seed:${seed.version}:${question.id}`;
    const saved = await client.query(
      `INSERT INTO ${schema}.questions(subject_id,topic_id,concept_id,source_document_id,source_internal,prompt,question_type,difficulty,status,created_by,reviewed_by,approved_by)
       VALUES($1,$2,$3,$4,$5,$6,'multiple_choice',$7,'approved','golden_seed','golden_seed','golden_seed')
       ON CONFLICT(source_internal) WHERE source_internal IS NOT NULL
       DO UPDATE SET subject_id=excluded.subject_id,topic_id=excluded.topic_id,concept_id=excluded.concept_id,source_document_id=excluded.source_document_id,prompt=excluded.prompt,difficulty=excluded.difficulty,status='approved',updated_at=now(),reviewed_by='golden_seed',approved_by='golden_seed'
       RETURNING id`,
      [subject.rows[0].id, topic.rows[0].id, concepts.get(question.concept), document.rows[0].id, sourceInternal, question.prompt, question.difficulty],
    );
    await client.query(`DELETE FROM ${schema}.question_choices WHERE question_id=$1`, [saved.rows[0].id]);
    for (const [key, text] of Object.entries(question.choices)) {
      await client.query(`INSERT INTO ${schema}.question_choices(question_id,choice_key,choice_text,is_correct) VALUES($1,$2,$3,$4)`, [saved.rows[0].id, key, text, key === question.correct]);
    }
    await client.query(
      `INSERT INTO ${schema}.question_solutions(question_id,correct_answer,solution,explanation)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(question_id) DO UPDATE SET correct_answer=excluded.correct_answer,solution=excluded.solution,explanation=excluded.explanation,updated_at=now()`,
      [saved.rows[0].id, question.correct, question.solution, question.explanation],
    );
  }
  await client.query("COMMIT");
  console.log(`Seeded ${seed.chunks.length} approved chunks and ${seed.questions.length} original practice questions.`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(error instanceof Error ? error.message : "Golden seed failed");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
