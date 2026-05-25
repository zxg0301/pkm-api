#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import Busboy from "busboy";
import { pool, minioClient, MINIO_BUCKET } from "./common.js";

// ── CORS + JSON 响应辅助 ──
function setCORS(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-EduNex-User-Id");
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const rawValue = req.headers[name.toLowerCase()];
  if (Array.isArray(rawValue)) {
    return rawValue[0]?.trim() || undefined;
  }

  return typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : undefined;
}

function fixFilename(name: string): string {
  try {
    const bytes = Buffer.from(name, "latin1");
    if (bytes.equals(Buffer.from(bytes.toString("utf8"), "utf8"))) {
      return bytes.toString("utf8");
    }
  } catch {
    // not valid UTF-8, return original
  }
  return name;
}

function resolveEduNexUserId(req: IncomingMessage, res: ServerResponse): number | null {
  const rawUserId = readHeaderValue(req, "x-edunex-user-id");
  if (!rawUserId) {
    json(res, 401, { error: "missing x-edunex-user-id header" });
    return null;
  }

  const userId = Number.parseInt(rawUserId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    json(res, 400, { error: "x-edunex-user-id must be a positive integer" });
    return null;
  }

  return userId;
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
    // GET /knowledge — 获取当前 EduNex 用户的知识文档列表
    if (req.method === "GET" && path === "/knowledge") {
      const userId = resolveEduNexUserId(req, res);
      if (userId === null) {
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

    // GET /knowledge/:id — 获取当前 EduNex 用户可见的单个知识文档详情
    if (req.method === "GET" && /^\/knowledge\/\d+$/.test(path)) {
      const userId = resolveEduNexUserId(req, res);
      if (userId === null) {
        return;
      }
      const id = parseInt(path.split("/").pop()!, 10);
      const { rows } = await pool.query(
        `SELECT id, user_id, title, summary_md, source_files, tags, created_at
         FROM PKM.knowledge_docs WHERE id = $1 AND user_id = $2`,
        [id, userId],
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

    // GET /attachments — 获取当前 EduNex 用户的附件列表
    if (req.method === "GET" && path === "/attachments") {
      const userId = resolveEduNexUserId(req, res);
      if (userId === null) {
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

    // GET /attachment/:id — 下载当前 EduNex 用户可见的附件文件
    if (req.method === "GET" && /^\/attachment\/\d+$/.test(path)) {
      const userId = resolveEduNexUserId(req, res);
      if (userId === null) {
        return;
      }
      const id = parseInt(path.split("/").pop()!, 10);
      const { rows } = await pool.query(
        `SELECT a.id, a.doc_id, a.file_name, a.minio_key, a.content_type, a.file_size
         FROM PKM.attachments a
         JOIN PKM.knowledge_docs d ON d.id = a.doc_id
         WHERE a.id = $1 AND d.user_id = $2`,
        [id, userId],
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

    // POST /knowledge/upload — 上传文件创建知识文档
    if (req.method === "POST" && path === "/knowledge/upload") {
      const userId = resolveEduNexUserId(req, res);
      if (userId === null) {
        return;
      }

      const fields: Record<string, string> = {};
      const fileEntries: Array<{ fileName: string; contentType: string; buffer: Buffer }> = [];

      const busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: 50 * 1024 * 1024 },
      });

      busboy.on("field", (name, value) => {
        if (name === "title" || name === "tags") {
          fields[name] = value;
        }
      });

      busboy.on("file", (name, stream, info) => {
        if (name !== "files") {
          stream.resume();
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          fileEntries.push({
            fileName: fixFilename(info.filename || "untitled"),
            contentType: info.mimeType || "application/octet-stream",
            buffer: Buffer.concat(chunks),
          });
        });
      });

      busboy.on("close", async () => {
        try {
          if (fileEntries.length === 0) {
            json(res, 400, { error: "No files provided" });
            return;
          }

          const title = fields.title?.trim() || fileEntries[0].fileName;
          const tags = fields.tags?.trim() || "";

          const { rows: docRows } = await pool.query(
            `INSERT INTO PKM.knowledge_docs (user_id, title, tags) VALUES ($1, $2, $3) RETURNING id, user_id, title, tags, created_at`,
            [userId, title, tags],
          );
          const doc = docRows[0];

          const attachments: Array<{
            id: number;
            doc_id: number;
            file_name: string;
            minio_key: string;
            content_type: string;
            file_size: number;
            created_at: string;
          }> = [];

          for (const entry of fileEntries) {
            const minioKey = `${userId}/${doc.id}/${entry.fileName}`;
            await minioClient.putObject(MINIO_BUCKET, minioKey, entry.buffer, entry.buffer.length, {
              "Content-Type": entry.contentType,
            });

            const { rows: attRows } = await pool.query(
              `INSERT INTO PKM.attachments (doc_id, file_name, minio_key, content_type, file_size)
               VALUES ($1, $2, $3, $4, $5) RETURNING id, doc_id, file_name, minio_key, content_type, file_size, created_at`,
              [doc.id, entry.fileName, minioKey, entry.contentType, entry.buffer.length],
            );
            attachments.push(attRows[0]);
          }

          json(res, 201, { ...doc, attachments });
        } catch (err) {
          console.error("Upload error:", err);
          json(res, 500, { error: "Internal server error" });
        }
      });

      req.pipe(busboy);
      return;
    }

    // PATCH /knowledge/:id — 更新知识文档（标题、标签、摘要）
    if (req.method === "PATCH" && /^\/knowledge\/\d+$/.test(path)) {
      const userId = resolveEduNexUserId(req, res);
      if (userId === null) {
        return;
      }
      const id = parseInt(path.split("/").pop()!, 10);

      // 验证文档存在且属于当前用户
      const { rows: docRows } = await pool.query(
        `SELECT id FROM PKM.knowledge_docs WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (docRows.length === 0) {
        json(res, 404, { error: `Doc id=${id} not found` });
        return;
      }

      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      let update: { title?: string; tags?: string; summary_md?: string };
      try {
        update = JSON.parse(body);
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }

      // 构建动态更新字段
      const fields: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (update.title !== undefined) {
        fields.push(`title = $${paramIndex++}`);
        values.push(update.title);
      }
      if (update.tags !== undefined) {
        fields.push(`tags = $${paramIndex++}`);
        values.push(update.tags);
      }
      if (update.summary_md !== undefined) {
        fields.push(`summary_md = $${paramIndex++}`);
        values.push(update.summary_md);
      }

      if (fields.length === 0) {
        json(res, 400, { error: "No fields to update" });
        return;
      }

      values.push(id, userId);
      const { rows } = await pool.query(
        `UPDATE PKM.knowledge_docs SET ${fields.join(", ")} WHERE id = $${paramIndex++} AND user_id = $${paramIndex} RETURNING id, user_id, title, summary_md, source_files, tags, created_at`,
        values,
      );

      const { rows: atts } = await pool.query(
        `SELECT id, file_name, minio_key, content_type, file_size, created_at
         FROM PKM.attachments WHERE doc_id = $1 ORDER BY created_at`,
        [id],
      );

      json(res, 200, { ...rows[0], attachments: atts });
      return;
    }

    // DELETE /knowledge/:id — 删除知识文档及其附件
    if (req.method === "DELETE" && /^\/knowledge\/\d+$/.test(path)) {
      const userId = resolveEduNexUserId(req, res);
      if (userId === null) {
        return;
      }
      const id = parseInt(path.split("/").pop()!, 10);

      // 验证文档存在且属于当前用户
      const { rows: docRows } = await pool.query(
        `SELECT id FROM PKM.knowledge_docs WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (docRows.length === 0) {
        json(res, 404, { error: `Doc id=${id} not found` });
        return;
      }

      // 获取附件的 MinIO key 以便清理对象存储
      const { rows: attRows } = await pool.query(
        `SELECT minio_key FROM PKM.attachments WHERE doc_id = $1`,
        [id],
      );

      // 删除附件记录和文档记录
      await pool.query(`DELETE FROM PKM.attachments WHERE doc_id = $1`, [id]);
      await pool.query(`DELETE FROM PKM.knowledge_docs WHERE id = $1 AND user_id = $2`, [id, userId]);

      // 清理 MinIO 对象
      for (const att of attRows) {
        try {
          await minioClient.removeObject(MINIO_BUCKET, att.minio_key);
        } catch (err) {
          console.error(`Failed to remove MinIO object ${att.minio_key}:`, err);
        }
      }

      json(res, 200, { id, deleted: true });
      return;
    }

    json(res, 404, { error: "Not found", available: ["/knowledge", "/knowledge/:id (GET/DELETE/PATCH)", "/attachments", "/attachment/:id", "/knowledge/upload"] });
  } catch (err) {
    console.error("API error:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

async function main() {
  createServer(handler).listen(API_PORT, () => {
    console.log(`REST API server listening on http://0.0.0.0:${API_PORT}`);
  });
}

main().catch((err) => {
  console.error("API server failed:", err);
  process.exit(1);
});
