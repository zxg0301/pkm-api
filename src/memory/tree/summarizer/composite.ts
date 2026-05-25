import { FallbackSummarizer } from "./fallback.js";
import type { MemoryTreeSummarizer, SummaryContext, SummaryOutput } from "./types.js";
import type { SummaryInput } from "../types.js";

/**
 * 先尝试主摘要器（通常为 LLM），失败则回退到确定性 fallback。
 * 对齐 openhuman seal 路径：summarise 失败时使用 fallback_summary。
 */
export class CompositeSummarizer implements MemoryTreeSummarizer {
  readonly name;

  constructor(
    private readonly primary: MemoryTreeSummarizer | null,
    private readonly fallback: MemoryTreeSummarizer = new FallbackSummarizer(),
  ) {
    this.name = primary ? `${primary.name}+${fallback.name}` : fallback.name;
  }

  async summarize(inputs: SummaryInput[], ctx: SummaryContext): Promise<SummaryOutput> {
    if (this.primary) {
      try {
        return await this.primary.summarize(inputs, ctx);
      } catch (err) {
        console.warn(
          `[memory-tree] summarizer ${this.primary.name} failed, using fallback:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return this.fallback.summarize(inputs, ctx);
  }
}
