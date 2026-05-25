import { GLOBAL_NAMESPACE } from "./types.js";

/** 与 openhuman UnifiedMemory::sanitize_namespace 一致 */
export function sanitizeNamespace(namespace: string): string {
  const trimmed = namespace.trim();
  if (!trimmed) return GLOBAL_NAMESPACE;
  return trimmed
    .split("")
    .map((ch) => {
      if (/[a-zA-Z0-9\-_/]/.test(ch)) return ch;
      return "_";
    })
    .join("");
}

export function newDocumentId(): string {
  const short = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}_${short}`;
}
