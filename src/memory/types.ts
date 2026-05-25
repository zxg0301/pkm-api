/** 与 openhuman memory_store 对齐的核心类型 */

export const GLOBAL_NAMESPACE = "global";

export interface NamespaceDocumentInput {
  namespace: string;
  key: string;
  title: string;
  content: string;
  source_type?: string;
  priority?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  category?: string;
  session_id?: string | null;
  document_id?: string | null;
}

export interface StoredMemoryDocument {
  document_id: string;
  namespace: string;
  key: string;
  title: string;
  content: string;
  source_type: string;
  priority: string;
  tags: string[];
  metadata: Record<string, unknown>;
  category: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryDocumentSummary {
  document_id: string;
  namespace: string;
  key: string;
  title: string;
  source_type: string;
  priority: string;
  category: string;
  tags: string[];
  updated_at: string;
}

export interface GraphRelationRecord {
  namespace: string | null;
  subject: string;
  predicate: string;
  object: string;
  attrs: Record<string, unknown>;
  updated_at: string;
}

export interface RetrievalScoreBreakdown {
  keyword_relevance: number;
  vector_similarity: number;
  graph_relevance: number;
  episodic_relevance: number;
  freshness: number;
  final_score: number;
}

export interface NamespaceMemoryHit {
  kind: "document" | "kv";
  namespace: string;
  key: string;
  title: string | null;
  content: string;
  category: string;
  source_type: string | null;
  score: number;
  score_breakdown: RetrievalScoreBreakdown;
  document_id: string | null;
  chunk_id: string | null;
  updated_at: string;
  supporting_relations: GraphRelationRecord[];
}

export interface MemoryRetrievalEntity {
  id?: string;
  name: string;
  entity_type?: string;
  score?: number;
  metadata?: unknown;
}

export interface MemoryRetrievalRelation {
  subject: string;
  predicate: string;
  object: string;
  score?: number;
  evidence_count?: number;
  metadata?: unknown;
}

export interface MemoryRetrievalChunk {
  chunk_id?: string;
  document_id?: string;
  content: string;
  score: number;
  metadata?: unknown;
}

export interface MemoryRetrievalContext {
  entities: MemoryRetrievalEntity[];
  relations: MemoryRetrievalRelation[];
  chunks: MemoryRetrievalChunk[];
}

export interface QueryNamespaceResponse {
  llm_context_message: string | null;
  context: MemoryRetrievalContext | null;
}

export interface MemoryIngestionResult {
  document_id: string;
  entity_count: number;
  relation_count: number;
  chunk_count: number;
}
