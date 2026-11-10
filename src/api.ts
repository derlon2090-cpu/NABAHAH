import pg from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createHash, randomUUID } from "node:crypto";
import { classifyIntent } from "./intent-router.mjs";
import { aiConfigured, embedText, generateStructuredSolution } from "./services/ai.service.ts";
import { hybridRetrieve } from "./services/retrieval.service.ts";
import { sseResponse, type SSEWriter } from "./services/sse.ts";
import { nextMastery } from "./services/mastery.service.mjs";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 10_000 });
const schema = "nabaha_question_bank";
const authBase = process.env.NEON_AUTH_BASE_URL;
const jwksUrl = process.env.NEON_AUTH_JWKS_URL;
const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;
const issuer = authBase ? new URL(authBase).origin : undefined;
const r2Ready = Boolean(process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
const s3 = r2Ready ? new S3Client({
  region: "auto", endpoint: process.env.R2_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
}) : null;
const bucket = process.env.R2_BUCKET_NAME;
const subjects = ["mathematics", "physics", "chemistry", "biology"] as const;
const behaviors = ["general_conversation", "tahsili_reasoning", "question_solving", "explanation", "follow_up", "quiz_interaction", "study_assistance", "graceful_refusal"] as const;
const firstAdminEmail = "nabahah.official@gmail.com";
const corsOrigin = process.env.CORS_ALLOWED_ORIGIN ?? "*";
const allowUngroundedAnswers = process.env.ALLOW_UNGROUNDED_ANSWERS === "true";
const localE2eUserId = process.env.NODE_ENV === "production" ? undefined : process.env.NABAHA_LOCAL_E2E_USER_ID;
const localE2eToken = process.env.NODE_ENV === "production" ? undefined : process.env.NABAHA_LOCAL_E2E_TOKEN;

function response(body: unknown, status = 200, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": corsOrigin, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", ...extra } });
}
function safeError(status: number, error: string) { return response({ error }, status); }
async function principal(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const hostname = new URL(request.url).hostname;
  if (localE2eUserId && localE2eToken && token === localE2eToken && (hostname === "127.0.0.1" || hostname === "localhost")) {
    return { id: localE2eUserId };
  }
  if (!token || !jwks || !issuer) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer });
    return typeof payload.sub === "string" ? { id: payload.sub } : null;
  } catch { return null; }
}
async function admin(request: Request) {
  const user = await principal(request);
  if (!user) return { user: null, admin: false };
  try {
    const result = await pool.query(`SELECT 1 FROM ${schema}.nabaha_admin_users WHERE auth_user_id=$1`, [user.id]);
    return { user, admin: result.rowCount === 1 };
  } catch { return { user, admin: false }; }
}
function json(request: Request) { return request.json().catch(() => null) as Promise<Record<string, any> | null>; }
function cleanText(value: unknown, max = 20_000) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }

function inferredSubject(message: string) {
  if (/رياضيات|جبر|هندس|تفاضل|تكامل|دالة|معادلة/u.test(message)) return "mathematics";
  if (/فيزياء|سرعة|تسارع|قوة|طاقة|كهرباء|موج/u.test(message)) return "physics";
  if (/كيمياء|عنصر|ذرة|مول|تفاعل|اتزان/u.test(message)) return "chemistry";
  if (/أحياء|احياء|خلية|وراثة|جهاز|كائن/u.test(message)) return "biology";
  return null;
}

function emitSolution(writer: SSEWriter, solution: any) {
  writer.emit("metadata", { subject: solution.subject, topic: solution.topic, difficulty: solution.difficulty, grounding: solution.grounding, warning: solution.warning });
  for (const section of ["givens", "unknowns"] as const) {
    writer.emit("section_start", { section });
    solution[section].forEach((text: string, index: number) => writer.emit("text_delta", { section, index, delta: text }));
  }
  writer.emit("section_start", { section: "formulas" });
  solution.formulas.forEach((formula: any) => writer.emit("formula", formula));
  writer.emit("section_start", { section: "steps" });
  solution.steps.forEach((step: any, index: number) => {
    writer.emit("text_delta", { section: "steps", index, title: step.title, delta: step.explanation });
    if (step.latex) writer.emit("formula", { latex: step.latex, description: step.title, section: "steps", index });
  });
  writer.emit("section_start", { section: "finalAnswer" });
  writer.emit("text_delta", { section: "finalAnswer", delta: solution.finalAnswer });
  if (solution.shortcutTip) {
    writer.emit("section_start", { section: "shortcutTip" });
    writer.emit("text_delta", { section: "shortcutTip", delta: solution.shortcutTip });
  }
  solution.citations.forEach((citation: any) => writer.emit("citation", citation));
}

async function prepareConversation(userId: string, body: Record<string, any>, message: string) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    let conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    if (conversationId) {
      const owned = await db.query(`SELECT id FROM ${schema}.conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [conversationId, userId]);
      if (!owned.rowCount) throw new Error("conversation_not_found");
    } else {
      const created = await db.query(`INSERT INTO ${schema}.conversations(owner_id) VALUES($1) RETURNING id`, [userId]);
      conversationId = created.rows[0].id;
    }
    const intent = classifyIntent(message, Boolean(body.conversationId));
    await db.query(`INSERT INTO ${schema}.conversation_messages(conversation_id,role,content,behavior) VALUES($1,'user',$2,$3)`, [conversationId, message, intent.behavior]);
    await db.query("COMMIT");
    return { conversationId: conversationId as string, intent };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

async function streamChat(writer: SSEWriter, userId: string, body: Record<string, any>, message: string) {
  const started = Date.now();
  const { conversationId, intent } = await prepareConversation(userId, body, message);
  if (intent.behavior === "graceful_refusal") {
    const refusal = "أنا مساعد نباهة المخصص لاختبار التحصيلي. يسعدني مساعدتك في الرياضيات أو الفيزياء أو الكيمياء أو الأحياء.";
    writer.emit("metadata", { subject: "general", topic: "scope", difficulty: "easy" });
    writer.emit("text_delta", { section: "finalAnswer", delta: refusal });
    const saved = await pool.query(`INSERT INTO ${schema}.conversation_messages(conversation_id,role,content,behavior) VALUES($1,'assistant',$2,$3) RETURNING id`, [conversationId, refusal, intent.behavior]);
    writer.emit("completed", { conversationId, messageId: String(saved.rows[0].id), status: "flagged" });
    return;
  }

  const subjectSlug = inferredSubject(message);
  const subject = subjectSlug ? await pool.query(`SELECT id FROM ${schema}.subjects WHERE slug=$1`, [subjectSlug]) : null;
  const vector = await embedText(message).catch(() => null);
  const contexts = await hybridRetrieve(pool, {
    queryText: message,
    queryVector: vector,
    subjectId: subject?.rows[0]?.id ?? null,
    limit: 5,
  }).catch(() => []);

  let assistantText: string;
  let citations: any[] = [];
  let model = aiConfigured() ? process.env.AI_MODEL ?? "configured-model" : "retrieval-only";
  let usage = { prompt: 0, completion: 0 };
  let validationStatus = "passed";
  if (aiConfigured() && (contexts.length || allowUngroundedAnswers)) {
    try {
      const generated = await generateStructuredSolution(message, contexts, { allowGeneralKnowledge: allowUngroundedAnswers, subject: subjectSlug });
      emitSolution(writer, generated.solution);
      assistantText = JSON.stringify(generated.solution);
      citations = generated.solution.citations;
      model = generated.model;
      usage = generated.usage;
      validationStatus = generated.validationStatus;
    } catch {
      validationStatus = "failed";
      assistantText = "تعذر التحقق من حل موثّق لهذا السؤال. حاول إعادة صياغته أو إضافة صورة أوضح.";
      writer.emit("text_delta", { section: "finalAnswer", delta: assistantText });
    }
  } else if (contexts.length) {
    const first = contexts[0];
    assistantText = `وجدت مرجعًا ذا صلة من ${first.sourceName}${first.pageNumber ? `، الصفحة ${first.pageNumber}` : ""}. يلزم تفعيل نموذج الحل المنظم لإكمال الشرح.`;
    citations = [{ sourceId: first.chunkId, sourceName: first.sourceName, page: first.pageNumber }];
    writer.emit("metadata", { subject: subjectSlug ?? "general", topic: "retrieval", difficulty: "medium" });
    writer.emit("text_delta", { section: "finalAnswer", delta: assistantText });
    writer.emit("citation", citations[0]);
  } else {
    assistantText = "لم أجد مرجعًا معتمدًا كافيًا للإجابة دون تخمين. جرّب تحديد المادة أو رفع صورة السؤال.";
    validationStatus = "adjusted";
    writer.emit("metadata", { subject: subjectSlug ?? "general", topic: "no_context", difficulty: "medium" });
    writer.emit("text_delta", { section: "finalAnswer", delta: assistantText });
  }

  const saved = await pool.query(`INSERT INTO ${schema}.conversation_messages(conversation_id,role,content,behavior) VALUES($1,'assistant',$2,$3) RETURNING id`, [conversationId, assistantText, intent.behavior]);
  await pool.query(`INSERT INTO ${schema}.ai_generation_runs(conversation_id,message_id,model_name,latency_ms,tokens_prompt,tokens_completion,citations,validation_status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [conversationId, saved.rows[0].id, model, Date.now() - started, usage.prompt, usage.completion, JSON.stringify(citations), validationStatus]).catch(() => undefined);
  writer.emit("completed", { conversationId, messageId: String(saved.rows[0].id), status: validationStatus === "failed" ? "flagged" : "ok" });
}

async function recordAttempt(userId: string, body: Record<string, any>) {
  const questionId = cleanText(body.questionId, 36);
  const selectedOption = cleanText(body.selectedOption, 1).toUpperCase();
  const timeSpentMs = Number(body.timeSpentMs);
  const assistanceLevel = ["none", "hint_used", "full_solution"].includes(body.assistanceLevel) ? body.assistanceLevel : "none";
  if (!/^[0-9a-f-]{36}$/i.test(questionId) || !/^[A-D]$/.test(selectedOption) || !Number.isInteger(timeSpentMs) || timeSpentMs < 0 || timeSpentMs > 3_600_000) return safeError(400,"invalid_attempt");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const student = await db.query(`INSERT INTO ${schema}.student_profiles(auth_user_id) VALUES($1) ON CONFLICT(auth_user_id) DO UPDATE SET updated_at=now() RETURNING id`, [userId]);
    const question = await db.query(
      `SELECT q.id,q.concept_id,q.difficulty,max(c.choice_key) FILTER(WHERE c.is_correct) correct_option
       FROM ${schema}.questions q LEFT JOIN ${schema}.question_choices c ON c.question_id=q.id
       WHERE q.id=$1 AND q.status='approved' GROUP BY q.id`,
      [questionId],
    );
    if (!question.rowCount || !question.rows[0].concept_id || !question.rows[0].correct_option) { await db.query("ROLLBACK"); return safeError(404,"question_not_trackable"); }
    const isCorrect = selectedOption === question.rows[0].correct_option;
    await db.query(
      `INSERT INTO ${schema}.student_attempts(student_id,question_id,concept_id,is_correct,time_spent_ms,assistance_level,selected_option)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [student.rows[0].id, questionId, question.rows[0].concept_id, isCorrect, timeSpentMs, assistanceLevel, selectedOption],
    );
    const current = await db.query(`SELECT mastery_score,attempt_count,correct_count FROM ${schema}.concept_mastery WHERE student_id=$1 AND concept_id=$2 FOR UPDATE`, [student.rows[0].id, question.rows[0].concept_id]);
    const next = nextMastery({ currentScore: Number(current.rows[0]?.mastery_score ?? 0.5), isCorrect, difficulty: question.rows[0].difficulty, assistanceLevel, timeSpentMs, attemptCount: current.rows[0]?.attempt_count ?? 0 });
    const mastery = await db.query(
      `INSERT INTO ${schema}.concept_mastery(student_id,concept_id,mastery_score,confidence,attempt_count,correct_count,last_practiced_at)
       VALUES($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT(student_id,concept_id) DO UPDATE SET mastery_score=excluded.mastery_score,confidence=excluded.confidence,attempt_count=excluded.attempt_count,correct_count=${schema}.concept_mastery.correct_count+$6,last_practiced_at=now(),updated_at=now()
       RETURNING mastery_score,confidence,attempt_count,correct_count`,
      [student.rows[0].id, question.rows[0].concept_id, next.masteryScore, next.confidence, next.attemptCount, isCorrect ? 1 : 0],
    );
    await db.query("COMMIT");
    return response({ isCorrect, correctOption: question.rows[0].correct_option, conceptId: question.rows[0].concept_id, mastery: mastery.rows[0] }, 201);
  } catch {
    await db.query("ROLLBACK").catch(() => undefined);
    return safeError(500,"attempt_unavailable");
  } finally {
    db.release();
  }
}

async function masteryOverview(userId: string) {
  const result = await pool.query(
    `SELECT s.slug subject,t.name_ar topic,c.id concept_id,c.name_ar concept,m.mastery_score,m.confidence,m.attempt_count,m.correct_count,m.last_practiced_at
     FROM ${schema}.student_profiles p JOIN ${schema}.concept_mastery m ON m.student_id=p.id
     JOIN ${schema}.concepts c ON c.id=m.concept_id JOIN ${schema}.topics t ON t.id=c.topic_id JOIN ${schema}.subjects s ON s.id=t.subject_id
     WHERE p.auth_user_id=$1 ORDER BY m.mastery_score,c.name_ar`,
    [userId],
  );
  return response({ concepts: result.rows });
}

async function health() {
  const states: Record<string, "ok" | "error"> = { database: "error", auth: "error", storage: "error" };
  try { await pool.query("SELECT 1"); states.database = "ok"; } catch { /* deliberately no details */ }
  try {
    if (jwksUrl) {
      const r = await fetch(jwksUrl, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
      const body = await r.json() as { keys?: unknown[] };
      if (r.ok && Array.isArray(body.keys) && body.keys.length) states.auth = "ok";
    }
  } catch { /* deliberately no details */ }
  try { if (s3 && bucket) { await s3.send(new HeadBucketCommand({ Bucket: bucket })); states.storage = "ok"; } } catch { /* deliberately no details */ }
  const allOk = Object.values(states).every((value) => value === "ok");
  return response(states, allOk ? 200 : 503);
}

async function approvedQuestions(url: URL) {
  const subject = url.searchParams.get("subject");
  if (subject && !subjects.includes(subject as typeof subjects[number])) return safeError(400, "invalid_subject");
  const result = await pool.query(
    `SELECT q.id, s.slug AS subject, q.prompt, q.difficulty, q.question_type,
      COALESCE(json_agg(json_build_object('key',c.choice_key,'text',c.choice_text) ORDER BY c.choice_key) FILTER (WHERE c.id IS NOT NULL), '[]') AS choices
     FROM ${schema}.questions q JOIN ${schema}.subjects s ON s.id=q.subject_id
     LEFT JOIN ${schema}.question_choices c ON c.question_id=q.id
     WHERE q.status='approved' AND ($1::text IS NULL OR s.slug=$1)
     GROUP BY q.id,s.slug ORDER BY q.created_at DESC LIMIT 100`, [subject]);
  return response({ questions: result.rows });
}

function retrievalTokens(value: string) {
  const stop=new Set(["بنك","الأسئلة","الاسئلة","سؤال","معتمد","معتمدة","اعطني","أعطني","عطني","اختبرني","من","في","على","عن","ما","هل"]);
  return value.toLocaleLowerCase("ar").replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/u).filter((x)=>x.length>=3&&!stop.has(x)).slice(0,10);
}
async function retrieveApproved(query: string, limit: number) {
  const tokens=retrievalTokens(query);
  if(!tokens.length)return [];
  const found=await pool.query(`SELECT q.id,s.slug AS subject,q.prompt,q.difficulty,q.question_type,sol.correct_answer,sol.solution,sol.explanation,
      COALESCE(json_agg(json_build_object('key',c.choice_key,'text',c.choice_text) ORDER BY c.choice_key) FILTER(WHERE c.id IS NOT NULL),'[]') AS choices,
      (SELECT count(*)::int FROM unnest($1::text[]) term WHERE concat_ws(' ',q.prompt,sol.solution,sol.explanation) ILIKE '%'||term||'%') AS relevance
    FROM ${schema}.questions q JOIN ${schema}.subjects s ON s.id=q.subject_id
    LEFT JOIN ${schema}.question_solutions sol ON sol.question_id=q.id LEFT JOIN ${schema}.question_choices c ON c.question_id=q.id
    WHERE q.status='approved' AND EXISTS(SELECT 1 FROM unnest($1::text[]) term WHERE concat_ws(' ',q.prompt,sol.solution,sol.explanation) ILIKE '%'||term||'%')
    GROUP BY q.id,s.slug,sol.correct_answer,sol.solution,sol.explanation ORDER BY relevance DESC,q.created_at DESC LIMIT $2`,[tokens,limit]);
  return found.rows;
}

async function adminRoute(request: Request, url: URL, actor: {id:string}) {
  const path = url.pathname;
  const validRights = ["owned","licensed","permission","public_domain","unknown"];
  if (path === "/api/admin/catalog" && request.method === "GET") {
    const result = await pool.query(`SELECT s.slug,s.name_ar AS subject,t.id AS topic_id,t.name_ar AS topic,c.id AS concept_id,c.name_ar AS concept FROM ${schema}.subjects s LEFT JOIN ${schema}.topics t ON t.subject_id=s.id LEFT JOIN ${schema}.concepts c ON c.topic_id=t.id ORDER BY s.name_ar,t.name_ar,c.name_ar`);
    return response({ catalog: result.rows });
  }
  if (path === "/api/admin/catalog/topics" && request.method === "POST") {
    const body=await json(request);
    if (!body || !subjects.includes(body.subject) || !cleanText(body.name,120)) return safeError(400,"invalid_topic");
    const result=await pool.query(`INSERT INTO ${schema}.topics(subject_id,name_ar) SELECT id,$2 FROM ${schema}.subjects WHERE slug=$1 ON CONFLICT(subject_id,name_ar) DO UPDATE SET name_ar=EXCLUDED.name_ar RETURNING id,name_ar`,[body.subject,cleanText(body.name,120)]);
    return response({topic:result.rows[0]},201);
  }
  if (path === "/api/admin/catalog/concepts" && request.method === "POST") {
    const body=await json(request);
    if (!body || !/^[0-9a-f-]{36}$/i.test(body.topic_id||"") || !cleanText(body.name,120)) return safeError(400,"invalid_concept");
    const result=await pool.query(`INSERT INTO ${schema}.concepts(topic_id,name_ar) VALUES($1,$2) ON CONFLICT(topic_id,name_ar) DO UPDATE SET name_ar=EXCLUDED.name_ar RETURNING id,name_ar`,[body.topic_id,cleanText(body.name,120)]);
    return response({concept:result.rows[0]},201);
  }
  if (path === "/api/admin/documents" && request.method === "GET") {
    const rows = await pool.query(`SELECT id,original_filename,byte_size,rights_status,processing_status,created_at FROM ${schema}.source_documents ORDER BY created_at DESC LIMIT 100`);
    return response({ documents: rows.rows });
  }
  const textMatch = path.match(/^\/api\/admin\/documents\/([0-9a-f-]+)\/text$/i);
  if (textMatch && request.method === "GET") {
    const result = await pool.query(`SELECT id,original_filename,processing_status,extracted_text FROM ${schema}.source_documents WHERE id=$1`, [textMatch[1]]);
    if (!result.rowCount) return safeError(404,"not_found");
    return response({ document: result.rows[0] });
  }
  if (path === "/api/admin/documents" && request.method === "POST") {
    if (!s3 || !bucket) return safeError(503, "storage_unavailable");
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || file.size < 8 || file.size > 25 * 1024 * 1024) return safeError(400, "invalid_pdf");
    const rights=String(form?.get("rights")??"unknown");
    if (!validRights.includes(rights)) return safeError(400,"invalid_rights_status");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return safeError(400, "invalid_pdf");
    const objectKey = `sources/${randomUUID()}.pdf`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: "application/pdf", Metadata: { sha256 } }));
      const saved = await pool.query(`INSERT INTO ${schema}.source_documents (object_key,original_filename,byte_size,sha256,rights_status,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,original_filename,byte_size,rights_status,processing_status,created_at`, [objectKey, file.name.slice(0, 255), file.size, sha256, rights, actor.id]);
      return response({ document: saved.rows[0] }, 201);
    } catch { return safeError(503, "upload_unavailable"); }
  }
  const extractMatch = path.match(/^\/api\/admin\/documents\/([0-9a-f-]+)\/extract$/i);
  if (extractMatch && request.method === "POST") {
    if (!s3 || !bucket) return safeError(503, "storage_unavailable");
    const input = await json(request);
    if (!input || !subjects.includes(input.subject)) return safeError(400,"subject_required");
    const claim = await pool.query(`UPDATE ${schema}.source_documents SET processing_status='extracting',updated_at=now() WHERE id=$1 AND rights_status<>'unknown' AND processing_status IN ('uploaded','failed') RETURNING id,object_key,original_filename`, [extractMatch[1]]);
    if (!claim.rowCount) {
      const exists=await pool.query(`SELECT rights_status,processing_status FROM ${schema}.source_documents WHERE id=$1`,[extractMatch[1]]);
      if(!exists.rowCount)return safeError(404,"not_found");
      if(exists.rows[0].rights_status==="unknown")return safeError(409,"rights_review_required");
      return safeError(409,"extraction_already_running_or_complete");
    }
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: claim.rows[0].object_key }));
      const bytes = new Uint8Array(await obj.Body!.transformToByteArray());
      const pdf = await getDocument({ data: bytes }).promise;
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        pages.push(content.items.map((item: any) => "str" in item ? item.str : "").join(" "));
      }
      const extracted = pages.join("\n\n").replace(/\r/g,"").replace(/[\t ]+/g," ").replace(/\n{3,}/g,"\n\n").slice(0, 2_000_000).trim();
      const chunks: string[]=[];
      const ragChunks: Array<{pageNumber:number;content:string}>=[];
      for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
        const normalizedPage=pages[pageIndex].replace(/\r/g,"").replace(/[\t ]+/g," ").trim();
        for(const paragraph of normalizedPage.split(/\n{2,}/).map(x=>x.trim()).filter(x=>x.length>=50)){
          for(let start=0;start<paragraph.length;start+=1800){
            const part=paragraph.slice(start,start+1800).trim();
            if(part.length>=50){chunks.push(part);ragChunks.push({pageNumber:pageIndex+1,content:part});}
            if(chunks.length>=300)break;
          }
          if(chunks.length>=300)break;
        }
        if(chunks.length>=300)break;
      }
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query(`UPDATE ${schema}.source_documents SET extracted_text=$2,processing_status='pending_review',updated_at=now() WHERE id=$1`, [claim.rows[0].id, extracted]);
        const subjectRow=await client.query(`SELECT id FROM ${schema}.subjects WHERE slug=$1`,[input.subject]);
        await client.query(`DELETE FROM ${schema}.document_chunks WHERE source_document_id=$1`,[claim.rows[0].id]);
        for(const chunk of ragChunks){
          await client.query(`INSERT INTO ${schema}.document_chunks(source_document_id,subject_id,source_name,page_number,content,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[claim.rows[0].id,subjectRow.rows[0].id,claim.rows[0].original_filename,chunk.pageNumber,chunk.content,JSON.stringify({extraction:"pdfjs",review_status:"pending"})]);
        }
        for(let i=0;i<chunks.length;i++){
          const saved=await client.query(`INSERT INTO ${schema}.questions(subject_id,source_document_id,source_internal,prompt,question_type,difficulty,status,created_by) VALUES($1,$2,$3,$4,'multiple_choice',1,'pending',$5) RETURNING id`,[subjectRow.rows[0].id,claim.rows[0].id,`extracted_chunk:${claim.rows[0].id}:${i+1}`,chunks[i],actor.id]);
          await client.query(`INSERT INTO ${schema}.question_solutions(question_id,correct_answer,solution,explanation) VALUES($1,'','','')`,[saved.rows[0].id]);
        }
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
      return response({ id: claim.rows[0].id, processing_status: "pending_review", extracted_characters: extracted.length, pending_items: chunks.length, rag_chunks: ragChunks.length });
    } catch {
      await pool.query(`UPDATE ${schema}.source_documents SET processing_status='failed',updated_at=now() WHERE id=$1 AND processing_status='extracting'`, [claim.rows[0].id]).catch(() => undefined);
      return safeError(422, "extraction_failed");
    }
  }
  if (path === "/api/admin/questions" && request.method === "GET") {
    const result = await pool.query(`SELECT q.*, s.slug AS subject, d.original_filename AS source_filename, sol.correct_answer,sol.solution,sol.explanation,
      COALESCE(json_agg(json_build_object('key',c.choice_key,'text',c.choice_text,'correct',c.is_correct) ORDER BY c.choice_key) FILTER (WHERE c.id IS NOT NULL),'[]') AS choices
      FROM ${schema}.questions q JOIN ${schema}.subjects s ON s.id=q.subject_id LEFT JOIN ${schema}.source_documents d ON d.id=q.source_document_id
      LEFT JOIN ${schema}.question_solutions sol ON sol.question_id=q.id LEFT JOIN ${schema}.question_choices c ON c.question_id=q.id
      WHERE q.status IN ('pending','reviewed') GROUP BY q.id,s.slug,d.original_filename,sol.correct_answer,sol.solution,sol.explanation ORDER BY q.created_at LIMIT 100`);
    return response({ questions: result.rows });
  }
  if (path === "/api/admin/questions" && request.method === "POST") {
    const body = await json(request);
    if (!body || !subjects.includes(body.subject) || !cleanText(body.prompt) || !Number.isInteger(body.difficulty) || body.difficulty < 1 || body.difficulty > 5) return safeError(400, "invalid_question");
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const inserted = await db.query(`INSERT INTO ${schema}.questions (subject_id,topic_id,concept_id,prompt,difficulty,question_type,source_internal,source_document_id,created_by) SELECT id,$8,$9,$2,$3,$4,$5,$6,$7 FROM ${schema}.subjects WHERE slug=$1 RETURNING id`, [body.subject,cleanText(body.prompt),body.difficulty,body.question_type === "free_response" ? "free_response" : "multiple_choice",cleanText(body.source_internal,1000)||null,body.source_document_id||null,actor.id,body.topic_id||null,body.concept_id||null]);
      if (!inserted.rowCount) throw new Error("bad subject");
      await db.query(`INSERT INTO ${schema}.question_solutions(question_id,correct_answer,solution,explanation) VALUES($1,$2,$3,$4)`, [inserted.rows[0].id,cleanText(body.correct_answer,200),cleanText(body.solution),cleanText(body.explanation)]);
      await replaceChoices(db, inserted.rows[0].id, body.choices);
      await db.query("COMMIT");
      return response({ id: inserted.rows[0].id, status: "pending" }, 201);
    } catch { await db.query("ROLLBACK"); return safeError(400, "invalid_question"); } finally { db.release(); }
  }
  const questionMatch = path.match(/^\/api\/admin\/questions\/([0-9a-f-]+)$/i);
  if (questionMatch && request.method === "PATCH") {
    const body = await json(request);
    if (!body) return safeError(400,"invalid_question");
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const existing = await db.query(`SELECT id FROM ${schema}.questions WHERE id=$1 AND status IN ('pending','reviewed') FOR UPDATE`, [questionMatch[1]]);
      if (!existing.rowCount) { await db.query("ROLLBACK"); return safeError(404,"not_found"); }
      if (body.subject && !subjects.includes(body.subject)) throw new Error("subject");
      await db.query(`UPDATE ${schema}.questions q SET prompt=COALESCE($2,q.prompt),difficulty=COALESCE($3,q.difficulty),subject_id=COALESCE((SELECT id FROM ${schema}.subjects WHERE slug=$4),q.subject_id),topic_id=COALESCE($5,q.topic_id),concept_id=COALESCE($6,q.concept_id),source_internal=COALESCE($7,q.source_internal),updated_at=now(),status=CASE WHEN $8::boolean THEN 'approved' ELSE 'reviewed' END,reviewed_by=$9,approved_by=CASE WHEN $8::boolean THEN $9 ELSE q.approved_by END WHERE id=$1`, [questionMatch[1],body.prompt===undefined?null:cleanText(body.prompt),body.difficulty??null,body.subject??null,body.topic_id??null,body.concept_id??null,body.source_internal===undefined?null:cleanText(body.source_internal,1000),body.approve===true,actor.id]);
      if (body.correct_answer !== undefined || body.solution !== undefined || body.explanation !== undefined) await db.query(`INSERT INTO ${schema}.question_solutions(question_id,correct_answer,solution,explanation) VALUES($1,$2,$3,$4) ON CONFLICT(question_id) DO UPDATE SET correct_answer=EXCLUDED.correct_answer,solution=EXCLUDED.solution,explanation=EXCLUDED.explanation,updated_at=now()`, [questionMatch[1],cleanText(body.correct_answer,200),cleanText(body.solution),cleanText(body.explanation)]);
      if (body.choices !== undefined) await replaceChoices(db, questionMatch[1], body.choices);
      if (body.approve === true) {
        const check = await db.query(`SELECT q.question_type,q.prompt,s.correct_answer,s.explanation,count(c.id)::int choice_count,count(c.id) FILTER(WHERE c.is_correct)::int correct_count,max(c.choice_key) FILTER(WHERE c.is_correct) AS correct_key,(q.source_document_id IS NOT NULL OR NULLIF(q.source_internal,'') IS NOT NULL) AS source_valid,(q.topic_id IS NOT NULL AND q.concept_id IS NOT NULL AND EXISTS(SELECT 1 FROM ${schema}.topics t JOIN ${schema}.concepts cp ON cp.topic_id=t.id WHERE t.id=q.topic_id AND cp.id=q.concept_id AND t.subject_id=q.subject_id)) AS taxonomy_valid FROM ${schema}.questions q LEFT JOIN ${schema}.question_solutions s ON s.question_id=q.id LEFT JOIN ${schema}.question_choices c ON c.question_id=q.id WHERE q.id=$1 GROUP BY q.id,s.correct_answer,s.explanation`, [questionMatch[1]]);
        const q=check.rows[0];
        if (!q?.prompt?.trim() || !q.correct_answer?.trim() || !q.explanation?.trim() || !q.source_valid || !q.taxonomy_valid || (q.question_type === "multiple_choice" && (q.choice_count !== 4 || q.correct_count !== 1 || q.correct_answer !== q.correct_key))) throw new Error("incomplete");
      }
      await db.query("COMMIT");
      return response({ id: questionMatch[1], status: body.approve === true ? "approved" : "reviewed" });
    } catch { await db.query("ROLLBACK"); return safeError(400,"review_validation_failed"); } finally { db.release(); }
  }
  return safeError(404,"not_found");
}

async function replaceChoices(db: pg.PoolClient, questionId: string, choices: unknown) {
  if (!Array.isArray(choices)) return;
  if (choices.length !== 4 || choices.some((x) => !x || !["A","B","C","D"].includes(x.key) || !cleanText(x.text,2000))) throw new Error("choices");
  if (choices.filter((x) => x.correct === true).length !== 1) throw new Error("correct choice");
  await db.query(`DELETE FROM ${schema}.question_choices WHERE question_id=$1`,[questionId]);
  for (const c of choices) await db.query(`INSERT INTO ${schema}.question_choices(question_id,choice_key,choice_text,is_correct) VALUES($1,$2,$3,$4)`,[questionId,c.key,cleanText(c.text,2000),c.correct===true]);
}

export default { async fetch(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null,{status:204,headers:{"access-control-allow-origin":corsOrigin,"access-control-allow-headers":"authorization,content-type","access-control-allow-methods":"GET,POST,PATCH,OPTIONS"}});
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/health" && request.method === "GET") return await health();
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const user = await principal(request);
      if (!user) return safeError(401,"unauthorized");
      const body = await json(request);
      const message = cleanText(body?.message, 10_000);
      if (!message) return safeError(400,"invalid_message");
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        let conversationId = typeof body?.conversationId === "string" ? body.conversationId : null;
        let history: Array<{role:string;content:string}> = [];
        if (conversationId) {
          const owned = await db.query(`SELECT id FROM ${schema}.conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE`,[conversationId,user.id]);
          if (!owned.rowCount) { await db.query("ROLLBACK"); return safeError(404,"conversation_not_found"); }
          const prior = await db.query(`SELECT role,content FROM ${schema}.conversation_messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 20`,[conversationId]);
          history = prior.rows.reverse();
        } else {
          const created = await db.query(`INSERT INTO ${schema}.conversations(owner_id) VALUES($1) RETURNING id`,[user.id]);
          conversationId = created.rows[0].id;
        }
        const intent = classifyIntent(message,history.length>0);
        await db.query(`INSERT INTO ${schema}.conversation_messages(conversation_id,role,content,behavior) VALUES($1,'user',$2,$3)`,[conversationId,message,intent.behavior]);
        let question = null;
        if (intent.requiresBank) {
          const matches=await retrieveApproved(message,1);
          const match=matches[0];
          question = match ? {id:match.id,subject:match.subject,prompt:match.prompt,difficulty:match.difficulty,choices:match.choices} : null;
        }
        await db.query("COMMIT");
        return response({ conversationId, intent: intent.behavior, tool: intent.requiresBank ? "question_bank" : "none", question, next: intent.requiresBank ? (question ? "quiz_interaction" : "no_approved_question") : "conversational_model_not_configured", history: [...history.slice(-19),{role:"user",content:message}] });
      } catch { await db.query("ROLLBACK"); return safeError(500,"chat_unavailable"); } finally { db.release(); }
    }
    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
      const user = await principal(request);
      if (!user) return safeError(401,"unauthorized");
      const body = await json(request);
      const message = cleanText(body?.message, 10_000);
      if (!body || !message) return safeError(400,"invalid_message");
      return sseResponse((writer) => streamChat(writer, user.id, body, message), request.signal, corsOrigin);
    }
    if (url.pathname === "/api/attempts" && request.method === "POST") {
      const user = await principal(request);
      if (!user) return safeError(401,"unauthorized");
      const body = await json(request);
      if (!body) return safeError(400,"invalid_attempt");
      return await recordAttempt(user.id, body);
    }
    if (url.pathname === "/api/mastery" && request.method === "GET") {
      const user = await principal(request);
      if (!user) return safeError(401,"unauthorized");
      return await masteryOverview(user.id);
    }
    if (url.pathname === "/api/admin/bootstrap" && request.method === "POST") {
      const user = await principal(request);
      if (!user) return safeError(401,"unauthorized");
      const db=await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT pg_advisory_xact_lock(hashtext('nabaha_first_admin_bootstrap'))");
        const account=await db.query('SELECT email_verified FROM public."user" WHERE id=$1 AND lower(email)=lower($2) FOR UPDATE',[user.id,firstAdminEmail]);
        const existing=await db.query(`SELECT count(*)::int AS count FROM ${schema}.nabaha_admin_users`);
        if(account.rowCount!==1 || account.rows[0].email_verified!==true || existing.rows[0].count!==0) {
          await db.query("ROLLBACK");
          return safeError(403,"bootstrap_not_available");
        }
        await db.query(`INSERT INTO ${schema}.nabaha_admin_users(auth_user_id,granted_by) VALUES($1,'verified_first_admin') ON CONFLICT(auth_user_id) DO NOTHING`,[user.id]);
        await db.query("COMMIT");
        return response({status:"admin_granted"},201);
      } catch { await db.query("ROLLBACK"); return safeError(503,"bootstrap_unavailable"); } finally { db.release(); }
    }
    if (url.pathname === "/api/questions" && request.method === "GET") {
      if (!await principal(request)) return safeError(401,"unauthorized");
      return await approvedQuestions(url);
    }
    if (url.pathname === "/api/rag/search" && request.method === "GET") {
      if (!await principal(request)) return safeError(401,"unauthorized");
      const query=cleanText(url.searchParams.get("q"),1000);
      if(!query)return safeError(400,"query_required");
      const subjectSlug = url.searchParams.get("subject");
      const subject = subjectSlug ? await pool.query(`SELECT id FROM ${schema}.subjects WHERE slug=$1`, [subjectSlug]) : null;
      const vector = await embedText(query).catch(() => null);
      const chunks = await hybridRetrieve(pool, { queryText: query, queryVector: vector, subjectId: subject?.rows[0]?.id ?? null, limit: 5 }).catch(() => []);
      if (chunks.length) return response({ results: chunks, mode: vector ? "hybrid" : "full_text" });
      return response({results:await retrieveApproved(query,5), mode:"legacy_question_bank"});
    }
    if (url.pathname.startsWith("/api/admin/")) {
      const access = await admin(request);
      if (!access.user) return safeError(401,"unauthorized");
      if (!access.admin) return safeError(403,"forbidden");
      return await adminRoute(request,url,access.user);
    }
    return safeError(404,"not_found");
  } catch (error) {
    if (localE2eUserId) console.error("local_e2e_request_failed", error);
    return safeError(500,"internal_error");
  }
} };
