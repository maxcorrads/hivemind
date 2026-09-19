import { Readable } from "node:stream";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { DEFAULT_WAIT_MS, HiveError, type Agent, type Seniority } from "../shared/types.ts";
import { resolveUploadMime } from "../shared/mime.ts";
import { standingOrders } from "../shared/standing-orders.ts";
import { Hive, describeAgent } from "./hive.ts";
import { safeFileName } from "./files.ts";
import { telegramDestinationForSeq, loadTelegramConfig, telegramConfigKey, publicTelegramView, readTelegramFile, removeTelegramProjectSlug, writeTelegramFile, type TelegramFileInput } from "./telegram.ts";
import { parseProjectSlug } from "../shared/project.ts";
import { launchContext, projectPlugins, saveProjectPlugin, setProjectPluginAvailability, pluginErrorMessage } from "./plugins.ts";
import { BotIngressBudget, readLimitedJson, assertLocalHumanRequest, BOT_JSON_BYTES, PLUGIN_REQUEST_BYTES, CREDENTIAL_JSON_BYTES } from "./ingress.ts";

export type AppHooks = {
  telegramRunning?: () => boolean;
  reloadTelegram?: () => boolean | Promise<boolean>;
  configureTelegram?: (input: TelegramFileInput) => Promise<boolean>;
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
    if (err instanceof HiveError) {
      if (err.status === 429) c.header("Retry-After", "1");
      return c.json({ error: err.message }, err.status as 400);
    }
    console.error("Unexpected Hivemind request failure");
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, name: "hivemind" }));

  const ui = new Hono();
  ui.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    assertLocalHumanRequest(c.req.raw);
    await next();
  });
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
        c.req.param("id"), await readLimitedJson(c.req.raw, PLUGIN_REQUEST_BYTES)) });
    } catch (error) {
      if (error instanceof HiveError) throw error;
      throw new HiveError(400, pluginErrorMessage(error));
    }
  });
  ui.put("/projects/:slug/plugins/:id", async (c) => {
    const project = hive.getProjectBySlug(c.req.param("slug"));
    try {
      return c.json({ plugin: await saveProjectPlugin(hive.home, project, c.req.url,
        c.req.param("id"), await readLimitedJson(c.req.raw, PLUGIN_REQUEST_BYTES)) });
    } catch (error) {
      if (error instanceof HiveError) throw error;
      throw new HiveError(400, pluginErrorMessage(error));
    }
  });
  ui.get("/snapshot", (c) => {
    const human = hive.getAgent("human");
    return c.json({
      you: human,
      projects: hive.listProjects(),
      agents: hive.listAgents(),
      channels: hive.listChannels(human),
      ...hive.readSnapshot(human),
      queued: hive.queuedCounts(),
      inbox: hive.inboxStatuses(),
      telegram: {
        running: Boolean(hooks.telegramRunning?.()),
        configured: publicTelegramView(hive.home).configured,
        ...hive.telegramHealth(),
      },
    });
  });
  ui.get("/read-state", (c) => c.json(hive.readSnapshot(hive.getAgent("human"))));
  ui.get("/telegram", (c) => {
    hive.getAgent("human");
    return c.json({
      ...publicTelegramView(hive.home, Boolean(hooks.telegramRunning?.())),
      ...hive.telegramHealth(),
    });
  });
  ui.get("/telegram/failures", (c) => {
    hive.getAgent("human");
    return c.json({ failures: hive.telegramFailures(Number(c.req.query("limit") ?? 50)) });
  });
  ui.post("/telegram/failures/:id/retry", (c) => {
    hive.getAgent("human");
    hive.retryTelegramFailure(c.req.param("id"), seq => telegramDestinationForSeq(hive, seq));
    return c.json({ ok: true, failures: hive.telegramFailureCount() });
  });
  ui.post("/telegram/failures/:id/discard", (c) => {
    hive.getAgent("human");
    hive.discardTelegramFailure(c.req.param("id"));
    return c.json({ ok: true, failures: hive.telegramFailureCount() });
  });
  ui.get("/telegram/quarantine", c => {
    hive.getAgent("human");
    return c.json({ updates: hive.telegramQuarantine(Number(c.req.query("limit") ?? 50)) });
  });
  ui.post("/telegram/quarantine/:id/retry", c => {
    hive.getAgent("human");
    const cfg = loadTelegramConfig(hive.home);
    hive.retryTelegramUpdate(c.req.param("id"), scope => {
      const project = hive.listProjects().find(project => project.id === scope.projectId);
      return Boolean(cfg && project && scope.botKey === telegramConfigKey(cfg) && cfg.groups[project.slug] === scope.chatId);
    });
    return c.json({ ok: true });
  });
  ui.post("/telegram/quarantine/:id/discard", c => {
    hive.getAgent("human");
    hive.discardTelegramUpdate(c.req.param("id"));
    return c.json({ ok: true });
  });
  ui.put("/telegram", async (c) => {
    hive.getAgent("human");
    const body = await c.req.json();
    const known = new Set(hive.listProjects().map((p) => p.slug));
    const projects: Record<string, { groupChatId: number }> = {};
    for (const [rawSlug, raw] of Object.entries(body.projects ?? {})) {
      const slug = parseProjectSlug(rawSlug);
      if (!known.has(slug)) throw new HiveError(404, `No project named ${slug}`);
      const value = raw && typeof raw === "object" ? (raw as { groupChatId?: unknown }).groupChatId : raw;
      const id = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
      if (!Number.isSafeInteger(id) || id === 0) throw new HiveError(400, `Invalid Telegram group id for ${slug}`);
      projects[slug] = { groupChatId: id };
    }
    const input: TelegramFileInput = {
      botToken: body.botToken,
      allowUserIds: Array.isArray(body.allowUserIds) ? body.allowUserIds : String(body.allowUserIds ?? "").split(/[,\s]+/).filter(Boolean),
      projects,
    };
    if (hooks.telegramRunning?.() && !hooks.configureTelegram) throw new HiveError(503, "Telegram configuration lifecycle unavailable");
    const running = hooks.configureTelegram
      ? await hooks.configureTelegram(input)
      : (writeTelegramFile(input, hive.home), false);

    return c.json({ ...publicTelegramView(hive.home, running), ...hive.telegramHealth() });
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
  ui.delete("/projects/:slug", async (c) => {
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
      await hooks.reloadTelegram?.();
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
    const readState = hive.readSnapshot(human);
    return c.json({ ...inbox, unread: readState.unread, readState });
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
    return c.json({
      channel: ch,
      threadId,
      messages: listed.messages,
      hasOlder: listed.hasOlder,
      hasNewer: listed.hasNewer,
      cursors: listed.cursors,
      threads: hive.threadsInChannel(ch.id),
      replyCounts: hive.replyCounts(ch.id),
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
  ui.post("/projects/:id/bots", async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES);
    return c.json(hive.createBot(hive.getAgent("human"), c.req.param("id"), body), 201);
  });
  ui.get('/projects/:id/bots/:botId/credential', c => {
    c.header('Cache-Control', 'no-store');
    return c.json(hive.botCredential(hive.getAgent('human'), c.req.param('id'), c.req.param('botId')));
  });
  ui.post('/projects/:id/bots/:botId/credential', async c => {
    c.header('Cache-Control', 'no-store');
    const body = await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES);
    return c.json(hive.changeBotCredential(hive.getAgent('human'), c.req.param('id'), c.req.param('botId'), body));
  });
  ui.post("/channels/:id/messages", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const message = hive.postMessage(human, {
      channel: c.req.param("id"),
      body: String(body.body ?? ""),
      threadId: body.threadId ?? null,
      eventType: body.eventType,
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : undefined,
    });
    return c.json({ message });
  });
  ui.post("/files", async (c) => {
    const human = hive.getAgent("human");
    const name = c.req.header("x-file-name") || "paste.png";
    const file = await hive.createFile(human, {
      name,
      mime: resolveUploadMime(c.req.header("x-file-mime"), name),
      body: c.req.raw.body, signal: c.req.raw.signal,
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
    if (body.messageSeqs !== undefined) {
      hive.markMessagesRead(human, String(body.channelId), body.messageSeqs, body.threadId ?? null);
    } else {
      // Compatibility: this is an explicit legacy read-through command, never
      // an implicit side effect of fetching a page or sending a message.
      const seq = Number(body.seq);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new HiveError(400, "Invalid read-through sequence");
      const channel = hive.getChannel(String(body.channelId));
      if (seq > hive.latestSeq(channel.id)) throw new HiveError(400, "Read-through sequence is beyond the channel history");
      hive.markRead(human, channel.id, seq);
    }
    return c.json({ ok: true, ...hive.readSnapshot(human) });
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
  agent.post("/files", async (c) => {
    const me = c.get("me");
    const name = c.req.header("x-file-name") || "file";
    const file = await hive.createFile(me, {
      name,
      mime: resolveUploadMime(c.req.header("x-file-mime"), name),
      body: c.req.raw.body, signal: c.req.raw.signal,
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
    if (body?.sessionId == null) throw new HiveError(409,
      "HTTP 409: Inbox delivery protocol changed. Restart the Hivemind MCP client and rejoin. HTTP/CLI clients must open an inbox session and include sessionId in wait. Do not retry this wait unchanged.");
    if (typeof body.sessionId !== "string") throw new HiveError(400, "Expected sessionId");
    const timeoutMs = Number(body.timeoutMs ?? DEFAULT_WAIT_MS);
    const result = await hive.wait(me, timeoutMs, c.req.raw.signal, {
      compact: Boolean(body.compact),
      sessionId: body.sessionId,
    });
    return c.json(result);
  });
  agent.post("/inbox/session", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.sessionId !== "string") throw new HiveError(400, "Expected sessionId");
    return c.json({ sessionId: hive.openInboxSession(c.get("me"), body.sessionId) });
  });
  agent.post("/inbox/ack", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.sessionId !== "string" || typeof body?.deliveryId !== "string") {
      throw new HiveError(400, "Expected sessionId and deliveryId");
    }
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
  const botBudget = new BotIngressBudget();
  const bot = new Hono<{ Variables: { me: Agent; token: string } }>();
  bot.use("*", async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    if (!match) throw new HiveError(401, "A Bearer bot token is required");
    const me = hive.agentByToken(match[1]!);
    if (me.role !== "bot") throw new HiveError(403, "A bot identity is required");
    const release = botBudget.acquire(me.id);
    if (!release) {
      c.header("Retry-After", "1");
      throw new HiveError(429, "Bot ingress is busy; retry with the same event ID");
    }
    c.set("me", me);
    c.set("token", match[1]!);
    try { await next(); } finally { release(); }
  });
  bot.post("/channels/:id/messages", async (c) => {
    const body = await readLimitedJson(c.req.raw, BOT_JSON_BYTES);
    // Parsing can yield while Human rotates/revokes. Authorize again at commit.
    const actor = hive.agentByToken(c.get("token"));
    const result = hive.postBotMessage(actor, c.req.param("id"), body);
    return c.json(result, result.duplicate ? 200 : 201);
  });
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
