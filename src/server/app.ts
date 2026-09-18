import { Readable } from "node:stream";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { DEFAULT_WAIT_MS, HiveError, type Agent, type Seniority } from "../shared/types.ts";
import { resolveUploadMime } from "../shared/mime.ts";
import { standingOrders } from "../shared/standing-orders.ts";
import { Hive, describeAgent } from "./hive.ts";
import { safeFileName } from "./files.ts";
import { publicTelegramView, readTelegramFile, removeTelegramProjectSlug, writeTelegramFile } from "./telegram.ts";
import { parseProjectSlug } from "../shared/project.ts";
import { launchContext, projectPlugins, saveProjectPlugin, setProjectPluginAvailability } from "./plugins.ts";

export type AppHooks = {
  telegramRunning?: () => boolean;
  reloadTelegram?: () => boolean;
};

function fileDownload(hive: Hive, actor: Agent, id: string) {
  const opened = hive.openAttachment(actor, id);
  return new Response(Readable.toWeb(opened.stream) as ReadableStream, {
    headers: {
      "content-type": opened.meta.mime,
      "content-length": String(opened.meta.bytes),
      "content-disposition": `inline; filename="${safeFileName(opened.meta.name)}"`,
    },
  });
}

export function createApp(hive: Hive, hooks: AppHooks = {}) {
  const app = new Hono();
  app.use("*", cors({ origin: ["http://127.0.0.1:7421", "http://localhost:7421", "http://127.0.0.1:7420"] }));

  app.onError((err, c) => {
    if (err instanceof HiveError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: err.message || "internal error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, name: "hivemind" }));

  const ui = new Hono();
  ui.get("/launch-context", (c) => {
    const slug = c.req.query("project");
    const project = slug ? hive.getProjectBySlug(slug) : undefined;
    return c.json(launchContext(hive.home, c.req.url, project));
  });
  ui.get("/projects/:slug/plugins", (c) =>
    c.json({ plugins: projectPlugins(hive.home, hive.getProjectBySlug(c.req.param("slug"))) }));
  ui.patch("/projects/:slug/plugins/:id", async (c) => {
    const project = hive.getProjectBySlug(c.req.param("slug"));
    try {
      return c.json({ plugin: await setProjectPluginAvailability(hive.home, project,
        c.req.param("id"), await c.req.json()) });
    } catch (error) {
      throw new HiveError(400, error instanceof Error ? error.message : "Could not change plugin availability");
    }
  });
  ui.put("/projects/:slug/plugins/:id", async (c) => {
    const project = hive.getProjectBySlug(c.req.param("slug"));
    try {
      return c.json({ plugin: await saveProjectPlugin(hive.home, project, c.req.url,
        c.req.param("id"), await c.req.json()) });
    } catch (error) {
      throw new HiveError(400, error instanceof Error ? error.message : "Could not save plugin settings");
    }
  });
  ui.get("/snapshot", (c) => {
    const human = hive.getAgent("human");
    const inbox = hive.mentionInbox(human, 30);
    return c.json({
      you: human,
      projects: hive.listProjects(),
      agents: hive.listAgents(),
      channels: hive.listChannels(human),
      unread: hive.unreadCounts(human),
      mentions: inbox.messages,
      mentionsHasMore: inbox.hasMore,
      queued: hive.queuedCounts(),
      inbox: hive.inboxStatuses(),
      telegram: {
        running: Boolean(hooks.telegramRunning?.()),
        configured: publicTelegramView(hive.home).configured,
      },
    });
  });
  ui.get("/telegram", (c) => {
    hive.getAgent("human");
    return c.json(publicTelegramView(hive.home, Boolean(hooks.telegramRunning?.())));
  });
  ui.put("/telegram", async (c) => {
    hive.getAgent("human");
    const body = await c.req.json();
    const known = new Set(hive.listProjects().map((p) => p.slug));
    const projects: Record<string, { groupChatId: number }> = {};
    for (const [rawSlug, raw] of Object.entries(body.projects ?? {})) {
      const slug = parseProjectSlug(rawSlug);
      if (!known.has(slug)) throw new HiveError(404, `No project named ${slug}`);
      const id = raw && typeof raw === "object" ? Number((raw as { groupChatId?: unknown }).groupChatId) : Number(raw);
      if (!Number.isFinite(id)) continue;
      projects[slug] = { groupChatId: id };
    }
    writeTelegramFile(
      {
        botToken: body.botToken,
        allowUserIds: Array.isArray(body.allowUserIds) ? body.allowUserIds : String(body.allowUserIds ?? "").split(/[,\s]+/),
        projects,
      },
      hive.home,
    );
    const running = Boolean(hooks.reloadTelegram?.());
    return c.json(publicTelegramView(hive.home, running));
  });
  ui.post("/projects", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const project = hive.createProject(human, {
      name: String(body.name ?? ""),
      slug: body.slug,
      worktree: body.worktree ?? null,
    });
    return c.json({ project });
  });
  ui.patch("/projects/:slug", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const project = hive.updateProject(human, c.req.param("slug"), {
      name: body.name,
      worktree: body.worktree,
    });
    return c.json({ project });
  });
  ui.delete("/projects/:slug", (c) => {
    const human = hive.getAgent("human");
    const slug = parseProjectSlug(c.req.param("slug"));
    const chatId = readTelegramFile(hive.home)?.projects[slug];
    hive.deleteProject(human, slug, { telegramChatId: chatId });
    try {
      removeTelegramProjectSlug(slug, hive.home);
    } catch {
      /* hive row is already gone */
    }
    try {
      hooks.reloadTelegram?.();
    } catch {
      /* next serve still rereads telegram.json */
    }
    if (chatId != null) hive.forgetTelegramChat(chatId);
    return c.json({ ok: true });
  });
  ui.get("/mentions", (c) => {
    const human = hive.getAgent("human");
    const beforeSeq = c.req.query("beforeSeq") ? Number(c.req.query("beforeSeq")) : undefined;
    const project = c.req.query("project") ? hive.getProjectBySlug(String(c.req.query("project"))).id : undefined;
    const inbox = hive.mentionInbox(human, 30, beforeSeq, project);
    return c.json(inbox);
  });
  ui.post("/mentions/seen", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json().catch(() => ({}));
    const project = body.project ? hive.getProjectBySlug(String(body.project)).id : undefined;
    hive.markMentionsSeen(human, project);
    const inbox = hive.mentionInbox(human, 30, undefined, project);
    return c.json({ ...inbox, unread: hive.unreadCounts(human) });
  });
  ui.get("/search", (c) => {
    const human = hive.getAgent("human");
    const found = hive.searchMessages(human, {
      q: String(c.req.query("q") ?? ""),
      project: c.req.query("project"),
      channel: c.req.query("channel") || undefined,
      beforeSeq: c.req.query("beforeSeq") ? Number(c.req.query("beforeSeq")) : undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    return c.json(found);
  });
  ui.get("/channels/:id/messages", (c) => {
    const human = hive.getAgent("human");
    const id = c.req.param("id");
    const threadId = c.req.query("threadId") || null;
    const after = c.req.query("afterSeq");
    const before = c.req.query("beforeSeq");
    const listed = hive.listMessages(human, id, {
      threadId,
      afterSeq: after !== undefined ? Number(after) : undefined,
      beforeSeq: before !== undefined ? Number(before) : undefined,
      limit: Number(c.req.query("limit") ?? 80),
    });
    const ch = hive.getChannel(id);
    if (!threadId) {
      const latest = hive.latestSeq(ch.id);
      if (latest) hive.markRead(human, ch.id, latest);
    }
    return c.json({
      channel: ch,
      messages: listed.messages,
      hasOlder: listed.hasOlder,
      hasNewer: listed.hasNewer,
      cursors: listed.cursors,
      threads: hive.threadsInChannel(ch.id),
      replyCounts: hive.replyCounts(ch.id),
      task: threadId && hive.tasks.has(threadId) ? hive.tasks.get(human, threadId) : undefined,
    });
  });
  ui.post("/channels", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const channel = hive.createChannel(human, {
      name: String(body.name ?? ""),
      type: body.type ?? "public",
      topic: body.topic,
      memberNames: body.memberNames,
      project: body.project ?? null,
    });
    return c.json({ channel });
  });
  ui.get('/channels/:id/room', c => c.json(hive.rooms.view(hive.getAgent('human'), c.req.param('id'))));
  ui.get('/channels/:id/room/history', c => c.json({ history: hive.rooms.history(hive.getAgent('human'), c.req.param('id'), Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)) }));
  ui.post('/channels/:id/room', async c => c.json(hive.rooms.event(hive.getAgent('human'), c.req.param('id'),
    await c.req.json().catch(() => { throw new HiveError(400, 'Expected JSON'); }))));
  ui.post("/projects/:id/bots", async (c) => {
    const body = await c.req.json().catch(() => { throw new HiveError(400, "Expected JSON"); });
    return c.json(hive.createBot(hive.getAgent("human"), c.req.param("id"), body), 201);
  });
  ui.post("/channels/:id/messages", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const message = hive.postMessage(human, {
      channel: c.req.param("id"),
      body: String(body.body ?? ""),
      threadId: body.threadId ?? null,
      eventType: body.eventType,
      recipients: body.recipients,
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : undefined,
    });
    hive.markRead(human, message.channelId, message.seq);
    return c.json({ message });
  });
  ui.post("/files", async (c) => {
    const human = hive.getAgent("human");
    const name = c.req.header("x-file-name") || "paste.png";
    const file = await hive.createFile(human, {
      name,
      mime: resolveUploadMime(c.req.header("x-file-mime"), name),
      body: c.req.raw.body,
    });
    return c.json({ file });
  });
  ui.get("/files/:id", (c) => fileDownload(hive, hive.getAgent("human"), c.req.param("id")));
  ui.post("/messages/:seq/reactions", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const result = hive.toggleReaction(human, Number(c.req.param("seq")), String(body.emoji ?? ""));
    return c.json(result);
  });
  ui.post("/dms", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const channel = hive.openDm(human, String(body.name ?? ""));
    return c.json({ channel });
  });
  ui.post("/threads/:id/status", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const thread = hive.setThreadStatus(human, c.req.param("id"), body.status ?? null);
    return c.json({ thread });
  });
  ui.post("/clear-context", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const message = hive.clearContext(human, String(body.name ?? ""));
    return c.json({ message });
  });
  ui.post("/channels/:id/invite", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? "")];
    const channel = hive.invite(human, c.req.param("id"), names.filter(Boolean));
    return c.json({ channel });
  });
  ui.post("/read", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    hive.markRead(human, String(body.channelId), Number(body.seq));
    return c.json({ ok: true });
  });

  const agent = new Hono();
  agent.use("*", async (c, next) => {
    if (c.req.path.endsWith("/join") && c.req.method === "POST") return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new HiveError(401, "Missing token. Join first.");
    const me = hive.agentByToken(token);
    if (me.role !== "brain" && me.role !== "worker") throw new HiveError(403, "Only brains and workers use the agent API");
    hive.touch(me.id, true);
    c.set("me", me);
    c.set("token", token);
    await next();
  });

  agent.post("/join", async (c) => {
    const body = await c.req.json();
    const header = c.req.header("authorization") ?? "";
    const bearer = header.replace(/^Bearer\s+/i, "").trim();
    const result = hive.join({
      role: body.role,
      seniority: (body.seniority ?? null) as Seniority | null,
      focus: body.focus ?? null,
      token: bearer || body.token || null,
      resumeName: body.resume || body.resumeName || null,
      project: body.project ?? null,
      cwd: body.cwd ?? null,
    });
    return c.json({
      ...result,
      describe: describeAgent(result.agent),
      standingOrders: result.created ? standingOrders(result.agent) : undefined,
      ordersRef: result.created ? undefined : "unchanged",
    });
  });

  agent.get("/me", (c) => {
    const me = c.get("me");
    if (c.req.query("orders") === "1") {
      return c.json({ you: me, standingOrders: standingOrders(me) });
    }
    return c.json({
      you: {
        name: me.name,
        role: me.role,
        seniority: me.seniority,
        focus: me.focus,
        online: me.online,
        project: me.project,
      },
      ordersRef: "unchanged",
    });
  });
  agent.get("/agents", (c) =>
    c.json({
      agents: hive.listAgents(c.get("me")).map(({ createdAt: _c, ...a }) => a),
    }),
  );
  agent.get("/search", (c) => {
    const me = c.get("me");
    const found = hive.searchMessages(me, {
      q: String(c.req.query("q") ?? ""),
      project: c.req.query("project") || me.project,
      channel: c.req.query("channel") || undefined,
      beforeSeq: c.req.query("beforeSeq") ? Number(c.req.query("beforeSeq")) : undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    return c.json(found);
  });
  agent.get('/subscriptions', c => c.json({ subscriptions: hive.notifications.list(c.get('me')) }));
  agent.post('/subscriptions', async c => c.json({ subscriptions: hive.notifications.set(c.get('me'), await c.req.json()) }));
  agent.post('/subscriptions/reset', async c => c.json({ subscriptions: hive.notifications.reset(c.get('me'), await c.req.json()) }));
  agent.get("/channels", (c) => {
    const me = c.get("me");
    const unread = c.req.query("unread") === "1" ? hive.unreadCounts(me) : undefined;
    return c.json({ channels: hive.listChannels(me), unread });
  });
  agent.get("/channels/:id/messages", (c) => {
    const me = c.get("me");
    const limit = Number(c.req.query("limit") ?? 20);
    const after = c.req.query("afterSeq");
    const before = c.req.query("beforeSeq");
    const listed = hive.listMessages(me, c.req.param("id"), {
      threadId: c.req.query("threadId") || null,
      afterSeq: after !== undefined ? Number(after) : undefined,
      beforeSeq: before !== undefined ? Number(before) : undefined,
      limit,
    });
    const ch = hive.getChannel(c.req.param("id"), me.projectId);
    const meta = c.req.query("meta") === "1";
    return c.json({
      channel: { id: ch.id, name: ch.name, type: ch.type },
      messages: listed.messages,
      hasOlder: listed.hasOlder,
      hasNewer: listed.hasNewer,
      cursors: listed.cursors,
      threads: meta ? hive.threadsInChannel(ch.id) : undefined,
      replyCounts: meta ? hive.replyCounts(ch.id) : undefined,
    });
  });
  agent.post("/channels", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const channel = hive.createChannel(me, {
      name: String(body.name ?? ""),
      type: body.type ?? "public",
      topic: body.topic,
      memberNames: body.memberNames,
    });
    return c.json({ channel });
  });
  agent.post("/channels/:id/messages", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const message = hive.postMessage(me, {
      channel: c.req.param("id"),
      body: String(body.body ?? ""),
      threadId: body.threadId ?? null,
      eventType: body.eventType,
      recipients: body.recipients,
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : undefined,
    });
    return c.json({ ok: true, seq: message.seq, id: message.id });
  });
  agent.get("/messages/:seq", (c) => {
    const me = c.get("me");
    return c.json({ message: hive.getVisibleMessage(me, Number(c.req.param("seq"))) });
  });
  agent.post("/messages/expand", async (c) => {
    const body = await c.req.json().catch(() => { throw new HiveError(400, "Expected JSON"); });
    return c.json(hive.expandDigest(c.get("me"), body));
  });
  agent.post('/tasks', async c => {
    const body = await c.req.json().catch(() => { throw new HiveError(400, 'Expected JSON'); });
    return c.json(hive.tasks.assign(c.get('me'), body));
  });
  agent.get('/channels/:id/room', c => c.json(hive.rooms.view(c.get('me'), c.req.param('id'), c.req.query('beforeTask'))));
  agent.get('/channels/:id/room/history', c => c.json({ history: hive.rooms.history(c.get('me'), c.req.param('id'), Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)) }));
  agent.post('/channels/:id/room', async c => c.json(hive.rooms.event(c.get('me'), c.req.param('id'),
    await c.req.json().catch(() => { throw new HiveError(400, 'Expected JSON'); }))));
  agent.get('/tasks/:id', c => c.json({ task: hive.tasks.get(c.get('me'), c.req.param('id')) }));
  agent.post('/tasks/:id/events', async c => {
    const body = await c.req.json().catch(() => { throw new HiveError(400, 'Expected JSON'); });
    return c.json(hive.tasks.event(c.get('me'), c.req.param('id'), body));
  });
  agent.post("/files", async (c) => {
    const me = c.get("me");
    const name = c.req.header("x-file-name") || "file";
    const file = await hive.createFile(me, {
      name,
      mime: resolveUploadMime(c.req.header("x-file-mime"), name),
      body: c.req.raw.body,
    });
    return c.json({ file });
  });
  agent.get("/files/:id", (c) => fileDownload(hive, c.get("me"), c.req.param("id")));
  agent.post("/messages/:seq/reactions", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const result = hive.toggleReaction(me, Number(c.req.param("seq")), String(body.emoji ?? ""));
    return c.json({ ok: true, added: result.added, seq: result.message.seq });
  });
  agent.post("/dms", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const channel = hive.openDm(me, String(body.name ?? body.to ?? ""));
    return c.json({ channel });
  });
  agent.post("/threads/:id/status", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const thread = hive.setThreadStatus(me, c.req.param("id"), body.status ?? null);
    return c.json({ thread });
  });
  agent.post("/channels/:id/invite", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? body.member ?? "")];
    const channel = hive.invite(me, c.req.param("id"), names.filter(Boolean));
    return c.json({ channel });
  });
  agent.post("/clear-context", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const message = hive.clearContext(me, String(body.name ?? body.agent ?? ""));
    return c.json({ message });
  });
  agent.post("/wait", async (c) => {
    const me = c.get("me");
    const body = await c.req.json().catch(() => ({}));
    // Older MCP clients classify only the error text, discarding the HTTP status.
    // Keep this prefix so incompatible clients stop retrying and surface the upgrade.
    if (body?.sessionId == null) throw new HiveError(409,
      "HTTP 409: Inbox delivery protocol changed. Restart the Hivemind MCP client and rejoin. HTTP/CLI clients must open an inbox session and include sessionId in wait. Do not retry this wait unchanged.");
    if (typeof body.sessionId !== "string") throw new HiveError(400, "Expected sessionId");
    const timeoutMs = Number(body.timeoutMs ?? DEFAULT_WAIT_MS);
    const result = await hive.wait(me, timeoutMs, c.req.raw.signal, { compact: Boolean(body.compact), sessionId: body.sessionId });
    return c.json(result);
  });
  agent.post("/inbox/session", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.sessionId !== "string") throw new HiveError(400, "Expected sessionId");
    return c.json({ sessionId: hive.openInboxSession(c.get("me"), body.sessionId) });
  });
  agent.post("/inbox/ack", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.sessionId !== "string" || typeof body?.deliveryId !== "string")
      throw new HiveError(400, "Expected sessionId and deliveryId");
    return c.json(hive.acknowledgeInbox(c.get("me"), body.sessionId, body.deliveryId));
  });
  agent.post("/ping", (c) => {
    const me = c.get("me");
    return c.json({ ok: true, name: me.name, online: true });
  });
  agent.post("/leave", (c) => {
    const me = c.get("me");
    hive.setOffline(me.id);
    return c.json({ ok: true });
  });

  // Provider-neutral ingress. The credential determines identity, never the payload.
  const bot = new Hono<{ Variables: { me: Agent } }>();
  bot.use("*", async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    if (!match) throw new HiveError(401, "A Bearer bot token is required");
    const me = hive.agentByToken(match[1]!);
    if (me.role !== "bot") throw new HiveError(403, "A bot identity is required");
    c.set("me", me);
    await next();
  });
  bot.post("/channels/:id/messages", async (c) => {
    const body = await c.req.json().catch(() => { throw new HiveError(400, "Expected JSON"); });
    const result = hive.postBotMessage(c.get("me"), c.req.param("id"), body);
    return c.json(result, result.duplicate ? 200 : 201);
  });
  bot.get('/channels/:id/links', c => c.json({ links: hive.rooms.botLinks(c.get('me'), c.req.param('id')) }));
  bot.post('/channels/:id/links', async c => c.json({ link: hive.rooms.registerLink(c.get('me'), c.req.param('id'),
    await c.req.json().catch(() => { throw new HiveError(400, 'Expected JSON'); })) }));
  bot.post('/channels/:id/links/:link/status', async c => c.json({ link: hive.rooms.reportLink(c.get('me'), c.req.param('id'), c.req.param('link'),
    await c.req.json().catch(() => { throw new HiveError(400, 'Expected JSON'); })) }));
  bot.post("/files", async (c) => {
    const name = c.req.header("x-file-name") || "attachment";
    const file = await hive.createFile(c.get("me"), {
      name,
      mime: resolveUploadMime(c.req.header("x-file-mime"), name),
      body: c.req.raw.body,
    });
    return c.json({ file }, 201);
  });
  app.route("/api/bot", bot);
  app.route("/api/ui", ui);
  app.route("/api/agent", agent);
  return app;
}

declare module "hono" {
  interface ContextVariableMap {
    me: import("../shared/types.ts").Agent;
    token: string;
  }
}
