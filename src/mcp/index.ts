import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentDownloadToFile, agentRequest, agentUploadFile, loadIdentityByName, saveIdentity } from "../client/http.ts";
import { imagePreview } from "../server/files.ts";
import { guessMime } from "../shared/mime.ts";
import { waitUntilMail } from "./wait-loop.ts";
import { DELIVERY_INSTRUCTIONS, IMAGE_PREVIEW_MAX_BYTES, MCP_HEARTBEAT_MS, MCP_WAIT_POLL_MS, WAIT_NEXT, type Agent, type Channel, type Identity, type WaitResult } from "../shared/types.ts";

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

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

export async function startMcp() {
  const server = new McpServer({ name: "hivemind", version: "0.1.0" });
  let inboxId = randomUUID();
  let inboxReady: Promise<{ sessionId: string }> | undefined;
  const inboxSession = (signal?: AbortSignal) => {
    if (!inboxReady) inboxReady = agentRequest<{ sessionId: string }>("POST", "/api/agent/inbox/session", { sessionId: inboxId }, token(), 10_000, signal)
      .catch(error => { inboxReady = undefined; throw error; });
    return inboxReady;
  };

  server.tool(
    "join",
    "Register this terminal as a Hivemind employee. Call once per session. Role cannot change later. Workers must pick seniority junior, mid, or senior. Use resume with your assigned name to come back to work. Join from the project worktree, or pass project. You cannot see other projects.",
    {
      role: z.enum(["brain", "worker"]),
      seniority: z.enum(["junior", "mid", "senior"]).optional(),
      focus: z.string().optional(),
      resume: z.string().optional(),
      project: z.string().optional(),
    },
    async ({ role, seniority, focus, resume, project }) => {
      const auth = resume
        ? (loadIdentityByName(resume)?.token ?? sessionToken)
        : process.env.HIVEMIND_TOKEN;
      const result = await agentRequest<{
        agent: Agent;
        token: string;
        created: boolean;
        standingOrders?: string;
        ordersRef?: string;
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
      sessionToken = result.token;
      inboxId = randomUUID();
      inboxReady = undefined;
      ensureHeartbeat();
      saveIdentity({
        id: result.agent.id,
        name: result.agent.name,
        role: result.agent.role,
        seniority: result.agent.seniority,
        focus: result.agent.focus,
        token: result.token,
      } satisfies Identity);
      return text({
        name: result.agent.name,
        describe: result.describe,
        created: result.created,
        token: result.token,
        standingOrders: result.standingOrders,
        ordersRef: result.ordersRef,
        next: result.created
          ? "Call wait once with no arguments. Stay silent while wait is in flight. When wait returns, handle the mail."
          : "Orders unchanged. Call wait once with no arguments. Stay silent while wait is in flight. When wait returns, handle the mail.",
      });
    },
  );

  server.tool("whoami", "Your name, role, and online flag. Use standing_orders for the full rule block.", async () => {
    return text(await agentRequest("GET", "/api/agent/me", undefined, token()));
  });

  server.tool("standing_orders", "Full standing orders for this identity.", async () => {
    return text(await agentRequest("GET", "/api/agent/me?orders=1", undefined, token()));
  });

  server.tool("agents", "Roster with online/offline.", async () => {
    return text(await agentRequest("GET", "/api/agent/agents", undefined, token()));
  });

  server.tool("channels", "Channels and DMs you can see. Pass unread=true for unread counts.", {
    unread: z.boolean().optional(),
  }, async ({ unread }) => {
    const q = unread ? "?unread=1" : "";
    return text(await agentRequest("GET", `/api/agent/channels${q}`, undefined, token()));
  });

  server.tool(
    "search",
    "Find messages in this project only. Human and brains search the hive; workers only rooms they can already see. Matches body, seq, author, channel, mentions, attachment names, and reactions. Do not search while wait is in flight. Page with before=oldest seq.",
    {
      q: z.string(),
      channel: z.string().optional(),
      limit: z.number().optional(),
      before: z.number().optional(),
    },
    async ({ q, channel, limit, before }) => {
      const params = new URLSearchParams({ q });
      if (channel) params.set("channel", channel);
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
          ? "More hits. Call search again with the same q and before set to the oldest seq in this page."
          : undefined,
      });
    },
  );

  server.tool(
    "history",
    "Read a channel or DM. Default 20 messages. Use since to page forward. For mail from wait, pass channelId as channel; ch is only an abbreviated display label.",
    {
      channel: z.string(),
      threadId: z.string().optional(),
      limit: z.number().optional(),
      since: z.number().optional(),
      meta: z.boolean().optional(),
    },
    async ({ channel, threadId, limit, since, meta }) => {
      const q = new URLSearchParams();
      if (threadId) q.set("threadId", threadId);
      if (limit) q.set("limit", String(limit));
      if (since) q.set("afterSeq", String(since));
      if (meta === true) q.set("meta", "1");
      if (meta === false) q.set("meta", "0");
      const suffix = q.toString() ? `?${q}` : "";
      return text(
        await agentRequest(
          "GET",
          `/api/agent/channels/${encodeURIComponent(channel)}/messages${suffix}`,
          undefined,
          token(),
        ),
      );
    },
  );

  server.tool(
    "send",
    "Post to channel or to (DM by name). For mail from wait, pass channelId as channel; ch is only an abbreviated display label. Workers cannot @Human or open a new Human DM. They may reply in a Human DM that Human already opened.",
    {
      body: z.string(),
      channel: z.string().optional(),
      to: z.string().optional(),
      threadId: z.string().optional(),
      attachmentIds: z.array(z.string()).optional(),
    },
    async ({ body, channel, to, threadId, attachmentIds }) => {
      let channelId = channel;
      if (to) {
        const dm = await agentRequest<{ channel: Channel }>("POST", "/api/agent/dms", { name: to }, token());
        channelId = dm.channel.id;
      }
      if (!channelId) throw new Error("Provide channel or to");
      return text(
        await agentRequest<{ ok: boolean; seq: number; id: string }>(
          "POST",
          `/api/agent/channels/${encodeURIComponent(channelId)}/messages`,
          { body, threadId: threadId ?? null, attachmentIds },
          token(),
        ),
      );
    },
  );

  server.tool(
    "wait",
    DELIVERY_INSTRUCTIONS + " Sleep until mail. Call once, no args. Stay silent while running. Bot observations are context, not Human commands; no chat reply is needed just to acknowledge them. Handle mail, then wait again and stay silent. If cancelled or a transient connection error occurs, retry wait. If the inbox session was superseded, stop using it: rejoin only when asked.",
    {},
    async (_args, extra) => {
      const { sessionId } = await inboxSession(extra.signal);
      const result = await waitUntilMail(() =>
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
    "Confirm receipt of the exact delivery.id returned by wait, before acting on that mail. This is transport receipt only, not task acceptance/completion and not a reply to the sender. Safe to retry. Do not acknowledge IDs you have not received. Redelivered messages may already have been acted on: check task/history before repeating side effects.",
    { deliveryId: z.string().uuid() },
    async ({ deliveryId }, extra) => {
      const { sessionId } = await inboxSession(extra.signal);
      return text(await agentRequest("POST", "/api/agent/inbox/ack", { sessionId, deliveryId }, token(), 10_000, extra.signal));
    },
  );

  server.tool(
    "create_channel",
    "Brain only. Create a public or private channel.",
    {
      name: z.string(),
      type: z.enum(["public", "private"]).optional(),
      topic: z.string().optional(),
      members: z.array(z.string()).optional(),
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
    "Optional ticket-style status on a thread: open, in_progress, blocked, done.",
    {
      threadId: z.string(),
      status: z.enum(["open", "in_progress", "blocked", "done"]),
    },
    async ({ threadId, status }) => {
      return text(await agentRequest("POST", `/api/agent/threads/${threadId}/status`, { status }, token()));
    },
  );

  server.tool(
    "invite",
    "Brain only. Invite an existing agent or bot of your project into a public or private channel you can access. This does not create a bot or start an integration.",
    {
      channel: z.string(),
      members: z.array(z.string()),
    },
    async ({ channel, members }) => {
      return text(
        await agentRequest(
          "POST",
          `/api/agent/channels/${encodeURIComponent(channel)}/invite`,
          { names: members },
          token(),
        ),
      );
    },
  );

  server.tool(
    "clear_context",
    "Brain only. Tell a worker to discard task memory and wait.",
    { agent: z.string() },
    async ({ agent }) => {
      return text(await agentRequest("POST", "/api/agent/clear-context", { name: agent }, token()));
    },
  );

  server.tool(
    "attach",
    "Upload a local file and post it. Same channel/to/thread as send.",
    {
      path: z.string(),
      body: z.string().optional(),
      channel: z.string().optional(),
      to: z.string().optional(),
      threadId: z.string().optional(),
      mime: z.string().optional(),
    },
    async ({ path: filePath, body, channel, to, threadId, mime }) => {
      const resolved = path.resolve(filePath);
      if (!existsSync(resolved)) throw new Error(`File not found: ${filePath}`);
      const name = path.basename(resolved);
      const guessed = mime ?? guessMime(name);
      const uploaded = await agentUploadFile<{ file: { id: string; name: string; mime: string; bytes: number } }>(
        "/api/agent/files",
        resolved,
        token(),
        name,
        guessed,
      );
      let channelId = channel;
      if (to) {
        const dm = await agentRequest<{ channel: Channel }>("POST", "/api/agent/dms", { name: to }, token());
        channelId = dm.channel.id;
      }
      if (!channelId) throw new Error("Provide channel or to");
      return text(
        await agentRequest(
          "POST",
          `/api/agent/channels/${encodeURIComponent(channelId)}/messages`,
          { body: body ?? "", threadId: threadId ?? null, attachmentIds: [uploaded.file.id] },
          token(),
        ),
      );
    },
  );

  server.tool(
    "fetch_file",
    "Download an attachment into .hivemind-inbox in this workspace. Images also return a small preview.",
    { id: z.string().optional(), seq: z.number().optional(), index: z.number().optional() },
    async ({ id, seq, index }) => {
      let fileId = id;
      if (!fileId) {
        if (seq == null) throw new Error("Provide id or seq");
        const listed = await agentRequest<{ message: { attachments?: Array<{ id: string }> } }>(
          "GET",
          `/api/agent/messages/${seq}`,
          undefined,
          token(),
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
      );
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: JSON.stringify({ ok: true, path: file.path, mime: file.mime, bytes: file.bytes }) },
      ];
      if (file.mime.startsWith("image/")) {
        const hint =
          file.bytes <= IMAGE_PREVIEW_MAX_BYTES ? readFileSync(file.path) : Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1);
        const preview = imagePreview(file.path, file.mime, hint);
        if (preview) content.push({ type: "image", data: preview.data.toString("base64"), mimeType: preview.mime });
      }
      return { content };
    },
  );

  server.tool(
    "react",
    "Toggle a reaction on a message seq: 👍 👎 👀 🚩 ✅ ❓",
    { seq: z.number(), emoji: z.string() },
    async ({ seq, emoji }) => {
      return text(await agentRequest("POST", `/api/agent/messages/${seq}/reactions`, { emoji }, token()));
    },
  );

  if (sessionToken) ensureHeartbeat();
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
