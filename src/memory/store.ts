import type { Pool, PoolClient } from "pg";
import { chunkDocumentContent } from "./chunk.js";
import { newDocumentId, sanitizeNamespace } from "./sanitize.js";
import type {
  GraphRelationRecord,
  MemoryDocumentSummary,
  MemoryIngestionResult,
  NamespaceDocumentInput,
  StoredMemoryDocument,
} from "./types.js";
import { GLOBAL_NAMESPACE } from "./types.js";

function rowToDoc(row: Record<string, unknown>): StoredMemoryDocument {
  return {
    document_id: String(row.document_id),
    namespace: String(row.namespace),
    key: String(row.key),
    title: String(row.title),
    content: String(row.content),
    source_type: String(row.source_type),
    priority: String(row.priority),
    tags: (row.tags_json as string[]) ?? [],
    metadata: (row.metadata_json as Record<string, unknown>) ?? {},
    category: String(row.category),
    session_id: row.session_id != null ? String(row.session_id) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class MemoryStore {
  constructor(private readonly pool: Pool) {}

  async listNamespaces(userId: number): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT namespace FROM PKM.memory_docs WHERE user_id = $1 ORDER BY namespace`,
      [userId],
    );
    return rows.map((r) => String(r.namespace));
  }

  async listDocuments(userId: number, namespace?: string): Promise<MemoryDocumentSummary[]> {
    const params: unknown[] = [userId];
    let sql = `SELECT document_id, namespace, key, title, source_type, priority, category,
                      tags_json, updated_at
               FROM PKM.memory_docs WHERE user_id = $1`;
    if (namespace) {
      params.push(sanitizeNamespace(namespace));
      sql += ` AND namespace = $2`;
    }
    sql += ` ORDER BY updated_at DESC`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      document_id: String(r.document_id),
      namespace: String(r.namespace),
      key: String(r.key),
      title: String(r.title),
      source_type: String(r.source_type),
      priority: String(r.priority),
      category: String(r.category),
      tags: (r.tags_json as string[]) ?? [],
      updated_at: String(r.updated_at),
    }));
  }

  async getDocument(userId: number, namespace: string, documentId: string): Promise<StoredMemoryDocument | null> {
    const ns = sanitizeNamespace(namespace);
    const { rows } = await this.pool.query(
      `SELECT * FROM PKM.memory_docs WHERE user_id = $1 AND namespace = $2 AND document_id = $3`,
      [userId, ns, documentId],
    );
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  async putDocument(userId: number, input: NamespaceDocumentInput): Promise<string> {
    const namespace = sanitizeNamespace(input.namespace);
    const key = input.key.trim();
    if (!key) throw new Error("document key cannot be empty");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const documentId = await this.upsertDocumentTx(client, userId, namespace, key, input);
      await this.replaceChunksTx(client, userId, namespace, documentId, input.content);
      await client.query("COMMIT");
      return documentId;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async ingestDocument(userId: number, input: NamespaceDocumentInput): Promise<MemoryIngestionResult> {
    const documentId = await this.putDocument(userId, input);
    const ns = sanitizeNamespace(input.namespace);
    const [chunkRes, graphRes] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS c FROM PKM.memory_chunks WHERE user_id = $1 AND namespace = $2 AND document_id = $3`,
        [userId, ns, documentId],
      ),
      this.graphQuery(userId, ns),
    ]);
    return {
      document_id: documentId,
      entity_count: 0,
      relation_count: graphRes.length,
      chunk_count: Number(chunkRes.rows[0]?.c ?? 0),
    };
  }

  async deleteDocument(
    userId: number,
    namespace: string,
    documentId: string,
  ): Promise<{ deleted: boolean; namespace: string; document_id: string }> {
    const ns = sanitizeNamespace(namespace);
    const { rowCount } = await this.pool.query(
      `DELETE FROM PKM.memory_docs WHERE user_id = $1 AND namespace = $2 AND document_id = $3`,
      [userId, ns, documentId],
    );
    return { deleted: (rowCount ?? 0) > 0, namespace: ns, document_id: documentId };
  }

  async clearNamespace(userId: number, namespace: string): Promise<void> {
    const ns = sanitizeNamespace(namespace);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM PKM.memory_chunks WHERE user_id = $1 AND namespace = $2`, [userId, ns]);
      await client.query(`DELETE FROM PKM.memory_docs WHERE user_id = $1 AND namespace = $2`, [userId, ns]);
      await client.query(`DELETE FROM PKM.memory_kv_namespace WHERE user_id = $1 AND namespace = $2`, [userId, ns]);
      await client.query(`DELETE FROM PKM.memory_graph_namespace WHERE user_id = $1 AND namespace = $2`, [
        userId,
        ns,
      ]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async loadDocumentsForScope(userId: number, namespace: string): Promise<StoredMemoryDocument[]> {
    const ns = sanitizeNamespace(namespace);
    const { rows } = await this.pool.query(
      `SELECT * FROM PKM.memory_docs WHERE user_id = $1 AND namespace = $2 ORDER BY updated_at DESC`,
      [userId, ns],
    );
    return rows.map(rowToDoc);
  }

  async searchChunks(
    userId: number,
    namespace: string,
    query: string,
    limit = 50,
  ): Promise<{ document_id: string; chunk_id: string; text: string; rank: number }[]> {
    const ns = sanitizeNamespace(namespace);
    const q = query.trim();
    if (!q) return [];
    const likePattern = `%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    const { rows } = await this.pool.query(
      `SELECT document_id, chunk_id, text,
              GREATEST(
                ts_rank(to_tsvector('simple', text), plainto_tsquery('simple', $3)),
                CASE WHEN text ILIKE $4 ESCAPE '\\' THEN 0.25 ELSE 0 END
              ) AS rank
       FROM PKM.memory_chunks
       WHERE user_id = $1 AND namespace = $2
         AND (
           to_tsvector('simple', text) @@ plainto_tsquery('simple', $3)
           OR text ILIKE $4 ESCAPE '\\'
         )
       ORDER BY rank DESC
       LIMIT $5`,
      [userId, ns, q, likePattern, limit],
    );
    return rows.map((r) => ({
      document_id: String(r.document_id),
      chunk_id: String(r.chunk_id),
      text: String(r.text),
      rank: Number(r.rank ?? 0),
    }));
  }

  async loadChunksForScope(
    userId: number,
    namespace: string,
  ): Promise<{ document_id: string; chunk_id: string; text: string; updated_at: string }[]> {
    const ns = sanitizeNamespace(namespace);
    const { rows } = await this.pool.query(
      `SELECT document_id, chunk_id, text, updated_at
       FROM PKM.memory_chunks WHERE user_id = $1 AND namespace = $2`,
      [userId, ns],
    );
    return rows.map((r) => ({
      document_id: String(r.document_id),
      chunk_id: String(r.chunk_id),
      text: String(r.text),
      updated_at: String(r.updated_at),
    }));
  }

  // ── KV ──

  async kvSet(userId: number, namespace: string | null, key: string, value: unknown): Promise<void> {
    const now = new Date().toISOString();
    if (namespace) {
      const ns = sanitizeNamespace(namespace);
      await this.pool.query(
        `INSERT INTO PKM.memory_kv_namespace (user_id, namespace, key, value_json, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, namespace, key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
        [userId, ns, key, JSON.stringify(value), now],
      );
    } else {
      await this.pool.query(
        `INSERT INTO PKM.memory_kv_global (user_id, key, value_json, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
        [userId, key, JSON.stringify(value), now],
      );
    }
  }

  async kvGet(userId: number, namespace: string | null, key: string): Promise<unknown | null> {
    if (namespace) {
      const ns = sanitizeNamespace(namespace);
      const { rows } = await this.pool.query(
        `SELECT value_json FROM PKM.memory_kv_namespace WHERE user_id = $1 AND namespace = $2 AND key = $3`,
        [userId, ns, key],
      );
      return rows[0]?.value_json ?? null;
    }
    const { rows } = await this.pool.query(
      `SELECT value_json FROM PKM.memory_kv_global WHERE user_id = $1 AND key = $2`,
      [userId, key],
    );
    return rows[0]?.value_json ?? null;
  }

  async kvDelete(userId: number, namespace: string | null, key: string): Promise<boolean> {
    if (namespace) {
      const ns = sanitizeNamespace(namespace);
      const { rowCount } = await this.pool.query(
        `DELETE FROM PKM.memory_kv_namespace WHERE user_id = $1 AND namespace = $2 AND key = $3`,
        [userId, ns, key],
      );
      return (rowCount ?? 0) > 0;
    }
    const { rowCount } = await this.pool.query(
      `DELETE FROM PKM.memory_kv_global WHERE user_id = $1 AND key = $2`,
      [userId, key],
    );
    return (rowCount ?? 0) > 0;
  }

  async kvListNamespace(userId: number, namespace: string): Promise<{ key: string; value: unknown }[]> {
    const ns = sanitizeNamespace(namespace);
    const { rows } = await this.pool.query(
      `SELECT key, value_json FROM PKM.memory_kv_namespace WHERE user_id = $1 AND namespace = $2 ORDER BY key`,
      [userId, ns],
    );
    return rows.map((r) => ({ key: String(r.key), value: r.value_json }));
  }

  // ── Graph ──

  async graphUpsert(
    userId: number,
    namespace: string | null,
    subject: string,
    predicate: string,
    object: string,
    attrs: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (namespace) {
      const ns = sanitizeNamespace(namespace);
      await this.pool.query(
        `INSERT INTO PKM.memory_graph_namespace (user_id, namespace, subject, predicate, object, attrs_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, namespace, subject, predicate, object)
         DO UPDATE SET attrs_json = EXCLUDED.attrs_json, updated_at = EXCLUDED.updated_at`,
        [userId, ns, subject, predicate, object, JSON.stringify(attrs), now],
      );
    } else {
      await this.pool.query(
        `INSERT INTO PKM.memory_graph_global (user_id, subject, predicate, object, attrs_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, subject, predicate, object)
         DO UPDATE SET attrs_json = EXCLUDED.attrs_json, updated_at = EXCLUDED.updated_at`,
        [userId, subject, predicate, object, JSON.stringify(attrs), now],
      );
    }
  }

  /**
   * 删除文档时清理图谱证据（openhuman `graph_remove_document_namespace` 简化版）。
   * 若 attrs 含 document_ids / chunk_ids 则更新或删除关系行。
   */
  async graphRemoveDocument(userId: number, namespace: string, documentId: string): Promise<void> {
    const ns = sanitizeNamespace(namespace);
    const relations = await this.graphQuery(userId, ns);
    if (relations.length === 0) return;

    const docPrefix = `${documentId}:`;
    const now = new Date().toISOString();

    for (const rel of relations) {
      const docIds = Array.isArray(rel.attrs.document_ids)
        ? (rel.attrs.document_ids as string[]).filter((id) => typeof id === "string")
        : [];
      const chunkIds = Array.isArray(rel.attrs.chunk_ids)
        ? (rel.attrs.chunk_ids as string[]).filter((id) => typeof id === "string")
        : [];
      const touches =
        docIds.includes(documentId) || chunkIds.some((cid) => cid.startsWith(docPrefix));
      if (!touches) continue;

      const nextDocIds = docIds.filter((id) => id !== documentId);
      const nextChunkIds = chunkIds.filter((cid) => !cid.startsWith(docPrefix));

      if (nextDocIds.length === 0 && nextChunkIds.length === 0) {
        await this.pool.query(
          `DELETE FROM PKM.memory_graph_namespace
           WHERE user_id = $1 AND namespace = $2 AND subject = $3 AND predicate = $4 AND object = $5`,
          [userId, ns, rel.subject, rel.predicate, rel.object],
        );
        continue;
      }

      const attrs = { ...rel.attrs, document_ids: nextDocIds, chunk_ids: nextChunkIds };
      await this.pool.query(
        `UPDATE PKM.memory_graph_namespace
         SET attrs_json = $6, updated_at = $7
         WHERE user_id = $1 AND namespace = $2 AND subject = $3 AND predicate = $4 AND object = $5`,
        [userId, ns, rel.subject, rel.predicate, rel.object, JSON.stringify(attrs), now],
      );
    }
  }

  async graphQuery(
    userId: number,
    namespace: string | null,
    subject?: string,
    predicate?: string,
  ): Promise<GraphRelationRecord[]> {
    if (namespace) {
      const ns = sanitizeNamespace(namespace);
      const params: unknown[] = [userId, ns];
      let sql = `SELECT namespace, subject, predicate, object, attrs_json, updated_at
                 FROM PKM.memory_graph_namespace WHERE user_id = $1 AND namespace = $2`;
      if (subject) {
        params.push(subject);
        sql += ` AND subject = $${params.length}`;
      }
      if (predicate) {
        params.push(predicate);
        sql += ` AND predicate = $${params.length}`;
      }
      const { rows } = await this.pool.query(sql, params);
      return rows.map((r) => ({
        namespace: String(r.namespace),
        subject: String(r.subject),
        predicate: String(r.predicate),
        object: String(r.object),
        attrs: (r.attrs_json as Record<string, unknown>) ?? {},
        updated_at: String(r.updated_at),
      }));
    }
    const params: unknown[] = [userId];
    let sql = `SELECT subject, predicate, object, attrs_json, updated_at
               FROM PKM.memory_graph_global WHERE user_id = $1`;
    if (subject) {
      params.push(subject);
      sql += ` AND subject = $${params.length}`;
    }
    if (predicate) {
      params.push(predicate);
      sql += ` AND predicate = $${params.length}`;
    }
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      namespace: null,
      subject: String(r.subject),
      predicate: String(r.predicate),
      object: String(r.object),
      attrs: (r.attrs_json as Record<string, unknown>) ?? {},
      updated_at: String(r.updated_at),
    }));
  }

  private async upsertDocumentTx(
    client: PoolClient,
    userId: number,
    namespace: string,
    key: string,
    input: NamespaceDocumentInput,
  ): Promise<string> {
    const existing = await client.query(
      `SELECT document_id, created_at FROM PKM.memory_docs WHERE user_id = $1 AND namespace = $2 AND key = $3`,
      [userId, namespace, key],
    );
    const documentId = input.document_id ?? existing.rows[0]?.document_id ?? newDocumentId();
    const createdAt = existing.rows[0]?.created_at ?? new Date().toISOString();
    const tags = input.tags ?? [];
    const metadata = input.metadata ?? {};

    await client.query(
      `INSERT INTO PKM.memory_docs
         (document_id, user_id, namespace, key, title, content, source_type, priority,
          tags_json, metadata_json, category, session_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (user_id, namespace, key) DO UPDATE SET
         title = EXCLUDED.title,
         content = EXCLUDED.content,
         source_type = EXCLUDED.source_type,
         priority = EXCLUDED.priority,
         tags_json = EXCLUDED.tags_json,
         metadata_json = EXCLUDED.metadata_json,
         category = EXCLUDED.category,
         session_id = EXCLUDED.session_id,
         updated_at = now()`,
      [
        documentId,
        userId,
        namespace,
        key,
        input.title,
        input.content,
        input.source_type ?? "doc",
        input.priority ?? "medium",
        JSON.stringify(tags),
        JSON.stringify(metadata),
        input.category ?? "core",
        input.session_id ?? null,
        createdAt,
      ],
    );
    return documentId;
  }

  private async replaceChunksTx(
    client: PoolClient,
    userId: number,
    namespace: string,
    documentId: string,
    content: string,
  ): Promise<void> {
    await client.query(
      `DELETE FROM PKM.memory_chunks WHERE user_id = $1 AND namespace = $2 AND document_id = $3`,
      [userId, namespace, documentId],
    );
    const chunks = chunkDocumentContent(content, 225);
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunkId = `${documentId}:${idx}`;
      await client.query(
        `INSERT INTO PKM.memory_chunks
           (user_id, namespace, document_id, chunk_id, text, metadata_json, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now(), now())`,
        [userId, namespace, documentId, chunkId, chunks[idx], JSON.stringify({ chunk_index: idx })],
      );
    }
  }
}

export function resolveNamespaceParam(ns: string | undefined): string {
  return ns?.trim() ? sanitizeNamespace(ns) : GLOBAL_NAMESPACE;
}
