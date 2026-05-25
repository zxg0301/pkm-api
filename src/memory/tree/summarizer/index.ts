import { CompositeSummarizer } from "./composite.js";
import { FallbackSummarizer } from "./fallback.js";
import { createLlmSummarizerOrThrow, HttpLlmSummarizer, llmConfigFromEnv } from "./llm.js";
import type { MemoryTreeSummarizer } from "./types.js";

export type { MemoryTreeSummarizer, SummaryContext, SummaryOutput } from "./types.js";
export { FallbackSummarizer } from "./fallback.js";
export { HttpLlmSummarizer, llmConfigFromEnv } from "./llm.js";
export { CompositeSummarizer } from "./composite.js";

export type SummarizerMode = "fallback" | "llm" | "auto";

function modeFromEnv(): SummarizerMode {
  const raw = (process.env.MEMORY_SUMMARIZER ?? "auto").trim().toLowerCase();
  if (raw === "fallback" || raw === "llm" || raw === "auto") return raw;
  console.warn(`[memory-tree] unknown MEMORY_SUMMARIZER=${raw}, using auto`);
  return "auto";
}

/**
 * 根据环境变量创建摘要器。
 *
 * | MEMORY_SUMMARIZER | 行为 |
 * |-------------------|------|
 * | `fallback`        | 仅确定性拼接 |
 * | `llm`             | 仅 LLM（失败抛错，密封事务会失败） |
 * | `auto`（默认）    | 已配置 API 则 LLM + fallback，否则仅 fallback |
 */
export function createSummarizer(): MemoryTreeSummarizer {
  const mode = modeFromEnv();
  const fallback = new FallbackSummarizer();

  if (mode === "fallback") return fallback;

  const llmCfg = llmConfigFromEnv();
  if (mode === "llm") {
    return createLlmSummarizerOrThrow();
  }

  // auto
  const primary = llmCfg ? new HttpLlmSummarizer(llmCfg) : null;
  if (primary) {
    console.info(`[memory-tree] summarizer=auto primary=${primary.name}`);
  }
  return new CompositeSummarizer(primary, fallback);
}
