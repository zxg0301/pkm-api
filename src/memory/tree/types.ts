/** Memory Tree 类型（对齐 openhuman memory_store::trees::types） */

export type TreeKind = "source" | "topic" | "global";
export type TreeStatus = "active" | "archived";
export type LifecycleStatus =
  | "pending_extraction"
  | "admitted"
  | "buffered"
  | "sealed"
  | "dropped";

export const INPUT_TOKEN_BUDGET = 50_000;
export const OUTPUT_TOKEN_BUDGET = 5_000;
export const SUMMARY_FANOUT = 10;
export const DEFAULT_FLUSH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const TOPIC_CREATION_THRESHOLD = 10;
export const MIN_ADMIT_CHARS = 20;

export interface TreeRow {
  id: string;
  kind: TreeKind;
  scope: string;
  root_id: string | null;
  max_level: number;
  status: TreeStatus;
  created_at_ms: number;
  last_sealed_at_ms: number | null;
}

export interface BufferRow {
  tree_id: string;
  level: number;
  item_ids: string[];
  token_sum: number;
  oldest_at_ms: number | null;
}

export interface SummaryRow {
  id: string;
  tree_id: string;
  tree_kind: TreeKind;
  level: number;
  parent_id: string | null;
  child_ids: string[];
  content: string;
  token_count: number;
  entities: string[];
  topics: string[];
  time_range_start_ms: number;
  time_range_end_ms: number;
  score: number;
  sealed_at_ms: number;
}

export interface TreeChunkRow {
  id: string;
  source_kind: string;
  source_id: string;
  source_ref: string | null;
  timestamp_ms: number;
  token_count: number;
  lifecycle_status: LifecycleStatus;
  content_preview: string;
  tags: string[];
}

export interface SummaryInput {
  id: string;
  content: string;
  token_count: number;
  time_range_start_ms: number;
  time_range_end_ms: number;
  score: number;
  entities: string[];
  topics: string[];
}
