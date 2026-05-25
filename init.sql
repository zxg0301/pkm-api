-- ============================================
-- PKM (Personal Knowledge Management) 数据库初始化
-- 仅包含知识库原有表；Memory 见 init-memory.sql（可选）
-- ============================================

CREATE SCHEMA IF NOT EXISTS PKM;

-- 知识文档表
CREATE TABLE IF NOT EXISTS PKM.knowledge_docs (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL DEFAULT 0,
  title         TEXT,
  summary_md    TEXT NOT NULL,
  source_files  JSONB DEFAULT '[]',
  tags          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 附件表（关联知识文档，文件存储在 MinIO）
CREATE TABLE IF NOT EXISTS PKM.attachments (
  id            SERIAL PRIMARY KEY,
  doc_id        INTEGER NOT NULL REFERENCES PKM.knowledge_docs(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  minio_key     TEXT NOT NULL,
  content_type  TEXT,
  file_size     BIGINT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
