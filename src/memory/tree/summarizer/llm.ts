import { approxTokenCount } from "../summarize.js";
import type { SummaryInput } from "../types.js";
import type { MemoryTreeSummarizer, SummaryContext, SummaryOutput } from "./types.js";

const MAX_OUTPUT_TOKENS = 5000;
const NUM_CTX_TOKENS = 60_000;
const OVERHEAD_RESERVE = 2048;

export interface LlmSummarizerConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 可选：输出语言提示，如 `zh-CN` */
  outputLanguage?: string;
}

function buildSystemPrompt(budget: number, lang?: string): string {
  const langLine = lang?.trim() ? `\nWrite the summary in ${lang.trim()}.` : "";
  return (
    "You are folding multiple notes into one compact summary.\n" +
    `Aim for ~${budget} tokens or fewer. Capture key facts, decisions, and entities.\n` +
    `Output only the summary prose — no preamble, no JSON, no markdown headings.${langLine}`
  );
}

function buildUserPrompt(inputs: SummaryInput[], perInputCapTokens: number): string {
  const parts: string[] = [];
  for (const inp of inputs) {
    const trimmed = inp.content.trim();
    if (!trimmed) continue;
    const charCap = perInputCapTokens * 4;
    const clamped = [...trimmed].slice(0, charCap).join("");
    parts.push(`[${inp.id}]\n${clamped}`);
  }
  return parts.join("\n\n");
}

/**
 * OpenAI 兼容 Chat Completions 摘要器。
 * 未配置或请求失败时由 CompositeSummarizer 回退到 fallback。
 */
export class HttpLlmSummarizer implements MemoryTreeSummarizer {
  readonly name = "openai-compatible";

  constructor(private readonly config: LlmSummarizerConfig) {}

  async summarize(inputs: SummaryInput[], ctx: SummaryContext): Promise<SummaryOutput> {
    if (inputs.length === 0) {
      return { content: "", token_count: 0, entities: [], topics: [] };
    }

    const budget = Math.min(ctx.token_budget, MAX_OUTPUT_TOKENS);
    const perInputCap =
      inputs.length > 0
        ? Math.floor((NUM_CTX_TOKENS - OVERHEAD_RESERVE) / inputs.length)
        : 0;

    const body = {
      model: this.config.model,
      temperature: 0.2,
      max_tokens: budget,
      messages: [
        { role: "system", content: buildSystemPrompt(budget, this.config.outputLanguage) },
        { role: "user", content: buildUserPrompt(inputs, perInputCap) },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(this.config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 500)}`);
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content?.trim() ?? "";
      if (!content) throw new Error("LLM returned empty content");

      const entities = [...new Set(inputs.flatMap((i) => i.entities))].sort();
      const topics = [...new Set(inputs.flatMap((i) => i.topics))].sort();
      return {
        content,
        token_count: approxTokenCount(content),
        entities,
        topics,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 从环境变量解析 LLM 配置；缺项时返回 null */
export function llmConfigFromEnv(): LlmSummarizerConfig | null {
  const apiUrl = process.env.MEMORY_SUMMARIZER_API_URL?.trim();
  const apiKey = process.env.MEMORY_SUMMARIZER_API_KEY?.trim();
  const model = process.env.MEMORY_SUMMARIZER_MODEL?.trim() || "gpt-4o-mini";
  if (!apiUrl || !apiKey) return null;

  const timeoutMs = parseInt(process.env.MEMORY_SUMMARIZER_TIMEOUT_MS ?? "120000", 10);
  const outputLanguage = process.env.MEMORY_SUMMARIZER_OUTPUT_LANGUAGE?.trim();

  return {
    apiUrl,
    apiKey,
    model,
    timeoutMs: Number.isNaN(timeoutMs) ? 120_000 : timeoutMs,
    outputLanguage: outputLanguage || undefined,
  };
}

/**
 * 仅 LLM、失败则抛错（供测试）；生产密封请用 {@link createSummarizer}。
 */
export function createLlmSummarizerOrThrow(): HttpLlmSummarizer {
  const cfg = llmConfigFromEnv();
  if (!cfg) {
    throw new Error(
      "MEMORY_SUMMARIZER_API_URL and MEMORY_SUMMARIZER_API_KEY are required for LLM summarizer",
    );
  }
  return new HttpLlmSummarizer(cfg);
}
