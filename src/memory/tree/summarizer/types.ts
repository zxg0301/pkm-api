import type { SummaryInput, TreeKind } from "../types.js";

/** 单次密封的上下文（对齐 openhuman SummaryContext） */
export interface SummaryContext {
  tree_id: string;
  tree_kind: TreeKind;
  /** 密封后摘要节点所在 level（L0→L1 时为 1） */
  target_level: number;
  token_budget: number;
}

export interface SummaryOutput {
  content: string;
  token_count: number;
  entities: string[];
  topics: string[];
}

/**
 * Memory Tree 摘要器接口。
 * 实现方可调用 LLM；密封流水线在失败时必须能回退到确定性摘要。
 */
export interface MemoryTreeSummarizer {
  /** 实现标识，如 `fallback`、`openai-compatible` */
  readonly name: string;
  summarize(inputs: SummaryInput[], ctx: SummaryContext): Promise<SummaryOutput>;
}
