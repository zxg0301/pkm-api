import type { Pool, PoolClient } from "pg";
import { sanitizeNamespace } from "../sanitize.js";
import type { BufferRow, LifecycleStatus, SummaryRow, TreeChunkRow, TreeKind, TreeRow, TreeStatus } from "./types.js";

export function treeId(userId: number, kind: TreeKind, scope: string): string {
  return `${userId}__${kind}__${scope}`;
}

export function nowMs(): number {
  return Date.now();
}

export class TreeStore {
  constructor(readonly pool: Pool) {}

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getOrCreateTree(userId: number, kind: TreeKind, scope: string): Promise<TreeRow> {
    const id = treeId(userId, kind, scope);
    const existing = await this.getTree(userId, id);
    if (existing) return existing;
    const ts = nowMs();
    await this.pool.query(
      `INSERT INTO PKM.mem_tree_trees (id, user_id, kind, scope, root_id, max_level, status, created_at_ms)
       VALUES ($1,$2,$3,$4,NULL,0,'active',$5)
       ON CONFLICT (user_id, kind, scope) DO NOTHING`,
      [id, userId, kind, scope, ts],
    );
    return (await this.getTree(userId, id))!;
  }

  async getTree(userId: number, id: string): Promise<TreeRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, kind, scope, root_id, max_level, status, created_at_ms, last_sealed_at_ms
       FROM PKM.mem_tree_trees WHERE user_id = $1 AND id = $2`,
      [userId, id],
    );
    return rows[0] ? rowToTree(rows[0]) : null;
  }

  async listTrees(userId: number, kind?: TreeKind): Promise<TreeRow[]> {
    const params: unknown[] = [userId];
    let sql = `SELECT id, kind, scope, root_id, max_level, status, created_at_ms, last_sealed_at_ms
               FROM PKM.mem_tree_trees WHERE user_id = $1`;
    if (kind) {
      params.push(kind);
      sql += ` AND kind = $2`;
    }
    sql += ` ORDER BY created_at_ms ASC`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(rowToTree);
  }

  async upsertChunk(
    userId: number,
    chunk: {
      id: string;
      source_kind: string;
      source_id: string;
      source_ref?: string | null;
      content: string;
      token_count: number;
      timestamp_ms: number;
      memory_chunk_id?: string;
      tags?: string[];
    },
  ): Promise<void> {
    const ts = chunk.timestamp_ms;
    await this.pool.query(
      `INSERT INTO PKM.mem_tree_chunks
         (id, user_id, source_kind, source_id, source_ref, owner, timestamp_ms,
          time_range_start_ms, time_range_end_ms, tags_json, content, token_count,
          lifecycle_status, memory_chunk_id, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,'default',$6,$6,$6,$7,$8,$9,'pending_extraction',$10,$11)
       ON CONFLICT (user_id, id) DO UPDATE SET
         content = EXCLUDED.content,
         token_count = EXCLUDED.token_count,
         tags_json = EXCLUDED.tags_json`,
      [
        chunk.id,
        userId,
        chunk.source_kind,
        chunk.source_id,
        chunk.source_ref ?? null,
        ts,
        JSON.stringify(chunk.tags ?? []),
        chunk.content,
        chunk.token_count,
        chunk.memory_chunk_id ?? null,
        nowMs(),
      ],
    );
  }

  async setChunkLifecycle(userId: number, chunkId: string, status: LifecycleStatus): Promise<void> {
    await this.pool.query(
      `UPDATE PKM.mem_tree_chunks SET lifecycle_status = $3 WHERE user_id = $1 AND id = $2`,
      [userId, chunkId, status],
    );
  }

  async getChunk(userId: number, chunkId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM PKM.mem_tree_chunks WHERE user_id = $1 AND id = $2`,
      [userId, chunkId],
    );
    return rows[0] ?? null;
  }

  async listChunks(
    userId: number,
    filter: {
      source_id?: string;
      source_kind?: string;
      lifecycle_status?: LifecycleStatus;
      since_ms?: number;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ chunks: TreeChunkRow[]; total: number }> {
    const params: unknown[] = [userId];
    const clauses = ["user_id = $1"];
    if (filter.source_id) {
      params.push(filter.source_id);
      clauses.push(`source_id = $${params.length}`);
    }
    if (filter.source_kind) {
      params.push(filter.source_kind);
      clauses.push(`source_kind = $${params.length}`);
    }
    if (filter.lifecycle_status) {
      params.push(filter.lifecycle_status);
      clauses.push(`lifecycle_status = $${params.length}`);
    }
    if (filter.since_ms != null) {
      params.push(filter.since_ms);
      clauses.push(`timestamp_ms >= $${params.length}`);
    }
    const where = clauses.join(" AND ");
    const countRes = await this.pool.query(
      `SELECT count(*)::int AS c FROM PKM.mem_tree_chunks WHERE ${where}`,
      params,
    );
    const limit = Math.min(filter.limit ?? 100, 500);
    const offset = filter.offset ?? 0;
    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT id, source_kind, source_id, source_ref, timestamp_ms, token_count,
              lifecycle_status, left(content, 500) AS content_preview, tags_json
       FROM PKM.mem_tree_chunks WHERE ${where}
       ORDER BY timestamp_ms DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      total: Number(countRes.rows[0]?.c ?? 0),
      chunks: rows.map((r) => ({
        id: String(r.id),
        source_kind: String(r.source_kind),
        source_id: String(r.source_id),
        source_ref: r.source_ref != null ? String(r.source_ref) : null,
        timestamp_ms: Number(r.timestamp_ms),
        token_count: Number(r.token_count),
        lifecycle_status: String(r.lifecycle_status) as LifecycleStatus,
        content_preview: String(r.content_preview ?? ""),
        tags: (r.tags_json as string[]) ?? [],
      })),
    };
  }

  async listSources(userId: number): Promise<
    { source_id: string; source_kind: string; chunk_count: number; most_recent_ms: number }[]
  > {
    const { rows } = await this.pool.query(
      `SELECT source_id, source_kind,
              count(*)::int AS chunk_count,
              max(timestamp_ms)::bigint AS most_recent_ms
       FROM PKM.mem_tree_chunks
       WHERE user_id = $1
       GROUP BY source_id, source_kind
       ORDER BY most_recent_ms DESC`,
      [userId],
    );
    return rows.map((r) => ({
      source_id: String(r.source_id),
      source_kind: String(r.source_kind),
      chunk_count: Number(r.chunk_count),
      most_recent_ms: Number(r.most_recent_ms),
    }));
  }

  async getBuffer(userId: number, treeId: string, level: number): Promise<BufferRow> {
    const { rows } = await this.pool.query(
      `SELECT item_ids_json, token_sum, oldest_at_ms FROM PKM.mem_tree_buffers
       WHERE user_id = $1 AND tree_id = $2 AND level = $3`,
      [userId, treeId, level],
    );
    if (!rows[0]) {
      return { tree_id: treeId, level, item_ids: [], token_sum: 0, oldest_at_ms: null };
    }
    return {
      tree_id: treeId,
      level,
      item_ids: (rows[0].item_ids_json as string[]) ?? [],
      token_sum: Number(rows[0].token_sum),
      oldest_at_ms: rows[0].oldest_at_ms != null ? Number(rows[0].oldest_at_ms) : null,
    };
  }

  async upsertBuffer(client: PoolClient, userId: number, buf: BufferRow): Promise<void> {
    await client.query(
      `INSERT INTO PKM.mem_tree_buffers (user_id, tree_id, level, item_ids_json, token_sum, oldest_at_ms, updated_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, tree_id, level) DO UPDATE SET
         item_ids_json = EXCLUDED.item_ids_json,
         token_sum = EXCLUDED.token_sum,
         oldest_at_ms = EXCLUDED.oldest_at_ms,
         updated_at_ms = EXCLUDED.updated_at_ms`,
      [
        userId,
        buf.tree_id,
        buf.level,
        JSON.stringify(buf.item_ids),
        buf.token_sum,
        buf.oldest_at_ms,
        nowMs(),
      ],
    );
  }

  async insertSummary(client: PoolClient, userId: number, summary: SummaryRow): Promise<void> {
    await client.query(
      `INSERT INTO PKM.mem_tree_summaries
         (id, user_id, tree_id, tree_kind, level, parent_id, child_ids_json, content, token_count,
          entities_json, topics_json, time_range_start_ms, time_range_end_ms, score, sealed_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (user_id, id) DO NOTHING`,
      [
        summary.id,
        userId,
        summary.tree_id,
        summary.tree_kind,
        summary.level,
        summary.parent_id,
        JSON.stringify(summary.child_ids),
        summary.content,
        summary.token_count,
        JSON.stringify(summary.entities),
        JSON.stringify(summary.topics),
        summary.time_range_start_ms,
        summary.time_range_end_ms,
        summary.score,
        summary.sealed_at_ms,
      ],
    );
  }

  async updateTreeAfterSeal(
    client: PoolClient,
    userId: number,
    treeId: string,
    rootId: string,
    maxLevel: number,
    sealedAtMs: number,
  ): Promise<void> {
    await client.query(
      `UPDATE PKM.mem_tree_trees
       SET root_id = $3, max_level = $4, last_sealed_at_ms = $5
       WHERE user_id = $1 AND id = $2`,
      [userId, treeId, rootId, maxLevel, sealedAtMs],
    );
  }

  async getSummary(userId: number, summaryId: string): Promise<SummaryRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, tree_id, tree_kind, level, parent_id, child_ids_json, content, token_count,
              entities_json, topics_json, time_range_start_ms, time_range_end_ms, score, sealed_at_ms
       FROM PKM.mem_tree_summaries WHERE user_id = $1 AND id = $2 AND deleted = false`,
      [userId, summaryId],
    );
    return rows[0] ? rowToSummary(rows[0]) : null;
  }

  async listSummaries(
    userId: number,
    opts: { tree_id?: string; kind?: TreeKind; scope?: string; since_ms?: number; limit?: number },
  ): Promise<SummaryRow[]> {
    const params: unknown[] = [userId];
    let sql = `SELECT s.* FROM PKM.mem_tree_summaries s
               JOIN PKM.mem_tree_trees t ON t.user_id = s.user_id AND t.id = s.tree_id
               WHERE s.user_id = $1 AND s.deleted = false`;
    if (opts.tree_id) {
      params.push(opts.tree_id);
      sql += ` AND s.tree_id = $${params.length}`;
    }
    if (opts.kind) {
      params.push(opts.kind);
      sql += ` AND t.kind = $${params.length}`;
    }
    if (opts.scope) {
      params.push(opts.scope);
      sql += ` AND t.scope = $${params.length}`;
    }
    if (opts.since_ms != null) {
      params.push(opts.since_ms);
      sql += ` AND s.time_range_end_ms >= $${params.length}`;
    }
    sql += ` ORDER BY s.sealed_at_ms DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(opts.limit ?? 20, 100));
    const { rows } = await this.pool.query(sql, params);
    return rows.map(rowToSummary);
  }

  async listStaleL0Buffers(userId: number, olderThanMs: number): Promise<BufferRow[]> {
    const { rows } = await this.pool.query(
      `SELECT tree_id, level, item_ids_json, token_sum, oldest_at_ms
       FROM PKM.mem_tree_buffers
       WHERE user_id = $1 AND level = 0 AND oldest_at_ms IS NOT NULL AND oldest_at_ms <= $2
       ORDER BY oldest_at_ms ASC`,
      [userId, olderThanMs],
    );
    return rows.map((r) => ({
      tree_id: String(r.tree_id),
      level: Number(r.level),
      item_ids: (r.item_ids_json as string[]) ?? [],
      token_sum: Number(r.token_sum),
      oldest_at_ms: r.oldest_at_ms != null ? Number(r.oldest_at_ms) : null,
    }));
  }

  async bumpEntityHotness(userId: number, entityId: string, sourceId: string): Promise<number> {
    const ts = nowMs();
    const { rows } = await this.pool.query(
      `INSERT INTO PKM.mem_tree_entity_hotness
         (user_id, entity_id, mention_count_30d, distinct_sources, last_seen_ms, last_updated_ms, last_hotness)
       VALUES ($1,$2,1,1,$3,$3,1)
       ON CONFLICT (user_id, entity_id) DO UPDATE SET
         mention_count_30d = PKM.mem_tree_entity_hotness.mention_count_30d + 1,
         last_seen_ms = $3,
         last_updated_ms = $3,
         last_hotness = (PKM.mem_tree_entity_hotness.mention_count_30d + 1)::real
       RETURNING last_hotness`,
      [userId, entityId, ts],
    );
    return Number(rows[0]?.last_hotness ?? 0);
  }

  /** 删除某源树及其块（openhuman 删文档时需清理 mem_tree_*） */
  async deleteSourceTree(userId: number, sourceId: string): Promise<void> {
    const id = treeId(userId, "source", sourceId);
    await this.pool.query(`DELETE FROM PKM.mem_tree_chunks WHERE user_id = $1 AND source_id = $2`, [
      userId,
      sourceId,
    ]);
    await this.pool.query(`DELETE FROM PKM.mem_tree_trees WHERE user_id = $1 AND id = $2`, [userId, id]);
  }

  /** 清空某 namespace 下所有 doc 源树 */
  async deleteSourceTreesForNamespace(userId: number, namespace: string): Promise<void> {
    const ns = sanitizeNamespace(namespace);
    const prefix = `doc:${ns}:%`;
    await this.pool.query(`DELETE FROM PKM.mem_tree_chunks WHERE user_id = $1 AND source_id LIKE $2`, [
      userId,
      prefix,
    ]);
    await this.pool.query(
      `DELETE FROM PKM.mem_tree_trees WHERE user_id = $1 AND kind = 'source' AND scope LIKE $2`,
      [userId, prefix],
    );
  }

  async stats(userId: number): Promise<Record<string, number>> {
    const [chunks, sources, trees, summaries, topics] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS c FROM PKM.mem_tree_chunks WHERE user_id = $1`, [userId]),
      this.pool.query(
        `SELECT count(DISTINCT source_id)::int AS c FROM PKM.mem_tree_chunks WHERE user_id = $1`,
        [userId],
      ),
      this.pool.query(`SELECT count(*)::int AS c FROM PKM.mem_tree_trees WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT count(*)::int AS c FROM PKM.mem_tree_summaries WHERE user_id = $1`, [userId]),
      this.pool.query(
        `SELECT count(*)::int AS c FROM PKM.mem_tree_trees WHERE user_id = $1 AND kind = 'topic'`,
        [userId],
      ),
    ]);
    const ts = await this.pool.query(
      `SELECT min(timestamp_ms)::bigint AS oldest, max(timestamp_ms)::bigint AS newest
       FROM PKM.mem_tree_chunks WHERE user_id = $1`,
      [userId],
    );
    return {
      chunks: Number(chunks.rows[0]?.c ?? 0),
      sources: Number(sources.rows[0]?.c ?? 0),
      trees: Number(trees.rows[0]?.c ?? 0),
      summaries: Number(summaries.rows[0]?.c ?? 0),
      topic_trees: Number(topics.rows[0]?.c ?? 0),
      oldest_chunk_ms: Number(ts.rows[0]?.oldest ?? 0),
      newest_chunk_ms: Number(ts.rows[0]?.newest ?? 0),
    };
  }
}

function rowToTree(r: Record<string, unknown>): TreeRow {
  return {
    id: String(r.id),
    kind: String(r.kind) as TreeKind,
    scope: String(r.scope),
    root_id: r.root_id != null ? String(r.root_id) : null,
    max_level: Number(r.max_level),
    status: String(r.status) as TreeStatus,
    created_at_ms: Number(r.created_at_ms),
    last_sealed_at_ms: r.last_sealed_at_ms != null ? Number(r.last_sealed_at_ms) : null,
  };
}

function rowToSummary(r: Record<string, unknown>): SummaryRow {
  return {
    id: String(r.id),
    tree_id: String(r.tree_id),
    tree_kind: String(r.tree_kind) as TreeKind,
    level: Number(r.level),
    parent_id: r.parent_id != null ? String(r.parent_id) : null,
    child_ids: (r.child_ids_json as string[]) ?? [],
    content: String(r.content),
    token_count: Number(r.token_count),
    entities: (r.entities_json as string[]) ?? [],
    topics: (r.topics_json as string[]) ?? [],
    time_range_start_ms: Number(r.time_range_start_ms),
    time_range_end_ms: Number(r.time_range_end_ms),
    score: Number(r.score),
    sealed_at_ms: Number(r.sealed_at_ms),
  };
}
