ALTER TABLE nabaha_question_bank.document_chunks
  ADD COLUMN IF NOT EXISTS chunk_index INTEGER,
  ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100),
  ADD COLUMN IF NOT EXISTS embedding_dimensions SMALLINT,
  ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_source_position_uidx
  ON nabaha_question_bank.document_chunks(source_document_id, chunk_index)
  WHERE source_document_id IS NOT NULL AND chunk_index IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS questions_source_internal_uidx
  ON nabaha_question_bank.questions(source_internal)
  WHERE source_internal IS NOT NULL;

CREATE TABLE IF NOT EXISTS nabaha_question_bank.concept_mastery (
  student_id UUID NOT NULL REFERENCES nabaha_question_bank.student_profiles(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES nabaha_question_bank.concepts(id) ON DELETE CASCADE,
  mastery_score NUMERIC(5,4) NOT NULL DEFAULT 0.5000 CHECK (mastery_score BETWEEN 0 AND 1),
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0.1000 CHECK (confidence BETWEEN 0 AND 1),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count BETWEEN 0 AND attempt_count),
  last_practiced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(student_id, concept_id)
);

CREATE INDEX IF NOT EXISTS concept_mastery_student_score_idx
  ON nabaha_question_bank.concept_mastery(student_id, mastery_score, updated_at DESC);
