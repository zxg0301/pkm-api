import type { MemoryStore } from "./store.js";
import { buildRetrievalContext, formatLlmContextMessage } from "./format.js";
import { sanitizeNamespace } from "./sanitize.js";
import type {
  GraphRelationRecord,
  NamespaceMemoryHit,
  QueryNamespaceResponse,
  RetrievalScoreBreakdown,
  StoredMemoryDocument,
} from "./types.js";

const GRAPH_WEIGHT = 0.55;
const KEYWORD_WEIGHT = 0.45;

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

function keywordScore(terms: string[], texts: string[]): number {
  if (terms.length === 0) return 0;
  const hay = texts.join(" ").toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (hay.includes(term)) hits++;
  }
  return hits / terms.length;
}

function priorityBoost(priority: string): number {
  switch (priority) {
    case "high":
      return 0.15;
    case "low":
      return -0.05;
    default:
      return 0;
  }
}

function freshnessScore(updatedAt: string): number {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const days = ageMs / (86400 * 1000);
  return Math.max(0, 1 - days / 30);
}

function graphScoreForDoc(
  doc: StoredMemoryDocument,
  relations: GraphRelationRecord[],
  terms: string[],
): { score: number; matched: GraphRelationRecord[] } {
  const matched: GraphRelationRecord[] = [];
  for (const rel of relations) {
    const blob = `${rel.subject} ${rel.predicate} ${rel.object}`.toLowerCase();
    if (terms.length > 0 && terms.some((t) => blob.includes(t))) matched.push(rel);
    const contentLower = doc.content.toLowerCase();
    const titleLower = doc.title.toLowerCase();
    if (
      titleLower.includes(rel.subject.toLowerCase()) ||
      contentLower.includes(rel.subject.toLowerCase()) ||
      contentLower.includes(rel.object.toLowerCase())
    ) {
      matched.push(rel);
    }
  }
  const unique = [...new Map(matched.map((r) => [`${r.subject}|${r.predicate}|${r.object}`, r])).values()];
  return { score: Math.min(1, unique.length * 0.25), matched: unique };
}

function composeScore(keyword: number, graph: number, freshness: number, priority: string): RetrievalScoreBreakdown {
  const final_score = Math.min(
    1,
    keyword * KEYWORD_WEIGHT + graph * GRAPH_WEIGHT + freshness * 0.1 + priorityBoost(priority),
  );
  return {
    keyword_relevance: keyword,
    vector_similarity: 0,
    graph_relevance: graph,
    episodic_relevance: 0,
    freshness,
    final_score,
  };
}

function renderKvValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** openhuman `kv_priority_signal` */
function kvPrioritySignal(key: string, value: unknown): number {
  const keyNorm = key.toLowerCase();
  const valueNorm = renderKvValue(value).toLowerCase();
  let score = 0.3;
  if (["preference", "decision", "profile", "setting", "owner"].some((n) => keyNorm.includes(n) || valueNorm.includes(n))) {
    score += 0.35;
  }
  if (value !== null && typeof value === "object") score += 0.15;
  return Math.min(1, score);
}

export class MemoryRetrieval {
  constructor(private readonly store: MemoryStore) {}

  async queryNamespace(
    userId: number,
    namespace: string,
    query: string,
    limit = 10,
  ): Promise<QueryNamespaceResponse> {
    const hits = await this.rankHits(userId, namespace, query, limit, false);
    return {
      llm_context_message: formatLlmContextMessage(query, hits),
      context: buildRetrievalContext(hits),
    };
  }

  async recallContext(userId: number, namespace: string, limit = 10): Promise<QueryNamespaceResponse> {
    const hits = await this.rankHits(userId, namespace, "", limit, true);
    return {
      llm_context_message: formatLlmContextMessage(null, hits),
      context: buildRetrievalContext(hits),
    };
  }

  private async rankHits(
    userId: number,
    namespace: string,
    query: string,
    limit: number,
    recallOnly: boolean,
  ): Promise<NamespaceMemoryHit[]> {
    const ns = sanitizeNamespace(namespace);
    const docs = await this.store.loadDocumentsForScope(userId, ns);
    const relations = await this.store.graphQuery(userId, ns);
    const kvs = await this.store.kvListNamespace(userId, ns);
    const terms = queryTerms(query);

    const ftsHits = !recallOnly && query.trim() ? await this.store.searchChunks(userId, ns, query, 50) : [];

    const bestChunkPerDoc = new Map<string, { chunk_id: string; text: string; score: number }>();
    for (const hit of ftsHits) {
      const prev = bestChunkPerDoc.get(hit.document_id);
      const score = Math.min(1, hit.rank * 2);
      if (!prev || score > prev.score) {
        bestChunkPerDoc.set(hit.document_id, { chunk_id: hit.chunk_id, text: hit.text, score });
      }
    }

    const hits: NamespaceMemoryHit[] = [];

    for (const doc of docs) {
      const best = bestChunkPerDoc.get(doc.document_id);
      const keyword = recallOnly
        ? 0.3 + priorityBoost(doc.priority) + freshnessScore(doc.updated_at) * 0.2
        : (best?.score ?? keywordScore(terms, [doc.key, doc.title, doc.content]));
      const { score: graph, matched } = graphScoreForDoc(doc, relations, terms);
      const fresh = freshnessScore(doc.updated_at);
      const breakdown = composeScore(keyword, graph, fresh, doc.priority);
      if (breakdown.final_score <= 0 && !recallOnly) continue;

      hits.push({
        kind: "document",
        namespace: ns,
        key: doc.key,
        title: doc.title,
        content: (best?.text ?? doc.content).slice(0, 4000),
        category: doc.category,
        source_type: doc.source_type,
        score: breakdown.final_score,
        score_breakdown: breakdown,
        document_id: doc.document_id,
        chunk_id: best?.chunk_id ?? null,
        updated_at: doc.updated_at,
        supporting_relations: matched,
      });
    }

    for (const kv of kvs) {
      const rendered = renderKvValue(kv.value);
      const keyword = recallOnly
        ? kvPrioritySignal(kv.key, kv.value) + 0.1
        : keywordScore(terms, [kv.key, rendered]);
      const fresh = 0.5;
      const breakdown = composeScore(keyword, 0, fresh, "medium");
      if (breakdown.final_score <= 0 && !recallOnly) continue;

      hits.push({
        kind: "kv",
        namespace: ns,
        key: kv.key,
        title: null,
        content: rendered.slice(0, 4000),
        category: "kv",
        source_type: null,
        score: breakdown.final_score,
        score_breakdown: breakdown,
        document_id: null,
        chunk_id: null,
        updated_at: new Date().toISOString(),
        supporting_relations: [],
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}
