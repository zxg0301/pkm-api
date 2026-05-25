import { createSummarizer, type MemoryTreeSummarizer } from "./summarizer/index.js";
import type { TreeStore } from "./store.js";
import { nowMs } from "./store.js";
import type { BufferRow, SummaryInput, TreeKind } from "./types.js";
import { INPUT_TOKEN_BUDGET, OUTPUT_TOKEN_BUDGET, SUMMARY_FANOUT } from "./types.js";

const MAX_CASCADE = 32;

function newSummaryId(treeId: string, level: number): string {
  return `${treeId}__L${level}__${nowMs()}__${Math.random().toString(36).slice(2, 8)}`;
}

export class TreeSealer {
  constructor(
    private readonly store: TreeStore,
    private readonly summarizer: MemoryTreeSummarizer = createSummarizer(),
  ) {}

  async appendLeaf(
    userId: number,
    treeId: string,
    kind: TreeKind,
    chunkId: string,
    tokenCount: number,
  ): Promise<void> {
    await this.store.withTransaction(async (client) => {
      let buf = await this.store.getBuffer(userId, treeId, 0);
      const ts = nowMs();
      if (!buf.item_ids.includes(chunkId)) {
        buf = {
          tree_id: treeId,
          level: 0,
          item_ids: [...buf.item_ids, chunkId],
          token_sum: buf.token_sum + tokenCount,
          oldest_at_ms: buf.oldest_at_ms ?? ts,
        };
        await this.store.upsertBuffer(client, userId, buf);
      }
    });
    await this.cascadeSeal(userId, treeId, kind, 0);
  }

  async cascadeSeal(userId: number, treeId: string, kind: TreeKind, startLevel: number): Promise<void> {
    let level = startLevel;
    for (let depth = 0; depth < MAX_CASCADE; depth++) {
      const buf = await this.store.getBuffer(userId, treeId, level);
      if (buf.item_ids.length === 0) break;

      const shouldSeal =
        level === 0 ? buf.token_sum >= INPUT_TOKEN_BUDGET : buf.item_ids.length >= SUMMARY_FANOUT;
      if (!shouldSeal) break;

      const sealed = await this.sealOneLevel(userId, treeId, kind, level, buf);
      if (!sealed) break;
      level += 1;
    }
  }

  private async sealOneLevel(
    userId: number,
    treeId: string,
    kind: TreeKind,
    level: number,
    buf: BufferRow,
  ): Promise<boolean> {
    const inputs = await this.loadSummaryInputs(userId, treeId, level, buf.item_ids);
    if (inputs.length === 0) return false;

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
      await this.store.upsertBuffer(client, userId, {
        tree_id: treeId,
        level: level + 1,
        item_ids: [...nextBuf.item_ids, summaryId],
        token_sum: nextBuf.token_sum + out.token_count,
        oldest_at_ms: nextBuf.oldest_at_ms ?? sealedAt,
      });

      const tree = await this.store.getTree(userId, treeId);
      const maxLevel = Math.max(tree?.max_level ?? 0, level + 1);
      await this.store.updateTreeAfterSeal(client, userId, treeId, summaryId, maxLevel, sealedAt);
    });

    return true;
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

  async flushStaleBuffers(userId: number, maxAgeMs: number): Promise<number> {
    const cutoff = nowMs() - maxAgeMs;
    const stale = await this.store.listStaleL0Buffers(userId, cutoff);
    let flushed = 0;
    for (const buf of stale) {
      const tree = await this.store.getTree(userId, buf.tree_id);
      if (!tree || buf.item_ids.length === 0) continue;
      await this.cascadeSeal(userId, buf.tree_id, tree.kind, 0);
      flushed++;
    }
    return flushed;
  }
}
