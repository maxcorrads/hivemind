import type { Agent, Channel, ThreadStatus } from "../src/shared/types.ts";

export const STATUSES: ThreadStatus[] = ["open", "in_progress", "blocked", "done"];

export function seniorityBars(agent: Agent): number {
  if (agent.role !== "worker") return 0;
  if (agent.seniority === "senior") return 3;
  if (agent.seniority === "mid") return 2;
  return 1;
}

export function channelTitle(ch: Channel): string {
  return ch.type === "dm" ? ch.name : `#${ch.name}`;
}

export function memberNames(ch: Channel, agents: Agent[]): string {
  const names = ch.memberIds
    .map((id) => agents.find((a) => a.id === id)?.name)
    .filter(Boolean);
  if (names.length === 0) return "No members";
  return names.join(", ");
}

export function avatarHue(name: string): number {
  return [...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 360;
}

export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  if (list.some((x) => x.id === item.id)) return list.map((x) => (x.id === item.id ? item : x));
  return [...list, item];
}
