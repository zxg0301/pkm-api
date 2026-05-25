import pg from "pg";
import { S3Client } from "@aws-sdk/client-s3";

const { Pool } = pg;

// ── PG 连接 ──
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("Environment variable DATABASE_URL is required");
}
export const pool = new Pool({ connectionString: DATABASE_URL });

// ── S3 连接（兼容 MinIO 等 S3 协议存储） ──
function resolveS3Endpoint(): string | undefined {
  if (process.env.S3_ENDPOINT) {
    return process.env.S3_ENDPOINT;
  }
  const host = process.env.MINIO_ENDPOINT;
  if (!host) {
    return undefined;
  }
  const port = process.env.MINIO_PORT ?? "9000";
  const useSsl = process.env.MINIO_USE_SSL === "true";
  return `${useSsl ? "https" : "http"}://${host}:${port}`;
}

const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? process.env.MINIO_ACCESS_KEY;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? process.env.MINIO_SECRET_KEY;
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  throw new Error(
    "Environment variables AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or MINIO_ACCESS_KEY/MINIO_SECRET_KEY) are required",
  );
}

const s3Endpoint = resolveS3Endpoint();
export const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? process.env.MINIO_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
  ...(s3Endpoint ? { endpoint: s3Endpoint, forcePathStyle: true } : {}),
});
export const S3_BUCKET = process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? "knowledgemap";
