-- ============================================
-- Memory 模块（可选，与知识库 API 独立）
-- 启用 MEMORY_API_ENABLED 后执行：psql ... -f init-memory.sql
-- ============================================

CREATE SCHEMA IF NOT EXISTS PKM;

CREATE TABLE IF NOT EXISTS PKM.memory_docs (
  document_id   TEXT NOT NULL,
  user_id       INTEGER NOT NULL DEFAULT 0,
  namespace     TEXT NOT NULL,
  key           TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  source_type   TEXT NOT NULL DEFAULT 'doc',
  priority      TEXT NOT NULL DEFAULT 'medium',
  tags_json     JSONB NOT NULL DEFAULT '[]',
  metadata_json JSONB NOT NULL DEFAULT '{}',
  category      TEXT NOT NULL DEFAULT 'core',
  session_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id),
  UNIQUE (user_id, namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_memory_docs_user_ns_updated
  ON PKM.memory_docs (user_id, namespace, updated_at DESC);

CREATE TABLE IF NOT EXISTS PKM.memory_chunks (
  user_id       INTEGER NOT NULL DEFAULT 0,
  namespace     TEXT NOT NULL,
  document_id   TEXT NOT NULL,
  chunk_id      TEXT NOT NULL,
  text          TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chunk_id),
  FOREIGN KEY (user_id, document_id) REFERENCES PKM.memory_docs (user_id, document_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_user_ns_doc
  ON PKM.memory_chunks (user_id, namespace, document_id);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_fts
  ON PKM.memory_chunks USING GIN (to_tsvector('simple', text));

CREATE TABLE IF NOT EXISTS PKM.memory_kv_global (
  user_id       INTEGER NOT NULL DEFAULT 0,
  key           TEXT NOT NULL,
  value_json    JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS PKM.memory_kv_namespace (
  user_id       INTEGER NOT NULL DEFAULT 0,
  namespace     TEXT NOT NULL,
  key           TEXT NOT NULL,
  value_json    JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_memory_kv_namespace_user_ns
  ON PKM.memory_kv_namespace (user_id, namespace);

CREATE TABLE IF NOT EXISTS PKM.memory_graph_global (
  user_id       INTEGER NOT NULL DEFAULT 0,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  object        TEXT NOT NULL,
  attrs_json    JSONB NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, subject, predicate, object)
);

CREATE INDEX IF NOT EXISTS idx_memory_graph_global_subject
  ON PKM.memory_graph_global (user_id, subject, predicate);

CREATE TABLE IF NOT EXISTS PKM.memory_graph_namespace (
  user_id       INTEGER NOT NULL DEFAULT 0,
  namespace     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  object        TEXT NOT NULL,
  attrs_json    JSONB NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, namespace, subject, predicate, object)
);

CREATE INDEX IF NOT EXISTS idx_memory_graph_namespace_user_ns
  ON PKM.memory_graph_namespace (user_id, namespace);

CREATE INDEX IF NOT EXISTS idx_memory_graph_namespace_subject
  ON PKM.memory_graph_namespace (user_id, namespace, subject, predicate);

-- Memory Tree
CREATE TABLE IF NOT EXISTS PKM.mem_tree_chunks (
  id                  TEXT NOT NULL,
  user_id             INTEGER NOT NULL DEFAULT 0,
  source_kind         TEXT NOT NULL DEFAULT 'doc',
  source_id           TEXT NOT NULL,
  source_ref          TEXT,
  owner               TEXT NOT NULL DEFAULT 'default',
  timestamp_ms        BIGINT NOT NULL,
  time_range_start_ms BIGINT NOT NULL,
  time_range_end_ms   BIGINT NOT NULL,
  tags_json           JSONB NOT NULL DEFAULT '[]',
  content             TEXT NOT NULL,
  token_count         INTEGER NOT NULL,
  seq_in_source       INTEGER NOT NULL DEFAULT 0,
  lifecycle_status    TEXT NOT NULL DEFAULT 'pending_extraction',
  memory_chunk_id     TEXT,
  created_at_ms       BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_mem_tree_chunks_user_source
  ON PKM.mem_tree_chunks (user_id, source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_mem_tree_chunks_user_ts
  ON PKM.mem_tree_chunks (user_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_mem_tree_chunks_user_lifecycle
  ON PKM.mem_tree_chunks (user_id, lifecycle_status);

CREATE TABLE IF NOT EXISTS PKM.mem_tree_trees (
  id                  TEXT NOT NULL,
  user_id             INTEGER NOT NULL DEFAULT 0,
  kind                TEXT NOT NULL,
  scope               TEXT NOT NULL,
  root_id             TEXT,
  max_level           INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active',
  created_at_ms       BIGINT NOT NULL,
  last_sealed_at_ms   BIGINT,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, kind, scope)
);

CREATE TABLE IF NOT EXISTS PKM.mem_tree_summaries (
  id                  TEXT NOT NULL,
  user_id             INTEGER NOT NULL DEFAULT 0,
  tree_id             TEXT NOT NULL,
  tree_kind           TEXT NOT NULL,
  level               INTEGER NOT NULL,
  parent_id           TEXT,
  child_ids_json      JSONB NOT NULL DEFAULT '[]',
  content             TEXT NOT NULL,
  token_count         INTEGER NOT NULL,
  entities_json       JSONB NOT NULL DEFAULT '[]',
  topics_json         JSONB NOT NULL DEFAULT '[]',
  time_range_start_ms BIGINT NOT NULL,
  time_range_end_ms   BIGINT NOT NULL,
  score               REAL NOT NULL DEFAULT 0,
  sealed_at_ms        BIGINT NOT NULL,
  deleted             BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, tree_id) REFERENCES PKM.mem_tree_trees (user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mem_tree_summaries_user_tree_level
  ON PKM.mem_tree_summaries (user_id, tree_id, level);
CREATE INDEX IF NOT EXISTS idx_mem_tree_summaries_user_sealed
  ON PKM.mem_tree_summaries (user_id, sealed_at_ms DESC);

CREATE TABLE IF NOT EXISTS PKM.mem_tree_buffers (
  user_id             INTEGER NOT NULL DEFAULT 0,
  tree_id             TEXT NOT NULL,
  level               INTEGER NOT NULL,
  item_ids_json       JSONB NOT NULL DEFAULT '[]',
  token_sum           BIGINT NOT NULL DEFAULT 0,
  oldest_at_ms        BIGINT,
  updated_at_ms       BIGINT NOT NULL,
  PRIMARY KEY (user_id, tree_id, level),
  FOREIGN KEY (user_id, tree_id) REFERENCES PKM.mem_tree_trees (user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS PKM.mem_tree_entity_hotness (
  user_id             INTEGER NOT NULL DEFAULT 0,
  entity_id           TEXT NOT NULL,
  mention_count_30d   INTEGER NOT NULL DEFAULT 0,
  distinct_sources    INTEGER NOT NULL DEFAULT 0,
  last_seen_ms        BIGINT,
  query_hits_30d      INTEGER NOT NULL DEFAULT 0,
  last_hotness        REAL,
  last_updated_ms     BIGINT NOT NULL,
  PRIMARY KEY (user_id, entity_id)
);
