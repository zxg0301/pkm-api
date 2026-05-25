import type { IncomingMessage } from "node:http";

export function parseUserId(url: URL, body?: Record<string, unknown>): number {
  const fromQuery = url.searchParams.get("user_id");
  const raw = fromQuery ?? (body?.user_id != null ? String(body.user_id) : "0");
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? 0 : id;
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("invalid JSON body");
  }
}
