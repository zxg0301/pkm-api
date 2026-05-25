import type { GraphRelationRecord, NamespaceMemoryHit, MemoryRetrievalContext } from "./types.js";

function relationIdentity(r: GraphRelationRecord): string {
  return `${r.namespace ?? "global"}|${r.subject}|${r.predicate}|${r.object}`;
}

export function buildRetrievalContext(hits: NamespaceMemoryHit[]): MemoryRetrievalContext {
  const entityNames = new Map<string, string | undefined>();
  const relations = new Map<string, { subject: string; predicate: string; object: string }>();

  for (const hit of hits) {
    for (const rel of hit.supporting_relations) {
      if (rel.subject.trim()) entityNames.set(rel.subject, undefined);
      if (rel.object.trim()) entityNames.set(rel.object, undefined);
      relations.set(relationIdentity(rel), {
        subject: rel.subject,
        predicate: rel.predicate,
        object: rel.object,
      });
    }
  }

  return {
    entities: [...entityNames.keys()].map((name) => ({ name })),
    relations: [...relations.values()],
    chunks: hits.map((hit) => ({
      chunk_id: hit.chunk_id ?? undefined,
      document_id: hit.document_id ?? undefined,
      content: hit.content,
      score: hit.score,
    })),
  };
}

export function formatLlmContextMessage(query: string | null, hits: NamespaceMemoryHit[]): string | null {
  if (hits.length === 0) return null;
  const parts: string[] = [];
  if (query) parts.push(`Query: ${query}`);
  for (const hit of hits) {
    const title = hit.title ?? hit.key;
    const summary =
      hit.kind === "kv" ? `[kv:${hit.key}] ${hit.content.trim()}` : `${title}: ${hit.content.trim()}`;
    parts.push(summary);
    if (hit.supporting_relations.length > 0) {
      const rels = hit.supporting_relations
        .map((r) => `${r.subject} -[${r.predicate}]-> ${r.object}`)
        .join("; ");
      parts.push(`Relations: ${rels}`);
    }
  }
  return parts.join("\n\n");
}
