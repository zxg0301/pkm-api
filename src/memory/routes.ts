import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { parseUserId, readJsonBody } from "./http.js";
import { MemoryRetrieval } from "./retrieval.js";
import { MemoryStore, resolveNamespaceParam } from "./store.js";
import { sanitizeNamespace } from "./sanitize.js";
import { handleMemoryTreeRoute } from "./tree/routes.js";
import { TreePipeline } from "./tree/pipeline.js";
import type { NamespaceDocumentInput } from "./types.js";

type JsonFn = (res: ServerResponse, status: number, data: unknown) => void;

/** Memory 路由使用扩展方法，不改动知识库 API 的 CORS */
function setMemoryCORS(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function docInputFromBody(body: Record<string, unknown>): NamespaceDocumentInput {
  if (!body.namespace || !body.key || !body.title || !body.content) {
    throw new Error("namespace, key, title, content are required");
  }
  return {
    namespace: String(body.namespace),
    key: String(body.key),
    title: String(body.title),
    content: String(body.content),
    source_type: body.source_type != null ? String(body.source_type) : undefined,
    priority: body.priority != null ? String(body.priority) : undefined,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
    metadata:
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : undefined,
    category: body.category != null ? String(body.category) : undefined,
    session_id: body.session_id != null ? String(body.session_id) : undefined,
    document_id: body.document_id != null ? String(body.document_id) : undefined,
  };
}

export async function handleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  json: JsonFn,
  pool: Pool,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/memory")) return false;

  setMemoryCORS(res);

  if (await handleMemoryTreeRoute(req, res, url, json, pool)) {
    return true;
  }

  const store = new MemoryStore(pool);
  const retrieval = new MemoryRetrieval(store);
  const treePipeline = new TreePipeline(pool);

  try {
    // GET /memory/namespaces?user_id=0
    if (req.method === "GET" && path === "/memory/namespaces") {
      const userId = parseUserId(url);
      const namespaces = await store.listNamespaces(userId);
      json(res, 200, { user_id: userId, count: namespaces.length, namespaces });
      return true;
    }

    // GET /memory/documents?user_id=0&namespace=
    if (req.method === "GET" && path === "/memory/documents") {
      const userId = parseUserId(url);
      const ns = url.searchParams.get("namespace") ?? undefined;
      const documents = await store.listDocuments(userId, ns ?? undefined);
      json(res, 200, { user_id: userId, namespace: ns, count: documents.length, documents });
      return true;
    }

    // GET /memory/documents/:namespace/:documentId?user_id=0
    if (req.method === "GET" && /^\/memory\/documents\/[^/]+\/[^/]+$/.test(path)) {
      const userId = parseUserId(url);
      const [, , , nsRaw, docId] = path.split("/");
      const doc = await store.getDocument(userId, decodeURIComponent(nsRaw), decodeURIComponent(docId));
      if (!doc) {
        json(res, 404, { error: "document not found" });
        return true;
      }
      json(res, 200, { user_id: userId, document: doc });
      return true;
    }

    // POST /memory/documents — upsert (openhuman memory_doc_put)
    if (req.method === "POST" && path === "/memory/documents") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const input = docInputFromBody(body);
      const document_id = await store.putDocument(userId, input);
      json(res, 200, { user_id: userId, document_id });
      return true;
    }

    // POST /memory/documents/ingest — chunk + index (openhuman memory_doc_ingest)
    if (req.method === "POST" && path === "/memory/documents/ingest") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const input = docInputFromBody(body);
      const result = await store.ingestDocument(userId, input);
      const ns = sanitizeNamespace(input.namespace);
      const { rows } = await pool.query(
        `SELECT chunk_id, text FROM PKM.memory_chunks
         WHERE user_id = $1 AND namespace = $2 AND document_id = $3 ORDER BY chunk_id`,
        [userId, ns, result.document_id],
      );
      const treeSync = await treePipeline.syncFromMemoryChunks(
        userId,
        ns,
        result.document_id,
        rows.map((r) => ({ chunk_id: String(r.chunk_id), text: String(r.text) })),
        input.title,
      );
      json(res, 200, { user_id: userId, ...result, tree: treeSync });
      return true;
    }

    // DELETE /memory/documents/:namespace/:documentId?user_id=0
    if (req.method === "DELETE" && /^\/memory\/documents\/[^/]+\/[^/]+$/.test(path)) {
      const userId = parseUserId(url);
      const [, , , nsRaw, docId] = path.split("/");
      const ns = decodeURIComponent(nsRaw);
      const documentId = decodeURIComponent(docId);
      await store.graphRemoveDocument(userId, ns, documentId);
      const result = await store.deleteDocument(userId, ns, documentId);
      await treePipeline.deleteSourceTree(userId, ns, documentId);
      json(res, 200, { user_id: userId, ...result });
      return true;
    }

    // DELETE /memory/namespaces/:namespace?user_id=0
    if (req.method === "DELETE" && /^\/memory\/namespaces\/[^/]+$/.test(path)) {
      const userId = parseUserId(url);
      const ns = decodeURIComponent(path.split("/").pop()!);
      await store.clearNamespace(userId, ns);
      await treePipeline.deleteNamespaceTrees(userId, ns);
      json(res, 200, { user_id: userId, cleared: true, namespace: resolveNamespaceParam(ns) });
      return true;
    }

    // POST /memory/query — semantic/keyword query (openhuman memory_query_namespace)
    if (req.method === "POST" && path === "/memory/query") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const namespace = String(body.namespace ?? "");
      const query = String(body.query ?? "");
      const limit = body.max_chunks != null ? parseInt(String(body.max_chunks), 10) : body.limit != null ? parseInt(String(body.limit), 10) : 10;
      const result = await retrieval.queryNamespace(userId, namespace, query, limit || 10);
      json(res, 200, { user_id: userId, namespace: resolveNamespaceParam(namespace), ...result });
      return true;
    }

    // POST /memory/recall — recall without query (openhuman memory_recall_context)
    if (req.method === "POST" && path === "/memory/recall") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const namespace = String(body.namespace ?? "");
      const limit = body.max_chunks != null ? parseInt(String(body.max_chunks), 10) : body.limit != null ? parseInt(String(body.limit), 10) : 10;
      const result = await retrieval.recallContext(userId, namespace, limit || 10);
      json(res, 200, { user_id: userId, namespace: resolveNamespaceParam(namespace), ...result });
      return true;
    }

    // GET /memory/kv?user_id=0&namespace=&key=
    if (req.method === "GET" && path === "/memory/kv") {
      const userId = parseUserId(url);
      const key = url.searchParams.get("key");
      if (!key) {
        json(res, 400, { error: "key is required" });
        return true;
      }
      const ns = url.searchParams.get("namespace");
      const value = await store.kvGet(userId, ns, key);
      json(res, 200, { user_id: userId, key, value });
      return true;
    }

    // PUT /memory/kv
    if (req.method === "PUT" && path === "/memory/kv") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const key = String(body.key ?? "");
      if (!key) {
        json(res, 400, { error: "key is required" });
        return true;
      }
      const ns = body.namespace != null ? String(body.namespace) : null;
      await store.kvSet(userId, ns, key, body.value);
      json(res, 200, { user_id: userId, ok: true });
      return true;
    }

    // DELETE /memory/kv?user_id=0&namespace=&key=
    if (req.method === "DELETE" && path === "/memory/kv") {
      const userId = parseUserId(url);
      const key = url.searchParams.get("key");
      if (!key) {
        json(res, 400, { error: "key is required" });
        return true;
      }
      const ns = url.searchParams.get("namespace");
      const deleted = await store.kvDelete(userId, ns, key);
      json(res, 200, { user_id: userId, deleted });
      return true;
    }

    // GET /memory/graph?user_id=0&namespace=&subject=&predicate=
    if (req.method === "GET" && path === "/memory/graph") {
      const userId = parseUserId(url);
      const ns = url.searchParams.get("namespace");
      const subject = url.searchParams.get("subject") ?? undefined;
      const predicate = url.searchParams.get("predicate") ?? undefined;
      const relations = await store.graphQuery(userId, ns, subject, predicate);
      json(res, 200, { user_id: userId, count: relations.length, relations });
      return true;
    }

    // POST /memory/graph
    if (req.method === "POST" && path === "/memory/graph") {
      const body = await readJsonBody(req);
      const userId = parseUserId(url, body);
      const subject = String(body.subject ?? "");
      const predicate = String(body.predicate ?? "");
      const object = String(body.object ?? "");
      if (!subject || !predicate || !object) {
        json(res, 400, { error: "subject, predicate, object are required" });
        return true;
      }
      const ns = body.namespace != null ? String(body.namespace) : null;
      const attrs =
        body.attrs && typeof body.attrs === "object" && !Array.isArray(body.attrs)
          ? (body.attrs as Record<string, unknown>)
          : {};
      await store.graphUpsert(userId, ns, subject, predicate, object, attrs);
      json(res, 200, { user_id: userId, ok: true });
      return true;
    }

    json(res, 404, {
      error: "Memory route not found",
      available: [
        "GET /memory/namespaces",
        "GET /memory/documents",
        "GET /memory/documents/:namespace/:documentId",
        "POST /memory/documents",
        "POST /memory/documents/ingest",
        "DELETE /memory/documents/:namespace/:documentId",
        "DELETE /memory/namespaces/:namespace",
        "POST /memory/query",
        "POST /memory/recall",
        "GET|PUT|DELETE /memory/kv",
        "GET|POST /memory/graph",
      ],
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : "memory error";
    if (
      message.includes("required") ||
      message.includes("cannot be empty") ||
      message.includes("invalid JSON")
    ) {
      json(res, 400, { error: message });
      return true;
    }
    throw err;
  }
}
