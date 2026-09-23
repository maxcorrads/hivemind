import type { JevCall, JevCallLogView } from '../src/shared/jev-calls.ts';
import type { RoutingRequest, RoutingSuggestions } from '../src/shared/routing.ts';
import type { TelegramHealth } from "./telegram-health.ts";
import type { Agent, BotCredentialView, AttachmentMeta, Channel, Message, Project, SearchHit, Thread, ThreadStatus, InboxStatus } from "../src/shared/types.ts";
import type { MentionPage, ReadSnapshot } from "../src/shared/read-state.ts";
import { resolveUploadMime } from "../src/shared/mime.ts";
import type { LaunchContext } from "../src/shared/launch-prompt.ts";
import type { ProjectPluginView, SettingsValues } from "../src/shared/plugin-settings.ts";
import { humanSession, connectHumanWs } from "./human-session.ts";
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { RoomView, Room } from '../src/shared/rooms.ts';
import type { DecisionPage, DecisionView } from '../src/shared/decisions.ts';
import type { TimelineExport, TimelineView } from '../src/shared/timeline.ts';
import type {
  AdaptiveExecutionState,
  AdaptiveLockScope,
  AdaptiveRoutingMode,
  AdaptiveRoutingView,
  AdaptiveTopology,
  AdaptiveTopologyDecision,
} from '../src/shared/adaptive-topology.ts';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await humanSession.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data as T;
}

export type SendRoutingMode = AdaptiveRoutingMode;
export type SendLockScope = AdaptiveLockScope;

export type Snapshot = ReadSnapshot & {
  you: Agent;
  projects: Project[];
  agents: Agent[];
  channels: Channel[];
  queued: Record<string, number>;
  inbox?: Record<string, InboxStatus>;
  telegram?: { running: boolean; configured: boolean } & TelegramHealth;
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
  fallback: "single" | "orchestrated";
  topologyFallback: Exclude<AdaptiveTopology, "single">;
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

export type ChannelPayload = {
  /** Server sequence fence, including replies omitted from this page. */
  snapshotSeq?: number;
  /** Client-only per-root live reply deduplication, pruned with visible roots. */
  replySeqs?: Record<string, number>;
  /** Client-only reading window. Live arrivals must not evict selected/older text. */
  historyThrough?: number;
  deferredLive?: boolean;
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
    fallback: "single" | "orchestrated";
    topologyFallback: Exclude<AdaptiveTopology, "single">;
    /** A bounded identifier to pin, or null for the default alias. */
    model?: string | null;
  }) =>
    req<AdaptiveRoutingSettings>("/api/ui/adaptive-routing", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  adaptiveRoutingView: (channelId: string, signal?: AbortSignal) =>
    req<AdaptiveRoutingView>(`/api/ui/channels/${encodeURIComponent(channelId)}/adaptive-routing`, { signal }),
  setAdaptiveRoutingLock: (channelId: string, body: { scope: AdaptiveLockScope; topology?: AdaptiveTopology | null; expectedExecutionId?: string; expectedRevision?: number }) =>
    req<AdaptiveRoutingView>(`/api/ui/channels/${encodeURIComponent(channelId)}/adaptive-routing/lock`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  taskTimeline: (id: string, signal?: AbortSignal) =>
    req<{ timeline: TimelineView }>(`/api/ui/tasks/${encodeURIComponent(id)}/timeline`, { signal }),
  exportTaskTimeline: (id: string, signal?: AbortSignal) =>
    req<{ fixture: TimelineExport }>(`/api/ui/tasks/${encodeURIComponent(id)}/timeline/export`, { signal }),
  decisions: (project: string, includeClosed = true, signal?: AbortSignal) =>
    req<DecisionPage>('/api/ui/decisions?project=' + encodeURIComponent(project) + '&includeClosed=' + (includeClosed ? '1' : '0'), { signal }),
  /** `cursor` is the previous page's opaque `nextCursor`; omit it for the newest page. */
  jevCalls: (project: string, cursor?: string | null, signal?: AbortSignal) =>
    req<JevCallLogView>(`/api/ui/projects/${encodeURIComponent(project)}/jev-calls${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
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
  markMessagesSeen: (channelId: string, threadId: string | null, messageSeqs: number[], signal?: AbortSignal) =>
    req<ReadSnapshot>("/api/ui/read", {
      method: "POST", body: JSON.stringify({ channelId, threadId, messageSeqs }), signal,
    }),
  mentions: (beforeSeq?: number, project?: string, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (beforeSeq) q.set("beforeSeq", String(beforeSeq));
    if (project) q.set("project", project);
    const suffix = q.toString() ? `?${q}` : "";
    return req<MentionPage>(`/api/ui/mentions${suffix}`, { signal });
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
  messages: (id: string, threadId?: string | null, beforeSeq?: number, signal?: AbortSignal, afterSeq?: number) => {
    const q = new URLSearchParams();
    if (threadId) q.set("threadId", threadId);
    if (afterSeq !== undefined) q.set("afterSeq", String(afterSeq));
    if (beforeSeq) q.set("beforeSeq", String(beforeSeq));
    const suffix = q.toString() ? `?${q}` : "";
    return req<ChannelPayload>(`/api/ui/channels/${encodeURIComponent(id)}/messages${suffix}`, { signal });
  },
  send: (id: string, body: string, threadId?: string | null, attachmentIds?: string[], requestId?: string,
    routing: AdaptiveRoutingMode = "auto", lockScope: AdaptiveLockScope = "none") =>
    req<{
      message: Message;
      routing: AdaptiveTopologyDecision | null;
      routingMessage?: Message;
      routingMessages?: Message[];
      adaptiveState?: AdaptiveExecutionState | null;
      adaptiveStates?: AdaptiveExecutionState[];
    }>(`/api/ui/channels/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, threadId: threadId ?? null, attachmentIds, requestId, routing, lockScope }),
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
