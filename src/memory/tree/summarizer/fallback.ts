import { fallbackSummary } from "../summarize.js";
import type { SummaryInput } from "../types.js";
import type { MemoryTreeSummarizer, SummaryContext, SummaryOutput } from "./types.js";

/** 确定性拼接截断摘要（对齐 openhuman fallback_summary） */
export class FallbackSummarizer implements MemoryTreeSummarizer {
  readonly name = "fallback";

  async summarize(inputs: SummaryInput[], ctx: SummaryContext): Promise<SummaryOutput> {
    return fallbackSummary(inputs, ctx.token_budget);
  }
}
