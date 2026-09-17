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
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const knownProjects = hive.listProjects();
    const known = new Map(knownProjects.map((p) => [p.slug, p]));
    const projects: Record<string, { groupChatId: number }> = {};
    for (const [rawSlug, raw] of Object.entries(body.projects ?? {})) {
      const slug = parseProjectSlug(rawSlug);
      if (!known.has(slug)) throw new HiveError(404, `No project named ${slug}`);
      const id = raw && typeof raw === "object" ? Number((raw as { groupChatId?: unknown }).groupChatId) : Number(raw);
      if (!Number.isSafeInteger(id) || id === 0) throw new HiveError(400, `Invalid Telegram group id for ${slug}`);
      projects[slug] = { groupChatId: id };
    }

    const previous = readTelegramFile(hive.home);
    const next = writeTelegramFile(
      {
        botToken: body.botToken,
        allowUserIds: Array.isArray(body.allowUserIds)
          ? body.allowUserIds
          : String(body.allowUserIds ?? "").split(/[,\s]+/),
        projects,
      },
      hive.home,
    );

    const tokenChanged = Boolean(previous?.botToken && previous.botToken !== next.botToken);
    const changedProjects = knownProjects.filter(
      (project) => previous?.projects[project.slug] !== next.projects[project.slug],
    );
    const cancelledPending = tokenChanged
      ? hive.resetTelegramRouting()
      : changedProjects.length
        ? hive.resetTelegramRouting(changedProjects.map((project) => project.id))
        : 0;

    if (cancelledPending > 0) {
      const affected = tokenChanged ? knownProjects : changedProjects;
      for (const project of affected) {
        const general = hive.listChannels(human).find(
          (channel) => channel.projectId === project.id && channel.name === "general",
        );
        if (general) {
          hive.postSystem(
            general.id,
            `Telegram route changed; cancelled ${cancelledPending} queued mirror job(s). Hive messages were kept locally.`,
          );
        }
      }
    }

    const running = Boolean(hooks.reloadTelegram?.());
    return c.json({ ...publicTelegramView(hive.home, running), cancelledPending });
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
    const beforeSeq = c.req.query("beforeSeq") ? Number(c.req.query("beforeSeq")) : undefined;
    const listed = hive.listMessages(human, id, {
      threadId,
      beforeSeq,
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
  ui.post("/channels/:id/messages", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const message = hive.postMessage(human, {
      channel: c.req.param("id"),
      body: String(body.body ?? ""),
      threadId: body.threadId ?? null,
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
    if (me.role === "human") throw new HiveError(403, "Human uses the web UI, not the agent API");
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
    const listed = hive.listMessages(me, c.req.param("id"), {
      threadId: c.req.query("threadId") || null,
      afterSeq: c.req.query("afterSeq") ? Number(c.req.query("afterSeq")) : 0,
      beforeSeq: c.req.query("beforeSeq") ? Number(c.req.query("beforeSeq")) : undefined,
      limit,
    });
    const ch = hive.getChannel(c.req.param("id"), me.projectId);
    const meta = c.req.query("meta") === "1";
    return c.json({
      channel: { id: ch.id, name: ch.name, type: ch.type },
      messages: listed.messages,
      hasOlder: listed.hasOlder,
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
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : undefined,
    });
    return c.json({ ok: true, seq: message.seq, id: message.id });
  });
  agent.get("/messages/:seq", (c) => {
    const me = c.get("me");
    return c.json({ message: hive.getVisibleMessage(me, Number(c.req.param("seq"))) });
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
    const timeoutMs = Number(body.timeoutMs ?? DEFAULT_WAIT_MS);
    const result = await hive.wait(me, timeoutMs, c.req.raw.signal, { compact: Boolean(body.compact) });
    return c.json(result);
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
