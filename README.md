# REST API Server

知识库 REST API 服务，提供知识文档与附件的 HTTP 接口。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/knowledge` | 获取当前 EduNex 用户的知识文档列表 |
| GET | `/knowledge/:id` | 获取当前 EduNex 用户可见的单个知识文档详情 |
| GET | `/attachments` | 获取当前 EduNex 用户的附件列表 |
| GET | `/attachment/:id` | 下载当前 EduNex 用户可见的附件文件 |

所有请求都需要由 EduNex 服务转发，并携带 `x-edunex-user-id` 请求头；`pkm-api` 不再接受公开的 `user_id` 查询参数作为用户身份来源。

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

## Docker 启动

先准备环境变量文件：

```bash
cp .env.example .env
```

然后启动整套 PKM 后端：

```bash
docker compose up --build
```

默认会启动：

- `api`：`http://localhost:3001`
- `db`：PostgreSQL
- `minio`：附件对象存储

## 连接 EduNex

EduNex 通过 `PKM_API_URL` 访问这里的服务，并在请求里附带当前登录用户的 `x-edunex-user-id` 请求头。

如果 EduNex 在宿主机上运行，直接配置：

```env
PKM_API_URL=http://localhost:3001
```

如果 EduNex 也在 Docker 里运行，通常要配置成宿主机可达地址，例如：

```env
PKM_API_URL=http://host.docker.internal:3001
```

然后重启 EduNex server。

## 开发模式

```bash
npm install
npx tsx src/api.ts
```

## 手动构建

```bash
npm run build
npm start
```
