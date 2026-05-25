import type { TreeStore } from "./store.js";
import type { SummaryRow, TreeKind } from "./types.js";
import { SUMMARY_FANOUT } from "./types.js";

export class TreeQuery {
  constructor(private readonly store: TreeStore) {}

  async querySource(
    userId: number,
    opts: {
      source_id?: string;
      time_window_days?: number;
      query?: string;
      limit?: number;
    },
  ): Promise<{ hits: SummaryRow[]; total: number }> {
    const since =
      opts.time_window_days != null
        ? Date.now() - opts.time_window_days * 86400000
        : undefined;
    let summaries: SummaryRow[];
    if (opts.source_id) {
      const tree = await this.store.listTrees(userId, "source");
      const t = tree.find((x) => x.scope === opts.source_id);
      if (!t) return { hits: [], total: 0 };
      summaries = await this.store.listSummaries(userId, { tree_id: t.id, since_ms: since, limit: 100 });
    } else {
      summaries = await this.store.listSummaries(userId, { kind: "source", since_ms: since, limit: 100 });
    }
    let hits = summaries;
    if (opts.query?.trim()) {
      const q = opts.query.toLowerCase();
      hits = hits.filter((s) => s.content.toLowerCase().includes(q));
    }
    const limit = opts.limit ?? 10;
    return { hits: hits.slice(0, limit), total: hits.length };
  }

  async queryTopic(
    userId: number,
    entityId: string,
    opts: { query?: string; limit?: number },
  ): Promise<{ hits: SummaryRow[]; total: number }> {
    const trees = await this.store.listTrees(userId, "topic");
    const t = trees.find((x) => x.scope === entityId);
    if (!t) return { hits: [], total: 0 };
    let hits = await this.store.listSummaries(userId, { tree_id: t.id, limit: 50 });
    if (opts.query?.trim()) {
      const q = opts.query.toLowerCase();
      hits = hits.filter((s) => s.content.toLowerCase().includes(q));
    }
    const limit = opts.limit ?? 10;
    return { hits: hits.slice(0, limit), total: hits.length };
  }

  async queryGlobal(
    userId: number,
    opts: { time_window_days?: number; query?: string; limit?: number },
  ): Promise<{ hits: SummaryRow[]; total: number }> {
    const since =
      opts.time_window_days != null
        ? Date.now() - opts.time_window_days * 86400000
        : undefined;
    let hits = await this.store.listSummaries(userId, { kind: "global", since_ms: since, limit: 50 });
    if (opts.query?.trim()) {
      const q = opts.query.toLowerCase();
      hits = hits.filter((s) => s.content.toLowerCase().includes(q));
    }
    const limit = opts.limit ?? 10;
    return { hits: hits.slice(0, limit), total: hits.length };
  }

  /** 遍历某棵树上的摘要节点（按 level 从低到高） */
  async walk(
    userId: number,
    kind: TreeKind,
    scope: string,
    maxDepth = 5,
  ): Promise<{ tree_id: string; nodes: SummaryRow[] }> {
    const trees = await this.store.listTrees(userId, kind);
    const tree = trees.find((t) => t.scope === scope);
    if (!tree) return { tree_id: "", nodes: [] };

    const all = await this.store.listSummaries(userId, { tree_id: tree.id, limit: 200 });
    const nodes = [...all].sort((a, b) => a.level - b.level).slice(0, maxDepth * SUMMARY_FANOUT);
    return { tree_id: tree.id, nodes };
  }
}
