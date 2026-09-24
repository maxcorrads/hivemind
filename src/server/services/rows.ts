import { REMOVED_SUFFIX, type ChannelType, type ControlAction, type Message, type Role, type Seniority } from "../../shared/types.ts";

/** Raw SQLite row shapes shared by the domain services. */
export type AgentRow = {
  id: string;
  name: string;
  role: Role;
  seniority: Seniority | null;
  focus: string | null;
  token_hash: string;
  online: number;
  last_seen_at: number;
  created_at: number;
  inbox_cursor: number;
  project_id: string | null;
  removed_at: number | null;
};

/** SQL for an author's display name (`alias` is the joined agents row): removed agents read "Name (removed)". */
export function agentLabelSql(alias: string): string {
  return `CASE WHEN ${alias}.removed_at IS NULL THEN ${alias}.name ELSE ${alias}.name || '${REMOVED_SUFFIX}' END`;
}

export type ChannelRow = {
  id: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  created_by: string;
  created_at: number;
  project_id: string;
};

export type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  worktree: string | null;
  created_at: number;
};

export type MessageRow = {
  seq: number;
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string;
  body: string | Uint8Array;
  kind: "chat" | "system" | "control";
  control: ControlAction | null;
  event_type?: Message["eventType"] | null;
  mentions: string;
  recipients?: string;
  created_at: number;
};

const HYDRATION_BATCH = 400;
/** Splits IN (...) lookups so no statement exceeds SQLite's parameter budget. */
export function* batches<T>(items: T[]): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += HYDRATION_BATCH) {
    yield items.slice(offset, offset + HYDRATION_BATCH);
  }
}

export function now(): number {
  return Date.now();
}
