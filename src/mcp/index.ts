import { setCapabilitiesSchema, suggestWorkersSchema, routingOutcomeSchema, routingOverrideSchema } from '../shared/routing.ts';
import { attachmentIdsSchema, cursorSchema, limitSchema, memberNamesSchema, messageBodySchema, nameSchema, normalizeChannelReference, referenceSchema, senioritySchema, sequenceSchema } from "../shared/api-contract.ts";
import type { HandoffList } from '../shared/handoffs.ts';
import { sendOperation } from "../client/send-operation.ts";
import { requestIdSchema } from "../shared/mutation.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentDownloadToFile, agentRequest } from "../client/http.ts";
import { imagePreview } from "../server/files.ts";
import { guessMime } from "../shared/mime.ts";
import { waitUntilMail } from "./wait-loop.ts";
import { digestExpansionSchema } from "../shared/digest.ts";
import { claimPreviewSchema } from '../shared/task-claims.ts';
import { assignTaskSchema, taskEventSchema } from '../shared/tasks.ts';
import { roomEventSchema } from '../shared/rooms.ts';
import { subscriptionSchema } from '../shared/notifications.ts';
import { packageVersion } from "../shared/package-root.ts";
import { attachablePath } from "./attach-guard.ts";
import { MESSAGE_EVENT_TYPES } from "../shared/types.ts";
import { JOIN_SESSION, PARAM_DESCRIPTIONS, SEARCH_NEXT, TOOL_DESCRIPTIONS, joinNext } from "./tool-text.ts";
import { MCP_HEARTBEAT_MS, MCP_WAIT_POLL_MS, WAIT_NEXT, type Agent, type Channel, type WaitResult } from "../shared/types.ts";

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

export { normalizeChannelReference };
/** URL path segment for a channel reference (UUID, name or #name). */
const channelPath = (reference: string) => encodeURIComponent(normalizeChannelReference(reference));
/** Explicit shapes of the subscriptions tool, listed in its description. */
export const SUBSCRIPTION_MODES = ["list", "set", "reset"] as const;

export function resolveVisibleWorkerReference(reference: string, roster: Agent[]): string {
  const value = reference.trim();
  if (z.string().uuid().safeParse(value).success) return value;
  const matches = roster.filter(agent => agent.role === 'worker' && agent.name.toLowerCase() === value.toLowerCase());
  if (matches.length === 1) return matches[0]!.id;
  if (!matches.length) throw new Error(`No visible worker named ${value}; pass a worker UUID or exact name from agents/worker_match_suggest`);
  throw new Error(`Worker name ${value} is ambiguous; pass the worker UUID from agents/worker_match_suggest`);
}

export async function startMcp() {
  let sessionToken = process.env.HIVEMIND_TOKEN;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  
  function token(): string {
    if (!sessionToken) throw new Error("Join first with the join tool.");
    return sessionToken;
  }
  
  function ensureHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      if (!sessionToken) return;
      agentRequest("POST", "/api/agent/ping", {}, sessionToken).catch(() => undefined);
    }, MCP_HEARTBEAT_MS);
    heartbeat.unref();
  }
  const server = new McpServer({ name: "hivemind", version: packageVersion() });
  // Serialize joins to prevent two concurrent first calls creating two identities.
  let joins: Promise<unknown> = Promise.resolve();
  const joinSerial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = joins.catch(() => undefined).then(work); joins = next; return next;
  };
  let joinedName: string | undefined;
  let inboxId = randomUUID();
  let inboxReady: Promise<{ sessionId: string }> | undefined;
  const inboxSession = (signal?: AbortSignal) => {
    if (!inboxReady) {
      inboxReady = agentRequest<{ sessionId: string }>(
        "POST", "/api/agent/inbox/session", { sessionId: inboxId }, token(), 10_000, signal,
      ).catch((error) => {
        inboxReady = undefined;
        throw error;
      });
    }
    return inboxReady;
  };

  server.tool(
    "join",
    TOOL_DESCRIPTIONS.join,
    {
      role: z.enum(["brain", "worker"]),
      seniority: senioritySchema.optional(),
      focus: z.string().max(4000).optional(),
      resume: z.string().optional(),
      project: z.string().optional(),
    },
    async ({ role, seniority, focus, resume, project }) => joinSerial(async () => {
      if (joinedName && resume && resume.toLowerCase() !== joinedName.toLowerCase())
        throw new Error("This process already has an identity; start a new MCP process to replace it");
      // The session key lives only in this process; resuming by name needs nothing stored.
      const auth = sessionToken;
      const result = await agentRequest<{
        agent: Agent;
        token: string;
        created: boolean;
        standingOrders?: string;
        ordersRef?: string; handoffs?: HandoffList;
        describe: string;
      }>(
        "POST",
        "/api/agent/join",
        {
          role,
          seniority: seniority ?? null,
          focus: focus ?? null,
          resume: resume ?? null,
          project: project ?? null,
          cwd: process.cwd(),
        },
        auth ?? null,
      );
      if (sessionToken !== result.token) { inboxId = randomUUID(); inboxReady = undefined; }
      sessionToken = result.token;
      joinedName = result.agent.name;
      ensureHeartbeat();
      return text({
        name: result.agent.name,
        describe: result.describe,
        created: result.created,
        session: JOIN_SESSION,
        standingOrders: result.standingOrders,
        ordersRef: result.ordersRef,
        handoffs: result.handoffs,
        next: joinNext(result.created, Boolean(result.handoffs?.items.length)),
      });
    }),
  );

  server.tool("whoami", TOOL_DESCRIPTIONS.whoami, { orders: z.boolean().optional() }, async ({ orders }) => {
    return text(await agentRequest("GET", `/api/agent/me${orders ? "?orders=1" : ""}`, undefined, token()));
  });

  server.tool("agents", TOOL_DESCRIPTIONS.agents, async () => {
    return text(await agentRequest("GET", "/api/agent/agents", undefined, token()));
  });

  server.tool("channels", TOOL_DESCRIPTIONS.channels, {
    unread: z.boolean().optional(),
  }, async ({ unread }) => {
    const q = unread ? "?unread=1" : "";
    return text(await agentRequest("GET", `/api/agent/channels${q}`, undefined, token()));
  });

  server.tool(
    "search",
    TOOL_DESCRIPTIONS.search,
    {
      q: z.string(),
      channel: referenceSchema.optional(),
      limit: limitSchema.optional(),
      before: cursorSchema.optional(),
    },
    async ({ q, channel, limit, before }) => {
      const params = new URLSearchParams({ q });
      if (channel) params.set("channel", normalizeChannelReference(channel));
      if (limit) params.set("limit", String(limit));
      if (before) params.set("beforeSeq", String(before));
      const result = await agentRequest<{ hits: unknown[]; hasMore: boolean }>(
        "GET",
        `/api/agent/search?${params}`,
        undefined,
        token(),
      );
      return text({
        ...result,
        next: result.hasMore
          ? SEARCH_NEXT
          : undefined,
      });
    },
  );

  server.tool(
    "history",
    TOOL_DESCRIPTIONS.history,
    {
      channel: referenceSchema,
      threadId: z.string().uuid().optional(),
      limit: limitSchema.optional(),
      since: cursorSchema.optional(),
      before: cursorSchema.optional(),
      meta: z.boolean().optional(),
    },
    async ({ channel, threadId, limit, since, before, meta }) => {
      const q = new URLSearchParams();
      if (threadId) q.set("threadId", threadId);
      if (limit) q.set("limit", String(limit));
      if (since !== undefined) q.set("afterSeq", String(since));
      if (before !== undefined) q.set("beforeSeq", String(before));
      if (meta === true) q.set("meta", "1");
      if (meta === false) q.set("meta", "0");
      const suffix = q.toString() ? `?${q}` : "";
      return text(
        await agentRequest(
          "GET",
          `/api/agent/channels/${channelPath(channel)}/messages${suffix}`,
          undefined,
          token(),
        ),
      );
    },
  );

  server.tool(
    "expand_digest",
    TOOL_DESCRIPTIONS.expand_digest,
    digestExpansionSchema.shape,
    async (args) => text(await agentRequest("POST", "/api/agent/messages/expand",
      { ...args, channel: normalizeChannelReference(args.channel) }, token())),
  );

  server.tool(
    "send",
    TOOL_DESCRIPTIONS.send,
    {
      body: messageBodySchema,
      requestId: requestIdSchema.optional(),
      channel: referenceSchema.optional(),
      to: nameSchema.optional(),
      threadId: z.string().uuid().optional(),
      attachmentIds: attachmentIdsSchema.optional(),
      recipients: memberNamesSchema.min(1).optional().describe(PARAM_DESCRIPTIONS.recipients),
      eventType: z.enum(MESSAGE_EVENT_TYPES).optional().describe(PARAM_DESCRIPTIONS.eventType),
      traceId: z.string().uuid().optional().describe(PARAM_DESCRIPTIONS.traceId),
      causeMessageId: z.string().uuid().optional().describe(PARAM_DESCRIPTIONS.causeMessageId),
    },
    async ({ body, channel, to, threadId, attachmentIds, eventType, recipients, traceId, causeMessageId, requestId }) => {
      let channelId = channel ? normalizeChannelReference(channel) : channel;
      if (to) {
        const dm = await agentRequest<{ channel: Channel }>("POST", "/api/agent/dms", { name: to }, token());
        channelId = dm.channel.id;
      }
      if (!channelId) throw new Error("Provide channel or to");
      return text(await sendOperation({ channel: channelId, body, threadId, attachmentIds, eventType, recipients, traceId, causeMessageId }, token(), requestId));
    },
  );

  server.tool("subscriptions",
    TOOL_DESCRIPTIONS.subscriptions,
    { mode: z.enum(SUBSCRIPTION_MODES), channel: subscriptionSchema.shape.channel.optional(),
      threadId: subscriptionSchema.shape.threadId, eventTypes: subscriptionSchema.shape.eventTypes.optional() },
    async ({ mode, channel, threadId, eventTypes }) => {
      if (mode === 'list') {
        if (channel !== undefined || threadId !== undefined || eventTypes !== undefined)
          throw new Error('mode=list takes no other fields: {mode:"list"}');
        return text(await agentRequest('GET', '/api/agent/subscriptions', undefined, token()));
      }
      if (channel === undefined) throw new Error(`mode=${mode} needs channel`);
      const scope = { channel: normalizeChannelReference(channel), ...(threadId ? { threadId } : {}) };
      if (mode === 'set') {
        if (eventTypes === undefined) throw new Error('mode=set needs eventTypes (use [] to mute)');
        return text(await agentRequest('POST', '/api/agent/subscriptions', { ...scope, eventTypes }, token()));
      }
      if (eventTypes !== undefined) throw new Error('mode=reset takes no eventTypes: {mode:"reset",channel,threadId?}');
      return text(await agentRequest('POST', '/api/agent/subscriptions/reset', scope, token()));
    });

  server.tool("get_room",
    TOOL_DESCRIPTIONS.get_room,
    { channel: referenceSchema, history: z.boolean().optional(), beforeRevision: z.number().int().positive().optional(), beforeTask: z.string().uuid().optional() },
    async ({ channel, history, beforeRevision, beforeTask }) => text(await agentRequest('GET',
      `/api/agent/channels/${channelPath(channel)}/room${history ? `/history?before=${beforeRevision ?? Number.MAX_SAFE_INTEGER}` : beforeTask ? `?beforeTask=${beforeTask}` : ''}`, undefined, token())));
  server.tool("room_event",
    TOOL_DESCRIPTIONS.room_event,
    { channel: referenceSchema, ...roomEventSchema.shape },
    async ({ channel, ...args }) => text(await agentRequest('POST', `/api/agent/channels/${channelPath(channel)}/room`, args, token())));
  server.tool("assign_task",
    TOOL_DESCRIPTIONS.assign_task,
    assignTaskSchema.shape,
    async args => text(await agentRequest('POST', '/api/agent/tasks',
      { ...args, channel: args.channel ? normalizeChannelReference(args.channel) : undefined }, token())));
  server.tool("get_worker_capabilities", TOOL_DESCRIPTIONS.get_worker_capabilities,
    { workerId: z.string().trim().min(1).max(100).describe(PARAM_DESCRIPTIONS.workerId) },
    async ({ workerId }) => {
      let resolved = workerId;
      if (!z.string().uuid().safeParse(workerId).success) {
        const roster = await agentRequest<{ agents: Agent[] }>('GET', '/api/agent/agents', undefined, token());
        resolved = resolveVisibleWorkerReference(workerId, roster.agents);
      }
      return text(await agentRequest('GET', `/api/agent/workers/${resolved}/capabilities`, undefined, token()));
    });
  server.tool("set_capabilities", TOOL_DESCRIPTIONS.set_capabilities,
    setCapabilitiesSchema.shape, async args => text(await agentRequest('POST', '/api/agent/capabilities', args, token())));
  server.tool("worker_match_suggest", TOOL_DESCRIPTIONS.worker_match_suggest,
    { taskId: z.string().uuid(), ...suggestWorkersSchema.shape }, async ({ taskId, ...args }) => text(await agentRequest('POST', `/api/agent/tasks/${taskId}/routing`, args, token())));
  server.tool("worker_match_outcome", TOOL_DESCRIPTIONS.worker_match_outcome,
    { taskId: z.string().uuid(), ...routingOutcomeSchema.shape }, async ({ taskId, ...args }) => text(await agentRequest('POST', `/api/agent/tasks/${taskId}/routing-outcome`, args, token())));
  server.tool("worker_match_override", TOOL_DESCRIPTIONS.worker_match_override,
    { taskId: z.string().uuid(), ...routingOverrideSchema.shape }, async ({ taskId, ...args }) => text(await agentRequest('POST', `/api/agent/tasks/${taskId}/routing-override`, args, token())));
  server.tool("get_handoffs",
    TOOL_DESCRIPTIONS.get_handoffs,
    { taskId: z.string().uuid().optional(), beforeTask: z.string().uuid().optional() },
    async ({ taskId, beforeTask }) => {
      if (taskId && beforeTask) throw new Error('Pass taskId (one checkpoint) or beforeTask (next page), not both');
      return text(await agentRequest('GET', taskId ? `/api/agent/tasks/${taskId}/handoff`
        : `/api/agent/handoffs${beforeTask ? `?beforeTask=${beforeTask}` : ''}`, undefined, token()));
    });
  server.tool("get_task",
    TOOL_DESCRIPTIONS.get_task,
    { taskId: z.string().uuid() },
    async ({ taskId }) => text(await agentRequest('GET', `/api/agent/tasks/${taskId}`, undefined, token())));
  server.tool("get_task_timeline",
    TOOL_DESCRIPTIONS.get_task_timeline,
    { taskId: z.string().uuid(), export: z.boolean().optional() },
    async ({ taskId, export: fixture }) => text(await agentRequest('GET',
      `/api/agent/tasks/${taskId}/timeline${fixture ? '/export' : ''}`, undefined, token())));
  server.tool("preview_task_claim",
    TOOL_DESCRIPTIONS.preview_task_claim,
    { taskId: z.string().uuid(), ...claimPreviewSchema.shape },
    async ({ taskId, ...args }) => text(await agentRequest('POST', `/api/agent/tasks/${taskId}/claim-preview`, args, token())));
  server.tool("task_event",
    TOOL_DESCRIPTIONS.task_event,
    { taskId: z.string().uuid(), ...taskEventSchema.shape },
    async ({ taskId, ...args }) => text(await agentRequest('POST', `/api/agent/tasks/${taskId}/events`, args, token())));

  server.tool(
    "wait",
    TOOL_DESCRIPTIONS.wait,
    {},
    async (_args, extra) => {
      const { sessionId } = await inboxSession(extra.signal);
      const result = await waitUntilMail(
        () =>
          agentRequest<WaitResult>(
            "POST",
            "/api/agent/wait",
            { timeoutMs: MCP_WAIT_POLL_MS, compact: true, sessionId },
            token(),
            MCP_WAIT_POLL_MS + 10_000,
            extra.signal,
          ),
        { signal: extra.signal },
      );
      return text({
        instruction: WAIT_NEXT,
        ...result,
      });
    },
  );

  server.tool(
    "ack_delivery",
    TOOL_DESCRIPTIONS.ack_delivery,
    { deliveryId: z.string().uuid() },
    async ({ deliveryId }, extra) => {
      const { sessionId } = await inboxSession(extra.signal);
      return text(await agentRequest(
        "POST", "/api/agent/inbox/ack", { sessionId, deliveryId }, token(), 10_000, extra.signal,
      ));
    },
  );

  server.tool(
    "create_channel",
    TOOL_DESCRIPTIONS.create_channel,
    {
      name: nameSchema,
      type: z.enum(["public", "private"]).optional(),
      topic: z.string().optional(),
      members: memberNamesSchema.optional(),
    },
    async ({ name, type, topic, members }) => {
      return text(
        await agentRequest(
          "POST",
          "/api/agent/channels",
          { name, type: type ?? "public", topic, memberNames: members },
          token(),
        ),
      );
    },
  );

  server.tool(
    "set_thread_status",
    TOOL_DESCRIPTIONS.set_thread_status,
    {
      threadId: z.string().uuid(),
      status: z.enum(["open", "in_progress", "blocked", "done"]),
    },
    async ({ threadId, status }) => {
      return text(await agentRequest("POST", `/api/agent/threads/${threadId}/status`, { status }, token()));
    },
  );

  server.tool(
    "invite",
    TOOL_DESCRIPTIONS.invite,
    {
      channel: referenceSchema,
      members: memberNamesSchema,
    },
    async ({ channel, members }) => {
      return text(
        await agentRequest(
          "POST",
          `/api/agent/channels/${channelPath(channel)}/invite`,
          { names: members },
          token(),
        ),
      );
    },
  );

  server.tool(
    "clear_context",
    TOOL_DESCRIPTIONS.clear_context,
    { agent: z.string() },
    async ({ agent }) => {
      return text(await agentRequest("POST", "/api/agent/clear-context", { name: agent }, token()));
    },
  );

  server.tool(
    "attach",
    TOOL_DESCRIPTIONS.attach,
    {
      path: z.string(),
      requestId: requestIdSchema.optional(),
      body: messageBodySchema.optional(),
      channel: referenceSchema.optional(),
      to: nameSchema.optional(),
      threadId: z.string().uuid().optional(),
      mime: z.string().optional(),
      eventType: z.enum(MESSAGE_EVENT_TYPES).optional(),
      recipients: memberNamesSchema.min(1).optional(),
      traceId: z.string().uuid().optional(),
      causeMessageId: z.string().uuid().optional(),
    },
    async ({ path: filePath, body, channel, to, threadId, mime, eventType, recipients, traceId, causeMessageId, requestId }) => {
      // Refuses credential stores, dotenv files and private keys, following symlinks (#218).
      const resolved = attachablePath(filePath);
      const name = path.basename(path.resolve(filePath));
      const guessed = mime ?? guessMime(name);
      let channelId = channel ? normalizeChannelReference(channel) : channel;
      if (to) {
        const dm = await agentRequest<{ channel: Channel }>("POST", "/api/agent/dms", { name: to }, token());
        channelId = dm.channel.id;
      }
      if (!channelId) throw new Error("Provide channel or to");
      return text(await sendOperation({ channel: channelId, body: body ?? "", threadId, eventType, recipients, traceId, causeMessageId,
        file: { path: resolved, name, mime: guessed } }, token(), requestId));
    },
  );

  server.tool(
    "fetch_file",
    TOOL_DESCRIPTIONS.fetch_file,
    { id: z.string().optional(), seq: sequenceSchema.optional(), index: cursorSchema.optional() },
    async ({ id, seq, index }, extra) => {
      let fileId = id;
      if (!fileId) {
        if (seq == null) throw new Error("Provide id or seq");
        const listed = await agentRequest<{ message: { attachments?: Array<{ id: string }> } }>(
          "GET",
          `/api/agent/messages/${seq}`,
          undefined,
          token(),
          undefined,
          extra.signal,
        );
        const att = listed.message.attachments?.[index ?? 0];
        if (!att) throw new Error("No attachment at that seq/index");
        fileId = att.id;
      }
      const dir = path.join(process.cwd(), ".hivemind-inbox");
      mkdirSync(dir, { recursive: true });
      const file = await agentDownloadToFile(
        `/api/agent/files/${encodeURIComponent(fileId)}`,
        token(),
        dir,
        fileId.slice(0, 8),
        extra.signal,
      );
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: JSON.stringify({ ok: true, path: file.path, mime: file.mime, bytes: file.bytes }) },
      ];
      if (file.mime.startsWith("image/")) {
        const preview = await imagePreview(file.path, file.mime, { signal: extra.signal });
        if (preview) content.push({ type: "image", data: preview.data.toString("base64"), mimeType: preview.mime });
      }
      return { content };
    },
  );

  server.tool(
    "react",
    TOOL_DESCRIPTIONS.react,
    { seq: sequenceSchema, emoji: z.string().trim().min(1).max(64), present: z.boolean().optional() },
    async ({ seq, emoji, present }) => {
      return text(await agentRequest("POST", `/api/agent/messages/${seq}/reactions`, { emoji, present: present ?? true }, token()));
    },
  );

  if (sessionToken) ensureHeartbeat();
  const previousClose = server.server.onclose;
  server.server.onclose = () => { if (heartbeat) clearInterval(heartbeat); previousClose?.(); };
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const launchedDirectly = process.argv[1]?.endsWith("mcp/index.ts") || process.argv[1]?.endsWith("mcp/index.js");
if (launchedDirectly) {
  startMcp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
