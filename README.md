# REST API Server

知识库 REST API 服务，提供知识文档与附件的 HTTP 接口。

**Memory**（`/memory/*`）为独立可选模块，默认**不启用**，行为与接入 Memory 前一致。

## 知识库接口（默认）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/knowledge?user_id=0` | 获取用户知识文档列表 |
| GET | `/knowledge/:id` | 获取单个知识文档详情 |
| GET | `/attachments?user_id=0` | 获取用户附件列表 |
| GET | `/attachment/:id` | 下载附件文件 |

## 启用 Memory 模块（可选）

1. 在 `.env` 中设置 `MEMORY_API_ENABLED=true`
2. 执行 `psql "$DATABASE_URL" -f init-memory.sql`（`init.sql` 仅含知识库表）
3. 重启 API

未启用时访问 `/memory/*` 会走原有 404，与未集成 Memory 时相同。

## Memory 接口（openhuman memory 子集）

基于 openhuman `memory_store` 的统一存储模型：按 `user_id` + `namespace` 管理文档、分块、KV 与知识图谱。检索使用 PostgreSQL 全文搜索 + 图谱/新鲜度加权（未移植向量嵌入与 Memory Tree 流水线）。

| 方法 | 路径 | 对应 openhuman RPC |
|------|------|-------------------|
| GET | `/memory/namespaces?user_id=0` | `memory_list_namespaces` |
| GET | `/memory/documents?user_id=0&namespace=` | `memory_list_documents` |
| GET | `/memory/documents/:namespace/:documentId?user_id=0` | — |
| POST | `/memory/documents` | `memory_doc_put` |
| POST | `/memory/documents/ingest` | `memory_doc_ingest` |
| DELETE | `/memory/documents/:namespace/:documentId` | `memory_delete_document` |
| DELETE | `/memory/namespaces/:namespace` | `memory_clear_namespace` |
| POST | `/memory/query` | `memory_query_namespace` |
| POST | `/memory/recall` | `memory_recall_context` |
| GET/PUT/DELETE | `/memory/kv` | `memory_kv_*` |
| GET/POST | `/memory/graph` | `memory_graph_*` |

### 写入文档示例

```bash
curl -X POST http://localhost:3001/memory/documents/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 0,
    "namespace": "notes",
    "key": "meeting-2026-05-25",
    "title": "周会纪要",
    "content": "## 结论\n决定下周上线 PKM memory API。"
  }'
```

### 检索示例

```bash
curl -X POST http://localhost:3001/memory/query \
  -H "Content-Type: application/json" \
  -d '{"user_id":0,"namespace":"notes","query":"上线","max_chunks":5}'
```

## 数据库初始化

知识库仅需：

```bash
psql "$DATABASE_URL" -f init.sql
```

Memory 另需（且仅在 `MEMORY_API_ENABLED=true` 时）：

```bash
psql "$DATABASE_URL" -f init-memory.sql
```

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接字符串 |
| `MINIO_ENDPOINT` | MinIO 地址 |
| `MINIO_PORT` | MinIO 端口 |
| `MINIO_ACCESS_KEY` | MinIO 访问密钥 |
| `MINIO_SECRET_KEY` | MinIO 秘密密钥 |
| `MINIO_BUCKET` | MinIO Bucket 名称 |
| `API_PORT` | REST API 服务端口，默认 3001 |

## 安装与运行

```bash
npm install
cp .env.example .env
psql "$DATABASE_URL" -f init.sql
npm run build
npm start
```

## 开发模式

```bash
npx tsx src/api.ts
```

## 如何验证 Memory 系统有效

### 1. 启动依赖

**Docker（推荐）：**

```bash
cd e:\code\pkm-api
docker compose up -d db
docker compose exec -T db psql -U postgres -d PKM < init.sql
# 仅在使用 Memory 时：docker compose exec -T db psql -U postgres -d PKM < init-memory.sql
docker compose up -d api
```

**本地开发：**

```bash
npm install
cp .env.example .env
# 确保 PostgreSQL 已建库 PKM，并执行 init.sql
npx tsx src/api.ts
```

服务就绪后，访问应返回 JSON（而非连接拒绝）：`http://localhost:3001/memory/namespaces?user_id=0`

### 2. 一键冒烟测试

```powershell
.\scripts\test-memory.ps1
```

全部步骤打印 `[OK]` 即表示 unified memory、Memory Tree、KV、图谱、摘要器接口均正常。

### 3. 手动检查清单

| 步骤 | 期望结果 |
|------|----------|
| `POST /memory/documents/ingest` | 返回 `document_id`、`chunk_count` ≥ 1、`tree.admitted` ≥ 1 |
| `POST /memory/query` | `llm_context_message` 含与文档相关的片段 |
| `GET /memory/tree/stats` | `chunks` ≥ 1 |
| `POST /memory/tree/flush` | 小文档也会生成摘要（未达 5 万 token 阈值时需 flush） |
| `POST /memory/tree/query/source` | `source_id` 为 `doc:<namespace>:<document_id>`，`hits` 或 `total` ≥ 0 |
| `POST /memory/tree/summarize/preview` | 返回 `content` 与 `summarizer` 字段 |

### 4. 常见误区

- **没有摘要节点**：单篇短文档 L0 缓冲区未满 5 万 token，需调用 `POST /memory/tree/flush` 才会密封。
- **query 无结果**：确认 `namespace` 与摄入时一致（会做 sanitize，空串变为 `global`）。
- **表不存在**：未执行 `init.sql` 时 API 会 500，先在 PKM 库跑一遍初始化脚本。
- **LLM 摘要**：未配置 `MEMORY_SUMMARIZER_API_*` 时仍有效，密封走 `fallback`；要测 LLM 先配 `.env` 再调 `summarize/preview`。

## Memory Tree 接口

三棵树模型（源 / 主题 / 全局），桶密封摘要流水线，对齐 openhuman `mem_tree_*` 表结构。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/memory/tree/stats?user_id=0` | 块数、源数、树数、摘要数等指标 |
| GET | `/memory/tree/sources?user_id=0` | 已摄入源列表 |
| GET | `/memory/tree/chunks?user_id=0` | 块列表（可按 `source_id`、生命周期过滤） |
| GET | `/memory/tree/trees?user_id=0&kind=source` | 树实例列表 |
| GET | `/memory/tree/summaries?user_id=0` | 密封摘要节点 |
| POST | `/memory/tree/query/source` | 按源查询摘要（`memory_tree_query_source`） |
| POST | `/memory/tree/query/topic` | 按实体主题查询 |
| POST | `/memory/tree/query/global` | 全局日摘要查询 |
| POST | `/memory/tree/walk` | 遍历某棵树上的摘要层级 |
| POST | `/memory/tree/flush` | 强制密封过期 L0 缓冲区（默认 7 天） |
| POST | `/memory/tree/digest` | 构建全局日摘要 |
| POST | `/memory/tree/sync` | 将已有 memory 分块同步进 Tree |
| POST | `/memory/tree/summarize/preview` | 试跑摘要器（不写入树，用于联调 LLM） |

`POST /memory/documents/ingest` 会在写入 unified memory 后**自动**同步到 Memory Tree（admit → L0 buffer → 达阈值密封）。

### 摘要器（LLM 接口）

密封时通过可插拔接口 `MemoryTreeSummarizer` 生成父级摘要（见 `src/memory/tree/summarizer/`）：

| 实现 | 说明 |
|------|------|
| `FallbackSummarizer` | 默认：确定性拼接截断（无外部依赖） |
| `HttpLlmSummarizer` | OpenAI 兼容 `chat/completions` |
| `CompositeSummarizer` | LLM 失败自动回退 fallback（`auto` 模式） |

环境变量（`.env.example`）：

| 变量 | 说明 |
|------|------|
| `MEMORY_SUMMARIZER` | `fallback` / `llm` / `auto`（默认） |
| `MEMORY_SUMMARIZER_API_URL` | 如 `https://api.openai.com/v1/chat/completions` |
| `MEMORY_SUMMARIZER_API_KEY` | API 密钥 |
| `MEMORY_SUMMARIZER_MODEL` | 模型名，默认 `gpt-4o-mini` |
| `MEMORY_SUMMARIZER_TIMEOUT_MS` | 请求超时，默认 `120000` |
| `MEMORY_SUMMARIZER_OUTPUT_LANGUAGE` | 可选，如 `zh-CN` |

未来接入自定义后端时，实现 `MemoryTreeSummarizer` 并注入 `TreePipeline`：

```typescript
import { TreePipeline } from "./memory/tree/pipeline.js";
import type { MemoryTreeSummarizer } from "./memory/tree/summarizer/index.js";

class MySummarizer implements MemoryTreeSummarizer {
  readonly name = "my-backend";
  async summarize(inputs, ctx) { /* ... */ }
}

const pipeline = new TreePipeline(pool, new MySummarizer());
```

试跑摘要（不写入数据库）：

```bash
curl -X POST http://localhost:3001/memory/tree/summarize/preview \
  -H "Content-Type: application/json" \
  -d '{"items":[{"id":"a","content":"周一讨论了密封策略。"},{"id":"b","content":"周二完成表设计。"}]}'
```

### Memory Tree 示例

```bash
# 摄入（同时构建源树）
curl -X POST http://localhost:3001/memory/documents/ingest \
  -H "Content-Type: application/json" \
  -d '{"user_id":0,"namespace":"notes","key":"week-21","title":"第21周","content":"周一讨论了 Memory Tree 密封策略。\n\n周二完成 PostgreSQL 表设计。"}'

# 查询某文档源树的摘要
curl -X POST http://localhost:3001/memory/tree/query/source \
  -H "Content-Type: application/json" \
  -d '{"user_id":0,"source_id":"doc:notes:<document_id>","query":"密封","limit":5}'

# 密封闲置缓冲区并生成全局摘要
curl -X POST http://localhost:3001/memory/tree/flush -H "Content-Type: application/json" -d '{"user_id":0}'
curl -X POST http://localhost:3001/memory/tree/digest -H "Content-Type: application/json" -d '{"user_id":0}'
```

## 与 openhuman 的差异

| 能力 | openhuman | 本服务 |
|------|-----------|--------|
| 存储 | 本地 SQLite + Markdown 侧车 | PostgreSQL |
| 多用户 | 每 workspace 单用户 | `user_id` 列 |
| 向量检索 | 有（EmbeddingProvider） | 未实现（FTS 替代） |
| Memory Tree 摘要 | 内置 LLM + fallback | 可插拔 `MemoryTreeSummarizer`（默认 auto） |
| 任务队列 workers | 持久化队列 + 后台 worker | 同步密封（ingest/flush 时触发） |
| 实体抽取 ingestion | LLM 流水线 | 启发式热度 + 图谱 |
