import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { sanitizeNamespace } from "../sanitize.js";
import { createSummarizer } from "./summarizer/index.js";
import { TreePipeline } from "./pipeline.js";
import { TreeQuery } from "./query.js";
import { DEFAULT_FLUSH_AGE_MS, OUTPUT_TOKEN_BUDGET } from "./types.js";
import type { SummaryInput } from "./types.js";

type JsonFn = (res: ServerResponse, status: number, data: unknown) => void;

function parseUserId(url: URL, body?: Record<string, unknown>): number {
  const raw = url.searchParams.get("user_id") ?? (body?.user_id != null ? String(body.user_id) : "0");
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? 0 : id;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function handleMemoryTreeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  json: JsonFn,
  pool: Pool,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/memory/tree")) return false;

  const pipeline = new TreePipeline(pool);
  const store = pipeline.getStore();
  const query = new TreeQuery(store);

  try {
    // GET /memory/tree/stats?user_id=0
    if (req.method === "GET" && path === "/memory/tree/stats") {
      const userId = parseUserId(url);
      const stats = await store.stats(userId);
      json(res, 200, { user_id: userId, stats });
      return true;
    }

    // GET /memory/tree/sources?user_id=0
    if (req.method === "GET" && path === "/memory/tree/sources") {
      const userId = parseUserId(url);
      const sources = await store.listSources(userId);
      json(res, 200, {
        user_id: userId,
        sources: sources.map((s) => ({
          ...s,
          display_name: s.source_id.replace(/^doc:/, "").replace(/:/g, " / "),
        })),
      });
      return true;
    }

    // GET /memory/tree/chunks?user_id=0&source_id=&limit=
    if (req.method === "GET" && path === "/memory/tree/chunks") {
      const userId = parseUserId(url);
      const result = await store.listChunks(userId, {
        source_id: url.searchParams.get("source_id") ?? undefined,
        source_kind: url.searchParams.get("source_kind") ?? undefined,
        lifecycle_status: (url.searchParams.get("lifecycle_status") as never) ?? undefined,
        since_ms: url.searchParams.get("since_ms")
          ? parseInt(url.searchParams.get("since_ms")!, 10)
          : undefined,
        limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined,
        offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : undefined,
      });
      json(res, 200, { user_id: userId, ...result });
      return true;
    }

    // GET /memory/tree/trees?user_id=0&kind=source|topic|global
    if (req.method === "GET" && path === "/memory/tree/trees") {
      const userId = parseUserId(url);
      const kind = url.searchParams.get("kind") as "source" | "topic" | "global" | null;
      const trees = await store.listTrees(userId, kind ?? undefined);
      json(res, 200, { user_id: userId, count: trees.length, trees });
      return true;
    }

    // GET /memory/tree/summaries?user_id=0&tree_id=&kind=&scope=
    if (req.method === "GET" && path === "/memory/tree/summaries") {
      const userId = parseUserId(url);
      const summaries = await store.listSummaries(userId, {
        tree_id: url.searchParams.get("tree_id") ?? undefined,
        kind: (url.searchParams.get("kind") as "source" | "topic" | "global") ?? undefined,
        scope: url.searchParams.get("scope") ?? undefined,
        since_ms: url.searchParams.get("since_ms")
          ? parseInt(url.searchParams.get("since_ms")!, 10)
          : undefined,
        limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 20,
      });
      json(res, 200, { user_id: userId, count: summaries.length, summaries });
      return true;
    }

    // POST /memory/tree/query/source
    if (req.method === "POST" && path === "/memory/tree/query/source") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const result = await query.querySource(userId, {
        source_id: body.source_id != null ? String(body.source_id) : undefined,
        time_window_days: body.time_window_days != null ? Number(body.time_window_days) : undefined,
        query: body.query != null ? String(body.query) : undefined,
        limit: body.limit != null ? Number(body.limit) : undefined,
      });
      json(res, 200, { user_id: userId, ...result });
      return true;
    }

    // POST /memory/tree/query/topic
    if (req.method === "POST" && path === "/memory/tree/query/topic") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const entityId = String(body.entity_id ?? "");
      if (!entityId) {
        json(res, 400, { error: "entity_id is required" });
        return true;
      }
      const result = await query.queryTopic(userId, entityId, {
        query: body.query != null ? String(body.query) : undefined,
        limit: body.limit != null ? Number(body.limit) : undefined,
      });
      json(res, 200, { user_id: userId, entity_id: entityId, ...result });
      return true;
    }

    // POST /memory/tree/query/global
    if (req.method === "POST" && path === "/memory/tree/query/global") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const result = await query.queryGlobal(userId, {
        time_window_days: body.time_window_days != null ? Number(body.time_window_days) : undefined,
        query: body.query != null ? String(body.query) : undefined,
        limit: body.limit != null ? Number(body.limit) : undefined,
      });
      json(res, 200, { user_id: userId, ...result });
      return true;
    }

    // POST /memory/tree/walk
    if (req.method === "POST" && path === "/memory/tree/walk") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const kind = String(body.kind ?? "source") as "source" | "topic" | "global";
      const scope = String(body.scope ?? "");
      if (!scope) {
        json(res, 400, { error: "scope is required" });
        return true;
      }
      const result = await query.walk(userId, kind, scope, body.max_depth != null ? Number(body.max_depth) : 5);
      json(res, 200, { user_id: userId, kind, scope, ...result });
      return true;
    }

    // POST /memory/tree/flush — 密封过期 L0 缓冲区
    if (req.method === "POST" && path === "/memory/tree/flush") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const maxAge = body.max_age_ms != null ? Number(body.max_age_ms) : DEFAULT_FLUSH_AGE_MS;
      const flushed = await pipeline.flushStale(userId, maxAge);
      json(res, 200, { user_id: userId, flushed_buffers: flushed });
      return true;
    }

    // POST /memory/tree/digest — 构建全局日摘要
    if (req.method === "POST" && path === "/memory/tree/digest") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const rootId = await pipeline.digestGlobal(userId);
      json(res, 200, { user_id: userId, global_root_id: rootId });
      return true;
    }

    // POST /memory/tree/summarize/preview — 试跑摘要器（不写入树，供联调 LLM）
    if (req.method === "POST" && path === "/memory/tree/summarize/preview") {
      const body = await readJsonBody(req);
      const items = body.items;
      if (!Array.isArray(items) || items.length === 0) {
        json(res, 400, { error: "items array is required" });
        return true;
      }
      const inputs: SummaryInput[] = items.map((item, i) => {
        const o = item as Record<string, unknown>;
        const content = String(o.content ?? "");
        const ts = Date.now();
        return {
          id: String(o.id ?? `preview-${i}`),
          content,
          token_count: Math.ceil(content.length / 4),
          time_range_start_ms: ts,
          time_range_end_ms: ts,
          score: 0.5,
          entities: [],
          topics: [],
        };
      });
      const summarizer = createSummarizer();
      const result = await summarizer.summarize(inputs, {
        tree_id: "preview",
        tree_kind: "source",
        target_level: 1,
        token_budget: body.token_budget != null ? Number(body.token_budget) : OUTPUT_TOKEN_BUDGET,
      });
      json(res, 200, { summarizer: summarizer.name, ...result });
      return true;
    }

    // POST /memory/tree/sync — 从已摄入的 memory 文档重新同步到 tree
    if (req.method === "POST" && path === "/memory/tree/sync") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const namespace = sanitizeNamespace(String(body.namespace ?? ""));
      const documentId = String(body.document_id ?? "");
      if (!namespace || !documentId) {
        json(res, 400, { error: "namespace and document_id are required" });
        return true;
      }
      const { rows } = await pool.query(
        `SELECT chunk_id, text FROM PKM.memory_chunks WHERE user_id = $1 AND namespace = $2 AND document_id = $3 ORDER BY chunk_id`,
        [userId, namespace, documentId],
      );
      const chunks = rows.map((r) => ({ chunk_id: String(r.chunk_id), text: String(r.text) }));
      const title = body.title != null ? String(body.title) : undefined;
      const result = await pipeline.syncFromMemoryChunks(userId, namespace, documentId, chunks, title);
      json(res, 200, { user_id: userId, namespace, document_id: documentId, ...result });
      return true;
    }

    json(res, 404, {
      error: "Memory tree route not found",
      available: [
        "GET /memory/tree/stats",
        "GET /memory/tree/sources",
        "GET /memory/tree/chunks",
        "GET /memory/tree/trees",
        "GET /memory/tree/summaries",
        "POST /memory/tree/query/source",
        "POST /memory/tree/query/topic",
        "POST /memory/tree/query/global",
        "POST /memory/tree/walk",
        "POST /memory/tree/flush",
        "POST /memory/tree/digest",
        "POST /memory/tree/sync",
        "POST /memory/tree/summarize/preview",
      ],
    });
    return true;
  } catch (err) {
    throw err;
  }
}
