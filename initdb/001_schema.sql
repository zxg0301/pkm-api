CREATE SCHEMA IF NOT EXISTS PKM;

CREATE TABLE IF NOT EXISTS PKM.knowledge_docs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary_md TEXT NOT NULL DEFAULT '',
  source_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS PKM.attachments (
  id SERIAL PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES PKM.knowledge_docs(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  minio_key TEXT NOT NULL,
  content_type TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_docs_user_created_idx
  ON PKM.knowledge_docs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS attachments_doc_created_idx
  ON PKM.attachments (doc_id, created_at);
