-- RAG, learner telemetry, and AI run tracking for Nabaha.
-- Existing domain tables live in nabaha_question_bank and are intentionally reused.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nabaha_question_bank.student_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id TEXT NOT NULL UNIQUE,
  grade_level SMALLINT CHECK (grade_level IN (1, 2, 3)),
  target_exam_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id UUID REFERENCES nabaha_question_bank.source_documents(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES nabaha_question_bank.subjects(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES nabaha_question_bank.topics(id) ON DELETE SET NULL,
  curriculum_version VARCHAR(50) NOT NULL DEFAULT '2025-2026',
  source_name VARCHAR(255) NOT NULL,
  page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
  content TEXT NOT NULL CHECK (length(btrim(content)) > 0),
  tsv_content TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_chunks_tsv_idx
  ON nabaha_question_bank.document_chunks USING GIN(tsv_content);
CREATE INDEX IF NOT EXISTS document_chunks_vector_idx
  ON nabaha_question_bank.document_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_chunks_taxonomy_idx
  ON nabaha_question_bank.document_chunks(subject_id, topic_id, curriculum_version);
CREATE INDEX IF NOT EXISTS document_chunks_source_idx
  ON nabaha_question_bank.document_chunks(source_document_id, page_number);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.question_embeddings (
  question_id UUID PRIMARY KEY REFERENCES nabaha_question_bank.questions(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  normalized_text TEXT NOT NULL CHECK (length(btrim(normalized_text)) > 0),
  embedding_model VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS question_embeddings_vector_idx
  ON nabaha_question_bank.question_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.student_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES nabaha_question_bank.student_profiles(id) ON DELETE CASCADE,
  question_id UUID REFERENCES nabaha_question_bank.questions(id) ON DELETE SET NULL,
  concept_id UUID REFERENCES nabaha_question_bank.concepts(id) ON DELETE SET NULL,
  is_correct BOOLEAN NOT NULL,
  time_spent_ms INTEGER NOT NULL CHECK (time_spent_ms >= 0),
  assistance_level VARCHAR(30) NOT NULL DEFAULT 'none'
    CHECK (assistance_level IN ('none', 'hint_used', 'full_solution')),
  selected_option TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_attempts_mastery_idx
  ON nabaha_question_bank.student_attempts(student_id, concept_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS student_attempts_question_idx
  ON nabaha_question_bank.student_attempts(question_id, attempted_at DESC);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.ai_generation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES nabaha_question_bank.conversations(id) ON DELETE CASCADE,
  message_id BIGINT REFERENCES nabaha_question_bank.conversation_messages(id) ON DELETE SET NULL,
  model_name VARCHAR(100) NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  tokens_prompt INTEGER NOT NULL DEFAULT 0 CHECK (tokens_prompt >= 0),
  tokens_completion INTEGER NOT NULL DEFAULT 0 CHECK (tokens_completion >= 0),
  cache_hit_type VARCHAR(30) NOT NULL DEFAULT 'none'
    CHECK (cache_hit_type IN ('none', 'retrieval', 'canonical', 'generation')),
  citations JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array'),
  validation_status VARCHAR(30) NOT NULL DEFAULT 'passed'
    CHECK (validation_status IN ('passed', 'failed', 'adjusted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_generation_runs_conversation_idx
  ON nabaha_question_bank.ai_generation_runs(conversation_id, created_at DESC);
