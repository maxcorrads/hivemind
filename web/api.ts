import type { Agent, AttachmentMeta, Channel, Message, Project, SearchHit, Thread, ThreadStatus, InboxStatus } from "../src/shared/types.ts";
import { resolveUploadMime } from "../src/shared/mime.ts";
import type { LaunchContext } from "../src/shared/launch-prompt.ts";
import type { ProjectPluginView, SettingsValues } from "../src/shared/plugin-settings.ts";
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { RoomView, Room } from '../src/shared/rooms.ts';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export type Snapshot = {
  you: Agent;
  projects: Project[];
  agents: Agent[];
  channels: Channel[];
  unread: Record<string, number>;
  mentions: Message[];
  mentionsHasMore?: boolean;
  queued: Record<string, number>;
  inbox?: Record<string, InboxStatus>;
  telegram?: { running: boolean; configured: boolean };
};

export type TelegramSettings = {
  running: boolean;
  configured: boolean;
  tokenSet: boolean;
  tokenHint: string | null;
  allowUserIds: number[];
  projects: Record<string, number>;
};

export type ChannelPayload = {
  task?: TaskSnapshot;
  channel: Channel;
  messages: Message[];
  hasOlder?: boolean;
  threads: Thread[];
  replyCounts: Record<string, number>;
};

export const api = {
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
  snapshot: () => req<Snapshot>("/api/ui/snapshot"),
  mentions: (beforeSeq?: number, project?: string) => {
    const q = new URLSearchParams();
    if (beforeSeq) q.set("beforeSeq", String(beforeSeq));
    if (project) q.set("project", project);
    const suffix = q.toString() ? `?${q}` : "";
    return req<{ messages: Message[]; hasMore: boolean }>(`/api/ui/mentions${suffix}`);
  },
  markMentionsSeen: (project?: string) =>
    req<{ messages: Message[]; hasMore: boolean; unread: Record<string, number> }>("/api/ui/mentions/seen", {
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
  messages: (id: string, threadId?: string | null, beforeSeq?: number) => {
    const q = new URLSearchParams();
    if (threadId) q.set("threadId", threadId);
    if (beforeSeq) q.set("beforeSeq", String(beforeSeq));
    const suffix = q.toString() ? `?${q}` : "";
    return req<ChannelPayload>(`/api/ui/channels/${encodeURIComponent(id)}/messages${suffix}`);
  },
  send: (id: string, body: string, threadId?: string | null, attachmentIds?: string[]) =>
    req<{ message: Message }>(`/api/ui/channels/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, threadId: threadId ?? null, attachmentIds }),
    }),
  upload: async (file: File): Promise<AttachmentMeta> => {
    const res = await fetch("/api/ui/files", {
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
  react: (seq: number, emoji: string) =>
    req<{ message: Message; added: boolean }>(`/api/ui/messages/${seq}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
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
  let closed = false;
  let socket: WebSocket | null = null;
  let timer = 0;
  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    socket.onopen = () => onLive?.(true);
    socket.onmessage = (e) => {
      try {
        onEvent(JSON.parse(String(e.data)));
      } catch {
        /* ignore */
      }
    };
    socket.onclose = () => {
      onLive?.(false);
      if (!closed) timer = window.setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    socket?.close();
  };
}
