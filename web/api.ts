import type { JevCall, JevCallLogView } from '../src/shared/jev-calls.ts';
import type { EvidenceCollectorHealth } from '../src/shared/evidence-health.ts';
import type { RoutingRequest, RoutingSuggestions } from '../src/shared/routing.ts';
import type { TelegramHealth } from "./telegram-health.ts";
import type { WorkerTemplate, WorkerTemplateSpec } from "../src/shared/worker-templates.ts";
import type { Agent, AgentTrafficView, BotCredentialView, AttachmentMeta, Channel, Message, Project, SearchHit, Thread, ThreadStatus, InboxStatus } from "../src/shared/types.ts";
import type { ActivityPage, ActivityReason, MentionPage, ReadSnapshot } from "../src/shared/read-state.ts";
import { resolveUploadMime } from "../src/shared/mime.ts";
import type { LaunchContext } from "../src/shared/launch-prompt.ts";
import type { ProjectBotConfiguration, SettingsValues } from "../src/shared/bot-settings.ts";
import type { BotAccess } from '../src/shared/bot-capabilities.ts';
import { humanSession, connectHumanWs } from "./human-session.ts";
import type { AgentWork, ChannelTaskPage, TaskSnapshot } from '../src/shared/tasks.ts';
import type { TaskControlInput } from '../src/shared/task-control.ts';
import type { TaskOverview, TaskViewsPage } from '../src/shared/task-views.ts';
import type { RoomView, Room } from '../src/shared/rooms.ts';
import type { TimelineExport, TimelineView } from '../src/shared/timeline.ts';
import type { AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';
import type { AgentOverview, AgentRemoveImpact, AgentLifecycleEvent } from '../src/shared/agent-management.ts';
import type { CapabilityCard, CapabilityView } from '../src/shared/routing.ts';

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
  /** Complete current work per agent. Optional while old fixtures and servers are upgraded. */
  agentWork?: Record<string, AgentWork>;
  /** Bytes the agent API returned per brain/worker since the server started. */
  agentTraffic?: Record<string, AgentTrafficView>;
  telegram?: { running: boolean; configured: boolean } & TelegramHealth;
  /** Whether Jev adaptive routing is on; the Routing log is offered only then. */
  jev?: { enabled: boolean };
  /** A verified Hivemind Server.app can receive launcher commands. */
  launcherAvailable?: boolean;
};

export type LaunchRequestView = {
  id: string;
  projectId: string;
  brainId: string;
  templateId: string;
  /** Saved with the request so historical cards keep their label after the template is deleted. */
  templateLabel: string;
  taskId: string | null;
  jobId: string | null;
  agentId: string;
  state: "awaiting_approval" | "approved" | "launching" | "launched" | "failed" | "rejected" | "cancelled" | "expired";
  reason: string | null;
  requestedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  session: string | null;
  error: string | null;
  capBlocked: boolean;
};

export type ProjectBotsView = {
  bots: { bot: Agent; access: BotAccess; credential: BotCredentialView['credential'] }[];
  definitions: ProjectBotConfiguration[];
  catalogError?: string;
  channels: Channel[];
};

/** Roster status lines. */
export type NavStatus = {
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
  /** `cursor` is the previous page's opaque `nextCursor`; omit it for the newest page. */
  jevCalls: (project: string, cursor?: string | null, signal?: AbortSignal) =>
    req<JevCallLogView>(`/api/ui/projects/${encodeURIComponent(project)}/jev-calls${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  evidenceHealth: (signal?: AbortSignal) => req<EvidenceCollectorHealth>('/api/ui/adaptive-routing/evidence-health', { signal }),
  jevCall: (project: string, id: string, signal?: AbortSignal) =>
    req<{ call: JevCall }>(`/api/ui/projects/${encodeURIComponent(project)}/jev-calls/${encodeURIComponent(id)}`, { signal }),
  suggestWorkers: (id: string, body: RoutingRequest, signal?: AbortSignal) => req<RoutingSuggestions>(`/api/ui/tasks/${encodeURIComponent(id)}/routing`, { method: 'POST', body: JSON.stringify(body), signal }),
  recordRoutingChoice: (id: string, body: { expectedRevision: number; workerId: string; reason: string; requestId: string }, signal?: AbortSignal) => req<{ assigned: false }>(`/api/ui/tasks/${encodeURIComponent(id)}/routing-override`, { method: 'POST', body: JSON.stringify(body), signal }),
  botCredential: (project: string, bot: string) => req<BotCredentialView>(
    `/api/ui/projects/${encodeURIComponent(project)}/bots/${encodeURIComponent(bot)}/credential`),
  projectBots: (project: string, signal?: AbortSignal) => req<ProjectBotsView>(`/api/ui/projects/${encodeURIComponent(project)}/bots`, { signal }),
  setBotAccess: (project: string, bot: string, access: Omit<BotAccess, 'revision'> & { expectedRevision: number }) =>
    req<BotAccess>(`/api/ui/projects/${encodeURIComponent(project)}/bots/${encodeURIComponent(bot)}/access`, { method: 'PUT', body: JSON.stringify(access) }),
  setupBot: (project: string, name: string, definitionId: string) => req<{ bot: Agent; connected: boolean; error?: string }>(
    `/api/ui/projects/${encodeURIComponent(project)}/bots/setup`, { method: 'POST', body: JSON.stringify({ name, definitionId }) }),
  controlBot: (project: string, bot: string, action: string, expectedAccessRevision: number) => req<{ result: unknown }>(
    `/api/ui/projects/${encodeURIComponent(project)}/bots/${encodeURIComponent(bot)}/control`, { method: 'POST', body: JSON.stringify({ action, expectedAccessRevision }) }),
  connectBot: (project: string, bot: string, expectedRevision: number, expectedAccessRevision: number) => req<{ connected: boolean }>(
    `/api/ui/projects/${encodeURIComponent(project)}/bots/${encodeURIComponent(bot)}/connect`, { method: 'POST', body: JSON.stringify({ expectedRevision, expectedAccessRevision }) }),
  changeBotCredential: (project: string, bot: string, action: 'rotate' | 'revoke', expectedRevision: number) =>
    req<BotCredentialView & { token?: string }>(`/api/ui/projects/${encodeURIComponent(project)}/bots/${encodeURIComponent(bot)}/credential`,
      { method: 'POST', body: JSON.stringify({ action, expectedRevision }) }),
  channelTasks: (channel: string, signal?: AbortSignal) =>
    req<ChannelTaskPage>(`/api/ui/channels/${encodeURIComponent(channel)}/tasks`, { signal }),
  tasks: (project: string | null, cursor?: string | null, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (project) query.set('project', project);
    if (cursor) query.set('cursor', cursor);
    return req<TaskViewsPage>(`/api/ui/tasks${query.size ? `?${query}` : ''}`, { signal });
  },
  task: (id: string, signal?: AbortSignal) => req<{ item: TaskOverview }>(`/api/ui/tasks/${encodeURIComponent(id)}`, { signal }),
  controlTask: (id: string, body: TaskControlInput) =>
    req<{ task: TaskSnapshot }>(`/api/ui/tasks/${encodeURIComponent(id)}/control`, { method: 'POST', body: JSON.stringify(body) }),
  room: (channel: string) => req<RoomView>(`/api/ui/channels/${encodeURIComponent(channel)}/room`),
  roomHistory: (channel: string, before?: number) => req<{ history: Room[] }>(`/api/ui/channels/${encodeURIComponent(channel)}/room/history?before=${before ?? Number.MAX_SAFE_INTEGER}`),
  roomEvent: (channel: string, body: unknown) => req<RoomView>(`/api/ui/channels/${encodeURIComponent(channel)}/room`, { method: 'POST', body: JSON.stringify(body) }),
  setChannelArchived: (channel: string, archived: boolean) =>
    req<{ archived: boolean }>(`/api/ui/channels/${encodeURIComponent(channel)}/archive`, { method: archived ? 'POST' : 'DELETE' }),
  launchContext: (project: string) => req<LaunchContext>(`/api/ui/launch-context?project=${encodeURIComponent(project)}`),
  projectBotConfigurations: (slug: string) => req<{ configurations: ProjectBotConfiguration[] }>(`/api/ui/projects/${encodeURIComponent(slug)}/bots/catalog`),
  setBotAvailability: (slug: string, id: string, body: { enabled: boolean; expectedRevision: number }) =>
    req<{ configuration: ProjectBotConfiguration }>(`/api/ui/projects/${encodeURIComponent(slug)}/bots/catalog/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) }),
  saveProjectBotConfiguration: (slug: string, id: string, body: { enabled: boolean; values: SettingsValues; expectedRevision: number }) =>
    req<{ configuration: ProjectBotConfiguration }>(`/api/ui/projects/${encodeURIComponent(slug)}/bots/catalog/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(body) }),
  workerTemplates: (project: string) =>
    req<{ templates: WorkerTemplate[] }>(`/api/ui/projects/${encodeURIComponent(project)}/worker-templates`),
  launchRequests: () => req<{ requests: LaunchRequestView[] }>("/api/ui/launch-requests"),
  createWorkerTemplate: (project: string, body: { slug: string; spec: WorkerTemplateSpec }) =>
    req<WorkerTemplate>(`/api/ui/projects/${encodeURIComponent(project)}/worker-templates`, { method: "POST", body: JSON.stringify(body) }),
  updateWorkerTemplate: (id: string, body: { expectedRevision: number; slug?: string; spec: WorkerTemplateSpec }) =>
    req<WorkerTemplate>(`/api/ui/worker-templates/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  /** A reserved worker and its single-use launch ticket (docs/identity-lifecycle.md#reserved-workers). */
  reserveWorker: (id: string, label: string | null) =>
    req<{ agent: Agent; ticket: string }>(`/api/ui/worker-templates/${encodeURIComponent(id)}/reserve`,
      { method: "POST", body: JSON.stringify({ label }) }),
  deleteWorkerTemplate: (id: string, revision: number) =>
    req<{ ok: true }>(`/api/ui/worker-templates/${encodeURIComponent(id)}?revision=${revision}`, { method: "DELETE" }),
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
  agentOverview: (id: string, signal?: AbortSignal) =>
    req<AgentOverview>(`/api/ui/agents/${encodeURIComponent(id)}/overview`, { signal }),
  editAgentIdentity: (id: string, body: { expectedRevision: number; name?: string; focus?: string | null;
    seniority?: 'junior' | 'mid' | 'senior' }) =>
    req<{ agent: Agent; identityRevision: number }>(`/api/ui/agents/${encodeURIComponent(id)}/identity`,
      { method: 'PATCH', body: JSON.stringify(body) }),
  editAgentCapability: (id: string, body: { expectedRevision: number; card: CapabilityCard }) =>
    req<{ capability: CapabilityView & { lastEditorId: string | null } }>(
      `/api/ui/agents/${encodeURIComponent(id)}/capability`, { method: 'PUT', body: JSON.stringify(body) }),
  agentRemoveImpact: (id: string) => req<AgentRemoveImpact>(
    `/api/ui/agents/${encodeURIComponent(id)}/remove-impact`),
  removeAgentWithImpact: (id: string, impactToken: string) =>
    req<{ agent: Agent }>(`/api/ui/agents/${encodeURIComponent(id)}/remove`,
      { method: 'POST', body: JSON.stringify({ impactToken }) }),
  agentLifecycle: (id: string, before?: number) => req<{ items: AgentLifecycleEvent[]; hasMore: boolean; nextBefore: number | null }>(
    `/api/ui/agents/${encodeURIComponent(id)}/lifecycle${before === undefined ? '' : `?before=${before}`}`),
  agentRuntimeEvent: (id: string, kind: 'stop_requested' | 'stop_observed', session: string) =>
    req<{ event: AgentLifecycleEvent }>(`/api/ui/agents/${encodeURIComponent(id)}/runtime-event`,
      { method: 'POST', body: JSON.stringify({ kind, session }) }),
  setAgentLaunchMode: (name: string, mode: "approval" | "auto") =>
    req<{ agent: Agent }>(`/api/ui/agents/${encodeURIComponent(name)}/launch-mode`, {
      method: "PATCH", body: JSON.stringify({ mode }),
    }),
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
