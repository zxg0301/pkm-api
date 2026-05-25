/**
 * 文档分块（简化版，对齐 openhuman chunk_document_content，默认 max_tokens≈225）
 * 按段落合并，单块约 maxChars 字符上限。
 */
export function chunkDocumentContent(content: string, maxTokens = 225): string[] {
  const maxChars = Math.max(maxTokens * 4, 400);
  const trimmed = content.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxChars) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current) chunks.push(current);
      if (para.length <= maxChars) {
        current = para;
      } else {
        for (let i = 0; i < para.length; i += maxChars) {
          chunks.push(para.slice(i, i + maxChars));
        }
        current = "";
      }
    }
  }
  if (current) chunks.push(current);

  if (chunks.length === 0 && trimmed) return [trimmed];
  return chunks;
}
