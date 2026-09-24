import type { ActivityItem, ActivityReason } from "../src/shared/read-state.ts";

/** The For you type filters and the server reasons each one shows (empty: every reason). */
export const ACTIVITY_FILTERS = [
  { value: "all", label: "Everything", reasons: [] },
  { value: "direct", label: "Direct messages", reasons: ["direct"] },
  { value: "mention", label: "Mentions", reasons: ["mention"] },
  { value: "thread", label: "Thread replies", reasons: ["thread"] },
  { value: "review", label: "Decisions & tasks", reasons: ["decision", "task"] },
] as const satisfies ReadonlyArray<{ value: string; label: string; reasons: readonly ActivityReason[] }>;
export type ActivityFilter = typeof ACTIVITY_FILTERS[number]["value"];

export function filterReasons(filter: ActivityFilter): readonly ActivityReason[] {
  return ACTIVITY_FILTERS.find(item => item.value === filter)?.reasons ?? [];
}

export const REASON_LABELS: Record<ActivityReason, string> = {
  direct: "Direct message", mention: "Mention", thread: "Thread reply", decision: "Decision", task: "Task",
};

/** What a loaded For you list shows: one project, one box, one filter. */
export type ActivityView = { project: string; unreadOnly: boolean; reasons: readonly ActivityReason[] };

function newestFirst(items: ActivityItem[]) {
  return items.sort((a, b) => b.message.seq - a.message.seq);
}

/** Loaded entries updated with a fresher newest page: same ids take its read state, new ids are added. */
export function mergeActivity(loaded: ActivityItem[], fresh: ActivityItem[]): ActivityItem[] {
  const byId = new Map(loaded.map(item => [item.message.id, item]));
  for (const item of fresh) byId.set(item.message.id, item);
  return newestFirst([...byId.values()]);
}

/** Adds a realtime entry when the view shows it; the same list otherwise. */
export function receiveActivity(items: ActivityItem[], view: ActivityView, item: ActivityItem): ActivityItem[] {
  if (item.project !== view.project || (view.unreadOnly && item.read)) return items;
  if (view.reasons.length && !view.reasons.includes(item.reason)) return items;
  if (items.some(existing => existing.message.id === item.message.id)) return items;
  return newestFirst([item, ...items]);
}
