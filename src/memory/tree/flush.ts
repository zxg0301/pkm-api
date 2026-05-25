import type { TreeSealer } from "./seal.js";
import type { TreeStore } from "./store.js";
import { DEFAULT_FLUSH_AGE_MS } from "./types.js";

/**
 * Time-based buffer flush (openhuman `memory_tree/tree/flush.rs`).
 * Force-seals stale L0 buffers regardless of token budget.
 */
export async function flushStaleBuffers(
  store: TreeStore,
  sealer: TreeSealer,
  userId: number,
  maxAgeMs = DEFAULT_FLUSH_AGE_MS,
): Promise<number> {
  return sealer.flushStaleBuffers(userId, maxAgeMs);
}

export async function flushStaleBuffersDefault(
  store: TreeStore,
  sealer: TreeSealer,
  userId: number,
): Promise<number> {
  return flushStaleBuffers(store, sealer, userId, DEFAULT_FLUSH_AGE_MS);
}

export async function forceFlushTree(
  sealer: TreeSealer,
  userId: number,
  treeId: string,
): Promise<string[]> {
  return sealer.forceFlushTree(userId, treeId);
}
