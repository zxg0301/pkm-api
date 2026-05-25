import type { SummaryInput } from "./types.js";
import { OUTPUT_TOKEN_BUDGET } from "./types.js";

export function approxTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** 对齐 openhuman fallback_summary：拼接并截断到 token 预算 */
export function fallbackSummary(
  inputs: SummaryInput[],
  budget = OUTPUT_TOKEN_BUDGET,
): { content: string; token_count: number; entities: string[]; topics: string[] } {
  const parts: string[] = [];
  for (const inp of inputs) {
    const trimmed = inp.content.trim();
    if (trimmed) parts.push(`— ${trimmed}`);
  }
  const joined = parts.join("\n\n");
  const { text, tokens } = clampToBudget(joined, budget);
  const entities = [...new Set(inputs.flatMap((i) => i.entities))].sort();
  const topics = [...new Set(inputs.flatMap((i) => i.topics))].sort();
  return { content: text, token_count: tokens, entities, topics };
}

function clampToBudget(text: string, budget: number): { text: string; tokens: number } {
  let tokens = approxTokenCount(text);
  if (tokens <= budget) return { text, tokens };
  const charCeiling = budget * 4;
  const truncated = [...text].slice(0, charCeiling).join("");
  tokens = approxTokenCount(truncated);
  return { text: truncated, tokens };
}
