#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { pool, minioClient, MINIO_BUCKET } from "./common.js";

/** 默认关闭；设为 true 时才挂载 /memory/* 路由（动态加载，不影响原有知识库 API） */
const MEMORY_API_ENABLED = process.env.MEMORY_API_ENABLED === "true";

type MemoryRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  pool: typeof import("./common.js").pool,
) => Promise<boolean>;

let handleMemoryRoute: MemoryRouteHandler | null = null;

async function loadMemoryRoutes(): Promise<MemoryRouteHandler> {
  if (!handleMemoryRoute) {
    const mod = await import("./memory/routes.js");
    handleMemoryRoute = mod.handleMemoryRoute;
  }
  return handleMemoryRoute;
}

// ── CORS + JSON 响应辅助（知识库原有接口） ──
function setCORS(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// ── 路由 ──
const API_PORT = parseInt(process.env.API_PORT ?? "3001", 10);

async function handler(req: IncomingMessage, res: ServerResponse) {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${API_PORT}`);
  const path = url.pathname;

  try {
    // Memory 为可选模块：未启用时 /memory/* 不会进入 memory 处理器
    if (MEMORY_API_ENABLED && path.startsWith("/memory")) {
      const memoryHandler = await loadMemoryRoutes();
      if (await memoryHandler(req, res, url, json, pool)) {
        return;
      }
    }

    // GET /knowledge?user_id=0  — 获取用户所有知识文档列表
    if (req.method === "GET" && path === "/knowledge") {
      const userId = parseInt(url.searchParams.get("user_id") ?? "0", 10);
      if (isNaN(userId)) {
        json(res, 400, { error: "user_id must be an integer" });
        return;
      }
      const { rows } = await pool.query(
        `SELECT id, user_id, title, tags, created_at,
          (SELECT count(*) FROM PKM.attachments WHERE doc_id = PKM.knowledge_docs.id) AS attachment_count
         FROM PKM.knowledge_docs
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId],
      );
      json(res, 200, { user_id: userId, count: rows.length, docs: rows });
      return;
    }

    // GET /knowledge/:id — 获取单个知识文档详情
    if (req.method === "GET" && /^\/knowledge\/\d+$/.test(path)) {
      const id = parseInt(path.split("/").pop()!, 10);
      const { rows } = await pool.query(
        `SELECT id, user_id, title, summary_md, source_files, tags, created_at
         FROM PKM.knowledge_docs WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) {
        json(res, 404, { error: `Doc id=${id} not found` });
        return;
      }
      const { rows: atts } = await pool.query(
        `SELECT id, file_name, minio_key, content_type, file_size, created_at
         FROM PKM.attachments WHERE doc_id = $1 ORDER BY created_at`,
        [id],
      );
      json(res, 200, { ...rows[0], attachments: atts });
      return;
    }

    // GET /attachments?user_id=0 — 获取用户所有附件列表
    if (req.method === "GET" && path === "/attachments") {
      const userId = parseInt(url.searchParams.get("user_id") ?? "0", 10);
      if (isNaN(userId)) {
        json(res, 400, { error: "user_id must be an integer" });
        return;
      }
      const { rows } = await pool.query(
        `SELECT a.id, a.doc_id, a.file_name, a.content_type, a.file_size, a.created_at,
                d.title AS doc_title
         FROM PKM.attachments a
         JOIN PKM.knowledge_docs d ON d.id = a.doc_id
         WHERE d.user_id = $1
         ORDER BY a.created_at DESC`,
        [userId],
      );
      const groups: Record<string, { doc_id: number; doc_title: string; attachments: typeof rows }> = {};
      for (const row of rows) {
        const key = String(row.doc_id);
        if (!groups[key]) {
          groups[key] = { doc_id: row.doc_id, doc_title: row.doc_title, attachments: [] };
        }
        groups[key].attachments.push(row);
      }
      const folders = Object.values(groups);
      json(res, 200, { user_id: userId, doc_count: folders.length, total_attachments: rows.length, folders });
      return;
    }

    // GET /attachment/:id — 从 MinIO 下载附件文件
    if (req.method === "GET" && /^\/attachment\/\d+$/.test(path)) {
      const id = parseInt(path.split("/").pop()!, 10);
      const { rows } = await pool.query(
        `SELECT id, doc_id, file_name, minio_key, content_type, file_size
         FROM PKM.attachments WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) {
        json(res, 404, { error: `Attachment id=${id} not found` });
        return;
      }
      const att = rows[0];
      const encodedName = encodeURIComponent(att.file_name);
      const dataStream = await minioClient.getObject(MINIO_BUCKET, att.minio_key);
      res.writeHead(200, {
        "Content-Type": att.content_type ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
      });
      dataStream.pipe(res);
      return;
    }

    json(res, 404, {
      error: "Not found",
      available: ["/knowledge", "/knowledge/:id", "/attachments", "/attachment/:id"],
    });
  } catch (err) {
    console.error("API error:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

async function main() {
  if (MEMORY_API_ENABLED) {
    await loadMemoryRoutes();
    console.log("Memory API enabled (/memory/*)");
  }

  createServer(handler).listen(API_PORT, () => {
    console.log(`REST API server listening on http://0.0.0.0:${API_PORT}`);
  });
}

main().catch((err) => {
  console.error("API server failed:", err);
  process.exit(1);
});
