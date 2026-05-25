import type { Pool } from "pg";
import { createSummarizer, type MemoryTreeSummarizer } from "./summarizer/index.js";
import { approxTokenCount } from "./summarize.js";
import { TreeSealer } from "./seal.js";
import { TreeStore } from "./store.js";
import type { TreeKind } from "./types.js";
import { DEFAULT_FLUSH_AGE_MS, MIN_ADMIT_CHARS, TOPIC_CREATION_THRESHOLD } from "./types.js";

/** 文档源 ID：namespace + document */
export function docSourceId(namespace: string, documentId: string): string {
  return `doc:${namespace}:${documentId}`;
}

export class TreePipeline {
  private readonly store: TreeStore;
  private readonly sealer: TreeSealer;

  constructor(pool: Pool, summarizer?: MemoryTreeSummarizer) {
    this.store = new TreeStore(pool);
    this.sealer = new TreeSealer(this.store, summarizer ?? createSummarizer());
  }

  /**
   * 将 unified memory 分块同步到 Memory Tree 并跑 admission → buffer → seal
   */
  async syncFromMemoryChunks(
    userId: number,
    namespace: string,
    documentId: string,
    chunks: { chunk_id: string; text: string }[],
    title?: string,
  ): Promise<{ admitted: number; dropped: number }> {
    const sourceId = docSourceId(namespace, documentId);
    const tree = await this.store.getOrCreateTree(userId, "source", sourceId);
    let admitted = 0;
    let dropped = 0;
    const ts = Date.now();

    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i].text.trim();
      const treeChunkId = chunks[i].chunk_id;
      await this.store.upsertChunk(userId, {
        id: treeChunkId,
        source_kind: "doc",
        source_id: sourceId,
        source_ref: title ?? documentId,
        content: text,
        token_count: approxTokenCount(text),
        timestamp_ms: ts + i,
        memory_chunk_id: treeChunkId,
        tags: [],
      });

      if (text.length < MIN_ADMIT_CHARS) {
        await this.store.setChunkLifecycle(userId, treeChunkId, "dropped");
        dropped++;
        continue;
      }

      await this.store.setChunkLifecycle(userId, treeChunkId, "admitted");
      await this.store.setChunkLifecycle(userId, treeChunkId, "buffered");
      await this.sealer.appendLeaf(userId, tree.id, "source", treeChunkId, approxTokenCount(text));
      admitted++;

      await this.routeTopicsFromText(userId, text, sourceId);
    }

    await this.ensureGlobalTree(userId);
    return { admitted, dropped };
  }

  /** 从图谱关系与文本中的实体路由到主题树 */
  private async routeTopicsFromText(userId: number, text: string, sourceId: string): Promise<void> {
    const words = text.match(/[\p{L}][\p{L}\p{N}_-]{2,}/gu) ?? [];
    const seen = new Set<string>();
    for (const w of words.slice(0, 20)) {
      const entityId = `mention:${w.toLowerCase()}`;
      if (seen.has(entityId)) continue;
      seen.add(entityId);
      const hotness = await this.store.bumpEntityHotness(userId, entityId, sourceId);
      if (hotness >= TOPIC_CREATION_THRESHOLD) {
        await this.store.getOrCreateTree(userId, "topic", entityId);
      }
    }
  }

  private async ensureGlobalTree(userId: number): Promise<void> {
    await this.store.getOrCreateTree(userId, "global", "global");
  }

  /** 构建全局日摘要（将 global 树 L0 缓冲区密封） */
  async digestGlobal(userId: number): Promise<string | null> {
    const tree = await this.store.getOrCreateTree(userId, "global", "global");
    const recent = await this.store.listSummaries(userId, {
      kind: "source",
      since_ms: Date.now() - 86400000,
      limit: 20,
    });
    const ts = Date.now();
    for (const s of recent) {
      const pseudoId = `ref__${s.id}`;
      await this.store.upsertChunk(userId, {
        id: pseudoId,
        source_kind: "digest",
        source_id: "global",
        content: s.content.slice(0, 2000),
        token_count: s.token_count,
        timestamp_ms: ts,
      });
      await this.store.setChunkLifecycle(userId, pseudoId, "admitted");
      await this.store.setChunkLifecycle(userId, pseudoId, "buffered");
      await this.sealer.appendLeaf(userId, tree.id, "global", pseudoId, s.token_count);
    }
    await this.sealer.cascadeSeal(userId, tree.id, "global", 0);
    const updated = await this.store.getTree(userId, tree.id);
    return updated?.root_id ?? null;
  }

  async flushStale(userId: number, maxAgeMs = DEFAULT_FLUSH_AGE_MS): Promise<number> {
    return this.sealer.flushStaleBuffers(userId, maxAgeMs);
  }

  getStore(): TreeStore {
    return this.store;
  }
}
