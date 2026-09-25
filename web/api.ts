import type { JevCall, JevCallLogView } from '../src/shared/jev-calls.ts';
import type { EvidenceCollectorHealth } from '../src/shared/evidence-health.ts';
import type { RoutingRequest, RoutingSuggestions } from '../src/shared/routing.ts';
import type { TelegramHealth } from "./telegram-health.ts";
import type { Agent, BotCredentialView, AttachmentMeta, Channel, Message, Project, SearchHit, Thread, ThreadStatus, InboxStatus } from "../src/shared/types.ts";
import type { ActivityPage, ActivityReason, MentionPage, ReadSnapshot } from "../src/shared/read-state.ts";
import { resolveUploadMime } from "../src/shared/mime.ts";
import type { LaunchContext } from "../src/shared/launch-prompt.ts";
import type { ProjectPluginView, SettingsValues } from "../src/shared/plugin-settings.ts";
import { humanSession, connectHumanWs } from "./human-session.ts";
import type { AgentWork, ChannelTaskPage, TaskSnapshot } from '../src/shared/tasks.ts';
import type { RoomView, Room } from '../src/shared/rooms.ts';
import type { DecisionPage, DecisionView } from '../src/shared/decisions.ts';
import type { TimelineExport, TimelineView } from '../src/shared/timeline.ts';
import type { AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';

export class ApiError extends Error {
  /** `body` is the parsed error response, for errors that carry more than a message (e.g. a thread's real channel). */
  constructor(readonly status: number, message: string, readonly body?: Record<string, unknown>) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await humanSession.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`, data);
  return data as T;
}

export type Snapshot = ReadSnapshot & {
  you: Agent;
  projects: Project[];
  agents: Agent[];
  channels: Channel[];
  /** Room lifecycle metadata; all channels remain addressable, including archived ones. */
  archivedChannelIds?: string[];
  queued: Record<string, number>;
  inbox?: Record<string, InboxStatus>;
  telegram?: { running: boolean; configured: boolean } & TelegramHealth;
};

/** Sidebar badges and roster status lines. */
export type NavStatus = {
  /** Awaiting decisions per project slug. */
  awaitingDecisions: Record<string, number>;
  /** Open work per agent id; agents without any are omitted. */
  agentWork: Record<string, AgentWork>;
};

export type AdaptiveRoutingSettings = {
  enabled: boolean;
  apiKeySet: boolean;
  apiKeyHint: string | null;
  /** The identifier Hivemind requests from TypeSafe. */
  model: string;
  /** The provider alias used when nothing is pinned. */
  defaultModel: string;
  modelPinned: boolean;
};

export type TelegramSettings = TelegramHealth & {
  running: boolean;
  configured: boolean;
  tokenSet: boolean;
  tokenHint: string | null;
  allowUserIds: number[];
  projects: Record<string, number>;
  diagnosticsPruned?: number; failures?: number;
};

export type UnreadTarget = { channelId: string; threadId: string | null; seq: number };

export type ChannelPayload = {
  /** Client-only identity of the jump that installed this page. Never an HTTP receipt. */
  unreadTarget?: UnreadTarget;
  /** Server sequence fence, including replies omitted from this page. */
  snapshotSeq?: number;
  /** Client-only per-root live reply deduplication, pruned with visible roots. */
  replySeqs?: Record<string, number>;
  /** Client-only reading window. Live arrivals must not evict selected/older text. */
  historyThrough?: number;
  deferredLive?: boolean;
  /** Oldest unread root when the channel was opened (or marked unread): where "New messages" starts. */
  firstUnreadSeq?: number | null;
  task?: TaskSnapshot;
  decision?: DecisionView;
  decisions?: DecisionView[];
  channel: Channel;
  threadId: string | null;
  messages: Message[];
  hasOlder?: boolean;
  hasNewer?: boolean;
  cursors?: { before?: number; after?: number };
  threads: Thread[];
  replyCounts: Record<string, number>;
};

export const api = {
  adaptiveRouting: () => req<AdaptiveRoutingSettings>("/api/ui/adaptive-routing"),
  saveAdaptiveRouting: (body: {
    enabled: boolean;
    apiKey?: string | null;
    /** A bounded identifier to pin, or null for the default alias. */
    model?: string | null;
  }) =>
    req<AdaptiveRoutingSettings>("/api/ui/adaptive-routing", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  adaptiveRoutingView: (channelId: string, signal?: AbortSignal) =>
    req<AdaptiveRoutingView>(`/api/ui/channels/${encodeURIComponent(channelId)}/adaptive-routing`, { signal }),
  taskTimeline: (id: string, signal?: AbortSignal) =>
    req<{ timeline: TimelineView }>(`/api/ui/tasks/${encodeURIComponent(id)}/timeline`, { signal }),
  exportTaskTimeline: (id: string, signal?: AbortSignal) =>
    req<{ fixture: TimelineExport }>(`/api/ui/tasks/${encodeURIComponent(id)}/timeline/export`, { signal }),
  decisions: (project: string, includeClosed = true, signal?: AbortSignal) =>
    req<DecisionPage>('/api/ui/decisions?project=' + encodeURIComponent(project) + '&includeClosed=' + (includeClosed ? '1' : '0'), { signal }),
  /** `cursor` is the previous page's opaque `nextCursor`; omit it for the newest page. */
  jevCalls: (project: string, cursor?: string | null, signal?: AbortSignal) =>
    req<JevCallLogView>(`/api/ui/projects/${encodeURIComponent(project)}/jev-calls${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  evidenceHealth: (signal?: AbortSignal) => req<EvidenceCollectorHealth>('/api/ui/adaptive-routing/evidence-health', { signal }),
  jevCall: (project: string, id: string, signal?: AbortSignal) =>
    req<{ call: JevCall }>(`/api/ui/projects/${encodeURIComponent(project)}/jev-calls/${encodeURIComponent(id)}`, { signal }),
  answerDecision: (id: string, body: { requestId: string; expectedRevision: number; body: string }, signal?: AbortSignal) =>
    req<{ decision: DecisionView; message: Message; duplicate: boolean }>('/api/ui/decisions/' + encodeURIComponent(id) + '/answer',
      { method: 'POST', body: JSON.stringify(body), signal }),
  suggestWorkers: (id: string, body: RoutingRequest, signal?: AbortSignal) => req<RoutingSuggestions>(`/api/ui/tasks/${encodeURIComponent(id)}/routing`, { method: 'POST', body: JSON.stringify(body), signal }),
  recordRoutingChoice: (id: string, body: { expectedRevision: number; workerId: string; reason: string; requestId: string }, signal?: AbortSignal) => req<{ assigned: false }>(`/api/ui/tasks/${encodeURIComponent(id)}/routing-override`, { method: 'POST', body: JSON.stringify(body), signal }),
  botCredential: (project: string, bot: string) => req<BotCredentialView>(
    `/api/ui/projects/${encodeURIComponent(project)}/bots/${encodeURIComponent(bot)}/credential`),
  changeBotCredential: (project: string, bot: string, action: 'rotate' | 'revoke', expectedRevision: number) =>
    req<BotCredentialView & { token?: string }>(`/api/ui/projects/${encodeURIComponent(project)}/bots/${encodeURIComponent(bot)}/credential`,
      { method: 'POST', body: JSON.stringify({ action, expectedRevision }) }),
  channelTasks: (channel: string, signal?: AbortSignal) =>
    req<ChannelTaskPage>(`/api/ui/channels/${encodeURIComponent(channel)}/tasks`, { signal }),
  room: (channel: string) => req<RoomView>(`/api/ui/channels/${encodeURIComponent(channel)}/room`),
  roomHistory: (channel: string, before?: number) => req<{ history: Room[] }>(`/api/ui/channels/${encodeURIComponent(channel)}/room/history?before=${before ?? Number.MAX_SAFE_INTEGER}`),
  roomEvent: (channel: string, body: unknown) => req<RoomView>(`/api/ui/channels/${encodeURIComponent(channel)}/room`, { method: 'POST', body: JSON.stringify(body) }),
  launchContext: (project: string) => req<LaunchContext>(`/api/ui/launch-context?project=${encodeURIComponent(project)}`),
  projectPlugins: (slug: string) => req<{ plugins: ProjectPluginView[] }>(`/api/ui/projects/${encodeURIComponent(slug)}/plugins`),
  setPluginAvailability: (slug: string, id: string, body: { enabled: boolean; expectedRevision: number }) =>
    req<{ plugin: ProjectPluginView }>(`/api/ui/projects/${encodeURIComponent(slug)}/plugins/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) }),
  saveProjectPlugin: (slug: string, id: string, body: { enabled: boolean; values: SettingsValues; expectedRevision: number }) =>
    req<{ plugin: ProjectPluginView }>(`/api/ui/projects/${encodeURIComponent(slug)}/plugins/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(body) }),
  createBot: (projectId: string, name: string) => req<{ bot: Agent; token: string }>(
    `/api/ui/projects/${encodeURIComponent(projectId)}/bots`, { method: "POST", body: JSON.stringify({ name }) },
  ),
  snapshot: (signal?: AbortSignal) => req<Snapshot>("/api/ui/snapshot", { signal }),
  readState: (signal?: AbortSignal) => req<ReadSnapshot>("/api/ui/read-state", { signal }),
  navStatus: (signal?: AbortSignal) => req<NavStatus>("/api/ui/nav-status", { signal }),
  markMessagesSeen: (channelId: string, threadId: string | null, messageSeqs: number[], signal?: AbortSignal) =>
    req<ReadSnapshot>("/api/ui/read", {
      method: "POST", body: JSON.stringify({ channelId, threadId, messageSeqs }), signal,
    }),
  markUnread: (channelId: string, fromSeq: number) =>
    req<ReadSnapshot>("/api/ui/unread", { method: "POST", body: JSON.stringify({ channelId, fromSeq }) }),
  activity: (view: { project: string; unreadOnly: boolean; reasons: readonly ActivityReason[]; beforeSeq?: number },
    signal?: AbortSignal) => {
    const q = new URLSearchParams({ project: view.project, unread: view.unreadOnly ? "1" : "0" });
    if (view.reasons.length) q.set("reason", view.reasons.join(","));
    if (view.beforeSeq) q.set("beforeSeq", String(view.beforeSeq));
    return req<ActivityPage>(`/api/ui/activity?${q}`, { signal });
  },
  markMentionsSeen: (project?: string) =>
    req<MentionPage & { unread: Record<string, number>; readState: ReadSnapshot }>("/api/ui/mentions/seen", {
      method: "POST",
      body: JSON.stringify({ project }),
    }),
  createProject: (name: string, slug?: string, worktree?: string) =>
    req<{ project: Project }>("/api/ui/projects", {
      method: "POST",
      body: JSON.stringify({ name, slug, worktree }),
    }),
  updateProject: (slug: string, patch: { name?: string; worktree?: string | null }) =>
    req<{ project: Project }>(`/api/ui/projects/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteProject: (slug: string) =>
    req<{ ok: true }>(`/api/ui/projects/${encodeURIComponent(slug)}`, { method: "DELETE" }),
  removeAgent: (name: string) =>
    req<{ ok: true; name: string }>(`/api/ui/agents/${encodeURIComponent(name)}`, { method: "DELETE" }),
  telegram: () => req<TelegramSettings>("/api/ui/telegram"),
  saveTelegram: (body: {
    botToken?: string;
    allowUserIds: Array<number | string>;
    projects: Record<string, { groupChatId: number | string }>;
  }) =>
    req<TelegramSettings>("/api/ui/telegram", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  search: (q: string, project: string, beforeSeq?: number, limit?: number, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q, project });
    if (beforeSeq) params.set("beforeSeq", String(beforeSeq));
    if (limit) params.set("limit", String(limit));
    return req<{ hits: SearchHit[]; hasMore: boolean }>(`/api/ui/search?${params}`, { signal });
  },
  lastUnread: (id: string, signal?: AbortSignal) =>
    req<{ target: UnreadTarget | null }>(
      `/api/ui/channels/${encodeURIComponent(id)}/last-unread`, { signal }),
  messages: (id: string, threadId?: string | null, beforeSeq?: number, signal?: AbortSignal, afterSeq?: number) => {
    const q = new URLSearchParams();
    if (threadId) q.set("threadId", threadId);
    if (afterSeq !== undefined) q.set("afterSeq", String(afterSeq));
    if (beforeSeq) q.set("beforeSeq", String(beforeSeq));
    const suffix = q.toString() ? `?${q}` : "";
    return req<ChannelPayload>(`/api/ui/channels/${encodeURIComponent(id)}/messages${suffix}`, { signal });
  },
  /** Returns once the message is committed; Jev never delays a send, its advice arrives over realtime (#214). */
  send: (id: string, body: string, threadId?: string | null, attachmentIds?: string[], requestId?: string) =>
    req<{ message: Message }>(`/api/ui/channels/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, threadId: threadId ?? null, attachmentIds, requestId }),
    }),
  upload: async (file: File): Promise<AttachmentMeta> => {
    const res = await humanSession.request("/api/ui/files", {
      method: "POST",
      headers: {
        "x-file-name": file.name || "paste.png",
        "x-file-mime": resolveUploadMime(file.type, file.name || "paste.png"),
      },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.file as AttachmentMeta;
  },
  react: (seq: number, emoji: string, present: boolean) =>
    req<{ message: Message; added: boolean }>(`/api/ui/messages/${seq}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji, present }),
    }),
  fileUrl: (id: string) => `/api/ui/files/${encodeURIComponent(id)}`,
  createChannel: (name: string, type: "public" | "private", topic?: string, memberNames?: string[], project?: string) =>
    req<{ channel: Channel }>("/api/ui/channels", {
      method: "POST",
      body: JSON.stringify({ name, type, topic, memberNames, project }),
    }),
  openDm: (name: string) =>
    req<{ channel: Channel }>("/api/ui/dms", { method: "POST", body: JSON.stringify({ name }) }),
  setStatus: (threadId: string, status: ThreadStatus) =>
    req<{ thread: Thread }>(`/api/ui/threads/${threadId}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  invite: (channelId: string, names: string[]) =>
    req<{ channel: Channel }>(`/api/ui/channels/${encodeURIComponent(channelId)}/invite`, {
      method: "POST",
      body: JSON.stringify({ names }),
    }),
  clearContext: (name: string) =>
    req<{ message: Message }>("/api/ui/clear-context", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
};

export function connectWs(
  onEvent: (ev: { type: string; payload: unknown }) => void,
  onLive?: (ok: boolean) => void,
): () => void {
  return connectHumanWs(humanSession, onEvent, onLive);
}
