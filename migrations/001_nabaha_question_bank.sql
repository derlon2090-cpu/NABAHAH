-- Nabaha Tahsili bank. Isolated schema intentionally avoids pre-existing public.questions.
CREATE SCHEMA IF NOT EXISTS nabaha_question_bank;

CREATE TABLE IF NOT EXISTS nabaha_question_bank.subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES nabaha_question_bank.subjects(id),
  name_ar TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subject_id, name_ar)
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.concepts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES nabaha_question_bank.topics(id),
  name_ar TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(topic_id, name_ar)
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.source_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  rights_status TEXT NOT NULL DEFAULT 'unknown' CHECK (rights_status IN ('owned','licensed','permission','public_domain','unknown')),
  processing_status TEXT NOT NULL DEFAULT 'uploaded' CHECK (processing_status IN ('uploaded','extracting','pending_review','failed')),
  extracted_text TEXT,
  uploaded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES nabaha_question_bank.subjects(id),
  topic_id UUID REFERENCES nabaha_question_bank.topics(id),
  concept_id UUID REFERENCES nabaha_question_bank.concepts(id),
  source_document_id UUID REFERENCES nabaha_question_bank.source_documents(id),
  source_internal TEXT,
  prompt TEXT NOT NULL,
  question_type TEXT NOT NULL DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice','free_response')),
  difficulty SMALLINT NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','approved')),
  created_by TEXT NOT NULL,
  reviewed_by TEXT,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.question_choices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES nabaha_question_bank.questions(id),
  choice_key CHAR(1) NOT NULL CHECK (choice_key IN ('A','B','C','D')),
  choice_text TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(question_id, choice_key)
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.question_solutions (
  question_id UUID PRIMARY KEY REFERENCES nabaha_question_bank.questions(id),
  correct_answer TEXT NOT NULL,
  solution TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.nabaha_admin_users (
  auth_user_id TEXT PRIMARY KEY,
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.conversation_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES nabaha_question_bank.conversations(id),
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  content TEXT NOT NULL,
  behavior TEXT CHECK (behavior IN ('general_conversation','tahsili_reasoning','question_solving','explanation','follow_up','quiz_interaction','study_assistance','graceful_refusal')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nabaha_question_bank.instruction_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  behavior TEXT NOT NULL CHECK (behavior IN ('general_conversation','tahsili_reasoning','question_solving','explanation','follow_up','quiz_interaction','study_assistance','graceful_refusal')),
  messages JSONB NOT NULL CHECK (jsonb_typeof(messages) = 'array'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','approved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS questions_review_queue_idx ON nabaha_question_bank.questions(status, created_at);
CREATE INDEX IF NOT EXISTS questions_subject_idx ON nabaha_question_bank.questions(subject_id, status);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON nabaha_question_bank.conversation_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS source_documents_status_idx ON nabaha_question_bank.source_documents(processing_status, created_at);

INSERT INTO nabaha_question_bank.subjects (slug, name_ar) VALUES
  ('mathematics','الرياضيات'), ('physics','الفيزياء'), ('chemistry','الكيمياء'), ('biology','الأحياء')
ON CONFLICT (slug) DO NOTHING;
