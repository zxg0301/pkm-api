import { createSummarizer, type MemoryTreeSummarizer } from "./summarizer/index.js";
import type { TreeStore } from "./store.js";
import { nowMs } from "./store.js";
import type { BufferRow, SummaryInput, TreeKind } from "./types.js";
import { INPUT_TOKEN_BUDGET, OUTPUT_TOKEN_BUDGET, SUMMARY_FANOUT } from "./types.js";

const MAX_CASCADE = 32;

function newSummaryId(treeId: string, level: number): string {
  return `${treeId}__L${level}__${nowMs()}__${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Level-aware seal gate (openhuman `bucket_seal::should_seal`).
 * L0: token_sum >= INPUT_TOKEN_BUDGET OR item count >= SUMMARY_FANOUT.
 * L≥1: item count >= SUMMARY_FANOUT only.
 */
export function shouldSeal(buf: BufferRow): boolean {
  if (buf.item_ids.length === 0) return false;
  if (buf.level === 0) {
    return buf.token_sum >= INPUT_TOKEN_BUDGET || buf.item_ids.length >= SUMMARY_FANOUT;
  }
  return buf.item_ids.length >= SUMMARY_FANOUT;
}

export class TreeSealer {
  constructor(
    private readonly store: TreeStore,
    private readonly summarizer: MemoryTreeSummarizer = createSummarizer(),
  ) {}

  /** Append leaf to L0 and cascade-seal; returns summary ids sealed in this call. */
  async appendLeaf(
    userId: number,
    treeId: string,
    kind: TreeKind,
    chunkId: string,
    tokenCount: number,
    itemTimestampMs?: number,
  ): Promise<string[]> {
    const ts = itemTimestampMs ?? nowMs();
    await this.store.withTransaction(async (client) => {
      let buf = await this.store.getBuffer(userId, treeId, 0);
      if (!buf.item_ids.includes(chunkId)) {
        buf = {
          tree_id: treeId,
          level: 0,
          item_ids: [...buf.item_ids, chunkId],
          token_sum: buf.token_sum + tokenCount,
          oldest_at_ms: buf.oldest_at_ms != null ? Math.min(buf.oldest_at_ms, ts) : ts,
        };
        await this.store.upsertBuffer(client, userId, buf);
      }
    });
    return this.cascadeAllFrom(userId, treeId, kind, 0);
  }

  /**
   * Seal buffers from `startLevel` upward (openhuman `cascade_all_from`).
   * When `forceNowMs` is set, the first iteration seals regardless of `shouldSeal`.
   */
  async cascadeAllFrom(
    userId: number,
    treeId: string,
    kind: TreeKind,
    startLevel: number,
    forceNowMs?: number,
  ): Promise<string[]> {
    const sealedIds: string[] = [];
    let level = startLevel;
    let firstIteration = true;

    for (let depth = 0; depth < MAX_CASCADE; depth++) {
      const buf = await this.store.getBuffer(userId, treeId, level);
      const forced = firstIteration && forceNowMs != null;
      firstIteration = false;

      if (!forced && !shouldSeal(buf)) break;
      if (buf.item_ids.length === 0) break;

      const summaryId = await this.sealOneLevel(userId, treeId, kind, level, buf);
      if (!summaryId) break;
      sealedIds.push(summaryId);
      level += 1;
    }
    return sealedIds;
  }

  /** @deprecated Use {@link cascadeAllFrom} */
  async cascadeSeal(userId: number, treeId: string, kind: TreeKind, startLevel: number): Promise<void> {
    await this.cascadeAllFrom(userId, treeId, kind, startLevel);
  }

  /**
   * Force-seal a tree from L0 (openhuman `force_flush_tree`).
   */
  async forceFlushTree(userId: number, treeId: string, forceNowMs?: number): Promise<string[]> {
    const tree = await this.store.getTree(userId, treeId);
    if (!tree) throw new Error(`tree not found: ${treeId}`);
    return this.cascadeAllFrom(userId, treeId, tree.kind, 0, forceNowMs ?? nowMs());
  }

  private async sealOneLevel(
    userId: number,
    treeId: string,
    kind: TreeKind,
    level: number,
    buf: BufferRow,
  ): Promise<string | null> {
    const inputs = await this.loadSummaryInputs(userId, treeId, level, buf.item_ids);
    if (inputs.length === 0) return null;

    const out = await this.summarizer.summarize(inputs, {
      tree_id: treeId,
      tree_kind: kind,
      target_level: level + 1,
      token_budget: OUTPUT_TOKEN_BUDGET,
    });
    const summaryId = newSummaryId(treeId, level + 1);
    const sealedAt = nowMs();
    const timeStart = Math.min(...inputs.map((i) => i.time_range_start_ms));
    const timeEnd = Math.max(...inputs.map((i) => i.time_range_end_ms));
    const score = Math.max(...inputs.map((i) => i.score));

    await this.store.withTransaction(async (client) => {
      await this.store.insertSummary(client, userId, {
        id: summaryId,
        tree_id: treeId,
        tree_kind: kind,
        level: level + 1,
        parent_id: null,
        child_ids: buf.item_ids,
        content: out.content,
        token_count: out.token_count,
        entities: out.entities,
        topics: out.topics,
        time_range_start_ms: timeStart,
        time_range_end_ms: timeEnd,
        score,
        sealed_at_ms: sealedAt,
      });

      if (level === 0) {
        for (const cid of buf.item_ids) {
          await this.store.setChunkLifecycle(userId, cid, "sealed");
        }
      }

      await this.store.upsertBuffer(client, userId, {
        tree_id: treeId,
        level,
        item_ids: [],
        token_sum: 0,
        oldest_at_ms: null,
      });

      const nextBuf = await this.store.getBuffer(userId, treeId, level + 1);
      const nextIds = nextBuf.item_ids.includes(summaryId)
        ? nextBuf.item_ids
        : [...nextBuf.item_ids, summaryId];
      await this.store.upsertBuffer(client, userId, {
        tree_id: treeId,
        level: level + 1,
        item_ids: nextIds,
        token_sum: nextBuf.token_sum + out.token_count,
        oldest_at_ms: nextBuf.oldest_at_ms ?? sealedAt,
      });

      const tree = await this.store.getTree(userId, treeId);
      const maxLevel = Math.max(tree?.max_level ?? 0, level + 1);
      await this.store.updateTreeAfterSeal(client, userId, treeId, summaryId, maxLevel, sealedAt);
    });

    return summaryId;
  }

  private async loadSummaryInputs(
    userId: number,
    _treeId: string,
    level: number,
    itemIds: string[],
  ): Promise<SummaryInput[]> {
    const inputs: SummaryInput[] = [];
    for (const id of itemIds) {
      if (level === 0) {
        const row = await this.store.getChunk(userId, id);
        if (!row) continue;
        inputs.push({
          id,
          content: String(row.content),
          token_count: Number(row.token_count),
          time_range_start_ms: Number(row.time_range_start_ms),
          time_range_end_ms: Number(row.time_range_end_ms),
          score: 0.5,
          entities: [],
          topics: (row.tags_json as string[]) ?? [],
        });
      } else {
        const s = await this.store.getSummary(userId, id);
        if (!s) continue;
        inputs.push({
          id,
          content: s.content,
          token_count: s.token_count,
          time_range_start_ms: s.time_range_start_ms,
          time_range_end_ms: s.time_range_end_ms,
          score: s.score,
          entities: s.entities,
          topics: s.topics,
        });
      }
    }
    return inputs;
  }

  /**
   * Time-based L0 flush (openhuman `flush_stale_buffers`).
   * Returns the number of seal operations that actually ran.
   */
  async flushStaleBuffers(userId: number, maxAgeMs: number): Promise<number> {
    const cutoff = nowMs() - maxAgeMs;
    const stale = await this.store.listStaleL0Buffers(userId, cutoff);
    let seals = 0;
    const forceAt = nowMs();
    for (const buf of stale) {
      const tree = await this.store.getTree(userId, buf.tree_id);
      if (!tree || buf.item_ids.length === 0) continue;
      const sealed = await this.cascadeAllFrom(userId, buf.tree_id, tree.kind, buf.level, forceAt);
      seals += sealed.length;
    }
    return seals;
  }
}
