import { Readable } from "node:stream";
import { Hono } from "hono";
import { requestJson, validateRequest } from "./api-input.ts";
import { threadResponseSchema, uploadLength } from "../shared/api-contract.ts";
import { cors } from "hono/cors";
import { DEFAULT_WAIT_MS, HiveError, type Agent } from "../shared/types.ts";
import { resolveUploadMime } from "../shared/mime.ts";
import { standingOrders } from "../shared/standing-orders.ts";
import { Hive, describeAgent } from "./hive.ts";
import { safeFileName } from "./files.ts";
import { telegramDestinationForSeq, loadTelegramConfig, telegramConfigKey, publicTelegramView, readTelegramFile, removeTelegramProjectSlug, writeTelegramFile, type TelegramFileInput } from "./telegram.ts";
import { parseProjectSlug } from "../shared/project.ts";
import { launchContext, projectPlugins, saveProjectPlugin, setProjectPluginAvailability, pluginErrorMessage } from "./plugins.ts";
import { BotIngressBudget, readLimitedJson, assertLocalHumanRequest, BOT_JSON_BYTES, PLUGIN_REQUEST_BYTES, CREDENTIAL_JSON_BYTES } from "./ingress.ts";
import { adaptiveRoutingPublic, saveAdaptiveRouting, shouldRouteHumanMessage } from "./adaptive-routing.ts";
import { installJevDiagnostics } from './adaptive-routing-diagnostics.ts';
import { assignAdaptiveTask, mutateAdaptiveTask, mutateAdaptiveRoom, sendAdaptiveAgentMessage, setAdaptiveThreadStatus } from './adaptive-topology-actions.ts';

export type AppHooks = {
  jevDiagnosticFetch?: typeof fetch;
  telegramRunning?: () => boolean;
  reloadTelegram?: () => boolean | Promise<boolean>;
  configureTelegram?: (input: TelegramFileInput) => Promise<boolean>;
};
function fileDownload(hive: Hive, actor: Agent, id: string) {
  const opened = hive.openAttachment(actor, id);
  return new Response(Readable.toWeb(opened.stream) as ReadableStream, {
    headers: { "content-type": opened.meta.mime, "content-length": String(opened.meta.bytes),
      "content-disposition": `inline; filename="${safeFileName(opened.meta.name)}"` },
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
  app.get("/api/health", c => c.json({ ok: true, name: "hivemind" }));
  const ui = new Hono();
  ui.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    assertLocalHumanRequest(c.req.raw);
    await validateRequest(c.req.raw);
    await next();
  });
  const jevDiagnostics = installJevDiagnostics(ui, hive, hooks.jevDiagnosticFetch);
  ui.get("/launch-context", c => {
    const slug = c.req.query("project");
    return c.json(launchContext(hive.home, c.req.url, slug ? hive.getProjectBySlug(slug) : undefined));
  });
  ui.get("/projects/:slug/plugins", c => c.json({ plugins: projectPlugins(hive.home, hive.getProjectBySlug(c.req.param("slug"))) }));
  ui.patch("/projects/:slug/plugins/:id", async c => {
    const project = hive.getProjectBySlug(c.req.param("slug"));
    try {
      return c.json({ plugin: await setProjectPluginAvailability(hive.home, project, c.req.param("id"), await readLimitedJson(c.req.raw, PLUGIN_REQUEST_BYTES)) });
    } catch (error) {
      if (error instanceof HiveError) throw error;
      throw new HiveError(400, pluginErrorMessage(error));
    }
  });
  ui.put("/projects/:slug/plugins/:id", async c => {
    const project = hive.getProjectBySlug(c.req.param("slug"));
    try {
      return c.json({ plugin: await saveProjectPlugin(hive.home, project, c.req.url, c.req.param("id"), await readLimitedJson(c.req.raw, PLUGIN_REQUEST_BYTES)) });
    } catch (error) {
      if (error instanceof HiveError) throw error;
      throw new HiveError(400, pluginErrorMessage(error));
    }
  });
  ui.get("/adaptive-routing", c => {
    hive.getAgent("human");
    return c.json(adaptiveRoutingPublic(hive.home));
  });
  ui.put("/adaptive-routing", async c => {
    hive.getAgent("human");
    const saved = saveAdaptiveRouting(hive.home, await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES));
    hive.adaptiveTopology.settingsChanged();
    jevDiagnostics.settingsChanged();
    return c.json(saved);
  });
  ui.get("/channels/:id/adaptive-routing", c => c.json(hive.adaptiveTopology.view(hive.getAgent("human"), c.req.param("id"))));
  ui.put("/channels/:id/adaptive-routing/lock", async c => c.json(hive.adaptiveTopology.setLock(hive.getAgent("human"), c.req.param("id"), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES))));
  ui.get("/projects/:project/agents/:id/credential", c => c.json(hive.agentCredential(hive.getAgent("human"), c.req.param("project"), c.req.param("id"))));
  ui.post("/projects/:project/agents/:id/credential", async c => c.json(hive.changeAgentCredential(hive.getAgent("human"), c.req.param("project"), c.req.param("id"), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES))));
  ui.get("/snapshot", c => {
    const human = hive.getAgent("human");
    return c.json({ you: human, projects: hive.listProjects(), agents: hive.listAgents(), channels: hive.listChannels(human),
      ...hive.readSnapshot(human), queued: hive.queuedCounts(), inbox: hive.inboxStatuses(),
      telegram: { running: Boolean(hooks.telegramRunning?.()), configured: publicTelegramView(hive.home).configured, ...hive.telegramHealth() } });
  });
  ui.get("/read-state", c => c.json(hive.readSnapshot(hive.getAgent("human"))));
  ui.get("/telegram", c => {
    hive.getAgent("human");
    return c.json({ ...publicTelegramView(hive.home, Boolean(hooks.telegramRunning?.())), ...hive.telegramHealth() });
  });
  ui.get("/telegram/failures", c => {
    hive.getAgent("human");
    return c.json({ failures: hive.telegramFailures(Number(c.req.query("limit") ?? 50)) });
  });
  ui.post("/telegram/failures/:id/retry", c => {
    hive.getAgent("human");
    hive.retryTelegramFailure(c.req.param("id"), seq => telegramDestinationForSeq(hive, seq));
    return c.json({ ok: true, failures: hive.telegramFailureCount() });
  });
  ui.post("/telegram/failures/:id/discard", c => {
    hive.getAgent("human"); hive.discardTelegramFailure(c.req.param("id"));
    return c.json({ ok: true, failures: hive.telegramFailureCount() });
  });
  ui.get('/telegram/quarantine', c => {
    hive.getAgent('human'); return c.json({ updates: hive.telegramQuarantine(Number(c.req.query('limit') ?? 50)) });
  });
  ui.post('/telegram/quarantine/:id/retry', c => {
    hive.getAgent('human');
    const cfg = loadTelegramConfig(hive.home);
    hive.retryTelegramUpdate(c.req.param('id'), scope => {
      const project = hive.listProjects().find(project => project.id === scope.projectId);
      return Boolean(cfg && project && scope.botKey === telegramConfigKey(cfg) && cfg.groups[project.slug] === scope.chatId);
    });
    return c.json({ ok: true });
  });
  ui.post('/telegram/quarantine/:id/discard', c => {
    hive.getAgent('human'); hive.discardTelegramUpdate(c.req.param('id')); return c.json({ ok: true });
  });
  ui.put("/telegram", async c => {
    hive.getAgent("human");
    const body = await requestJson(c.req.raw);
    const known = new Set(hive.listProjects().map(p => p.slug));
    const projects: Record<string, { groupChatId: number }> = {};
    for (const [rawSlug, raw] of Object.entries(body.projects ?? {})) {
      const slug = parseProjectSlug(rawSlug);
      if (!known.has(slug)) throw new HiveError(404, `No project named ${slug}`);
      const value = raw && typeof raw === 'object' ? (raw as { groupChatId?: unknown }).groupChatId : raw;
      const id = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isSafeInteger(id) || id === 0) throw new HiveError(400, `Invalid Telegram group id for ${slug}`);
      projects[slug] = { groupChatId: id };
    }
    const input: TelegramFileInput = { botToken: body.botToken,
      allowUserIds: Array.isArray(body.allowUserIds) ? body.allowUserIds : String(body.allowUserIds ?? '').split(/[,\s]+/).filter(Boolean), projects };
    if (hooks.telegramRunning?.() && !hooks.configureTelegram) throw new HiveError(503, 'Telegram configuration lifecycle unavailable');
    const running = hooks.configureTelegram ? await hooks.configureTelegram(input) : (writeTelegramFile(input, hive.home), false);
    return c.json({ ...publicTelegramView(hive.home, running), ...hive.telegramHealth() });
  });
  ui.post("/projects", async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ project: hive.createProject(hive.getAgent('human'), { name: String(body.name ?? ''), slug: body.slug, worktree: body.worktree ?? null }) });
  });
  ui.patch("/projects/:slug", async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ project: hive.updateProject(hive.getAgent('human'), c.req.param('slug'), { name: body.name, worktree: body.worktree }) });
  });
  ui.delete("/agents/:name", (c) => {
    const human = hive.getAgent("human");
    const agent = hive.removeAgent(human, decodeURIComponent(c.req.param("name")));
    return c.json({ ok: true, name: agent.name });
  });
  ui.delete("/projects/:slug", async c => {
    const human = hive.getAgent('human'), slug = parseProjectSlug(c.req.param('slug'));
    const chatId = readTelegramFile(hive.home)?.projects[slug];
    hive.deleteProject(human, slug, { telegramChatId: chatId });
    try { removeTelegramProjectSlug(slug, hive.home); } catch { /* Hive row already removed. */ }
    try { await hooks.reloadTelegram?.(); } catch { /* Next serve rereads configuration. */ }
    if (chatId != null) hive.forgetTelegramChat(chatId);
    return c.json({ ok: true });
  });
  ui.get("/mentions", c => {
    const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
    const project = c.req.query('project') ? hive.getProjectBySlug(String(c.req.query('project'))).id : undefined;
    return c.json(hive.mentionInbox(hive.getAgent('human'), 30, beforeSeq, project));
  });
  ui.post("/mentions/seen", async c => {
    const human = hive.getAgent('human'), body = await requestJson(c.req.raw);
    const project = body.project ? hive.getProjectBySlug(String(body.project)).id : undefined;
    hive.markMentionsSeen(human, project);
    const inbox = hive.mentionInbox(human, 30, undefined, project), readState = hive.readSnapshot(human);
    return c.json({ ...inbox, unread: readState.unread, readState });
  });
  ui.get("/search", c => c.json(hive.searchMessages(hive.getAgent('human'), {
    q: String(c.req.query('q') ?? ''), project: c.req.query('project'), channel: c.req.query('channel') || undefined,
    beforeSeq: c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
  })));
  ui.get("/channels/:id/messages", c => {
    const human = hive.getAgent('human'), id = c.req.param('id'), threadId = c.req.query('threadId') || null;
    const after = c.req.query('afterSeq'), before = c.req.query('beforeSeq');
    const listed = hive.listMessages(human, id, { threadId, afterSeq: after !== undefined ? Number(after) : undefined,
      beforeSeq: before !== undefined ? Number(before) : undefined, limit: Number(c.req.query('limit') ?? 80) });
    const ch = hive.getChannel(id);
    return c.json({ channel: ch, threadId, messages: listed.messages, hasOlder: listed.hasOlder, hasNewer: listed.hasNewer,
      cursors: listed.cursors, threads: hive.threadsInChannel(ch.id).map(thread => threadResponseSchema.parse(thread)),
      replyCounts: hive.replyCounts(ch.id), snapshotSeq: hive.latestSeq(ch.id),
      task: threadId && hive.tasks.has(threadId) ? hive.tasks.get(human, threadId) : undefined,
      decision: threadId && hive.decisions.has(threadId) ? hive.decisions.get(human, threadId) : undefined,
      decisions: threadId && hive.tasks.has(threadId) ? hive.decisions.forTask(human, threadId) : undefined });
  });
  ui.post("/channels", async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ channel: hive.createChannel(hive.getAgent('human'), { name: String(body.name ?? ''), type: body.type ?? 'public',
      topic: body.topic, memberNames: body.memberNames, project: body.project ?? null }) });
  });
  ui.get('/channels/:id/room', c => c.json(hive.rooms.view(hive.getAgent('human'), c.req.param('id'))));
  ui.get('/channels/:id/room/history', c => c.json({ history: hive.rooms.history(hive.getAgent('human'), c.req.param('id'), Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)) }));
  ui.post('/channels/:id/room', async c => c.json(hive.rooms.event(hive.getAgent('human'), c.req.param('id'), await requestJson(c.req.raw))));
  ui.post('/projects/:id/bots', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(hive.createBot(hive.getAgent('human'), c.req.param('id'), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES)), 201);
  });
  ui.get('/projects/:id/bots/:botId/credential', c => {
    c.header('Cache-Control', 'no-store');
    return c.json(hive.botCredential(hive.getAgent('human'), c.req.param('id'), c.req.param('botId')));
  });
  ui.post('/projects/:id/bots/:botId/credential', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(hive.changeBotCredential(hive.getAgent('human'), c.req.param('id'), c.req.param('botId'), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES)));
  });
  ui.post('/channels/:id/messages', async c => {
    const human = hive.getAgent('human'), body = await requestJson(c.req.raw), channel = hive.getChannel(c.req.param('id'));
    const originalBody = String(body.body ?? ''), threadId = body.threadId ?? null;
    const messageInput = { channel: channel.id, body: originalBody, requestId: body.requestId, threadId,
      eventType: body.eventType, traceId: body.traceId, causeMessageId: body.causeMessageId, recipients: body.recipients,
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : undefined };
    if (hive.hasActiveSendRequest(human, channel.id, body.requestId))
      return c.json({ message: hive.postMessage(human, messageInput), routing: null, adaptiveState: null });
    const brainIds = new Set(hive.listAgents(human).filter(agent => agent.role === 'brain' && agent.project === channel.project).map(agent => agent.id));
    const candidate = shouldRouteHumanMessage(channel, originalBody, threadId, brainIds);
    const mode = String(body.routing ?? 'auto'), scope = String(body.lockScope ?? 'none');
    if ((mode !== 'auto' || scope !== 'none') && !candidate) throw new HiveError(400, 'Explicit routing is only valid for a top-level Human-to-brain DM');
    if (!candidate) return c.json({ message: hive.postMessage(human, messageInput), routing: null, adaptiveState: null });
    const routed = await hive.adaptiveTopology.routeHumanRequest(human, messageInput, mode, scope);
    if (!routed) return c.json({ message: hive.postMessage(human, messageInput), routing: null, adaptiveState: null });
    return c.json({ message: routed.message, routing: routed.routing, routingMessage: routed.routingMessage, adaptiveState: routed.state });
  });
  ui.post('/files', async c => {
    const human = hive.getAgent('human'), name = c.req.header('x-file-name') || 'paste.png';
    const file = await hive.createFile(human, { name, mime: resolveUploadMime(c.req.header('x-file-mime'), name),
      body: c.req.raw.body, signal: c.req.raw.signal, declaredBytes: uploadLength(c.req.header('content-length') ?? null) });
    return c.json({ file });
  });
  ui.get('/files/:id', c => fileDownload(hive, hive.getAgent('human'), c.req.param('id')));
  ui.post('/messages/:seq/reactions', async c => {
    const body = await requestJson(c.req.raw);
    return c.json(hive.setReaction(hive.getAgent('human'), Number(c.req.param('seq')), String(body.emoji ?? ''), body.present));
  });
  ui.post('/dms', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ channel: hive.openDm(hive.getAgent('human'), String(body.name ?? '')) });
  });
  ui.post('/threads/:id/status', async c => {
    const body = await requestJson(c.req.raw);
    const thread = hive.setThreadStatus(hive.getAgent('human'), c.req.param('id'), body.status ?? null);
    return c.json({ thread: threadResponseSchema.parse(thread) });
  });
  ui.post('/clear-context', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ message: hive.clearContext(hive.getAgent('human'), String(body.name ?? '')) });
  });
  ui.post('/channels/:id/invite', async c => {
    const body = await requestJson(c.req.raw);
    const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? '')];
    return c.json({ channel: hive.invite(hive.getAgent('human'), c.req.param('id'), names.filter(Boolean)) });
  });
  ui.post('/read', async c => {
    const human = hive.getAgent('human'), body = await requestJson(c.req.raw);
    if (body.messageSeqs !== undefined) hive.markMessagesRead(human, String(body.channelId), body.messageSeqs, body.threadId ?? null);
    else {
      const seq = Number(body.seq);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new HiveError(400, 'Invalid read-through sequence');
      const channel = hive.getChannel(String(body.channelId));
      if (seq > hive.latestSeq(channel.id)) throw new HiveError(400, 'Read-through sequence is beyond the channel history');
      hive.markRead(human, channel.id, seq);
    }
    return c.json({ ok: true, ...hive.readSnapshot(human) });
  });
  ui.post('/tasks/:id/routing', async c => c.json(hive.routing.suggest(hive.getAgent('human'), c.req.param('id'), await requestJson(c.req.raw))));
  ui.post('/tasks/:id/routing-override', async c => c.json(hive.routing.override(hive.getAgent('human'), c.req.param('id'), await requestJson(c.req.raw))));
  ui.get('/tasks/:id/timeline', c => c.json({ timeline: hive.timeline.traceForTask(hive.getAgent('human'), c.req.param('id')) }));
  ui.get('/tasks/:id/timeline/export', c => c.json({ fixture: hive.timeline.exportTask(hive.getAgent('human'), c.req.param('id')) }));
  ui.get('/decisions', c => {
    const project = hive.getProjectBySlug(String(c.req.query('project') ?? ''));
    return c.json(hive.decisions.listHuman(hive.getAgent('human'), project.id, c.req.query('includeClosed') !== '0'));
  });
  ui.get('/decisions/:id', c => c.json({ decision: hive.decisions.get(hive.getAgent('human'), c.req.param('id')) }));
  ui.post('/decisions/:id/answer', async c => c.json(hive.decisions.answer(hive.getAgent('human'), c.req.param('id'), await requestJson(c.req.raw))));

  const agent = new Hono();
  agent.use('*', async (c, next) => {
    if (c.req.path === '/api/agent/join' && c.req.method === 'POST') { await validateRequest(c.req.raw); return next(); }
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new HiveError(401, 'Missing token. Join first.');
    let me = hive.agentByToken(token);
    if (me.role !== 'brain' && me.role !== 'worker') throw new HiveError(403, 'Only brains and workers use the agent API');
    if (me.role !== 'brain' && c.req.method === 'POST' && (c.req.path === '/api/agent/tasks' || c.req.path === '/api/agent/channels' ||
      c.req.path.endsWith('/invite') || c.req.path.endsWith('/clear-context'))) throw new HiveError(403, 'This mutation requires a brain');
    await validateRequest(c.req.raw);
    me = hive.agentByToken(token);
    hive.touch(me.id, true); c.set('me', me); c.set('token', token);
    await next();
  });
  agent.post('/join', async c => {
    const body = await requestJson(c.req.raw);
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const result = hive.join({ role: body.role, seniority: body.seniority ?? null, focus: body.focus ?? null,
      token: bearer || body.token || null, resumeName: body.resume || body.resumeName || null, project: body.project ?? null, cwd: body.cwd ?? null });
    return c.json({ ...result, describe: describeAgent(result.agent), standingOrders: result.created ? standingOrders(result.agent) : undefined,
      ordersRef: result.created ? undefined : 'unchanged', handoffs: hive.tasks.handoffs(result.agent) });
  });
  agent.get('/me', c => {
    const me = c.get('me'), adaptiveRouting = hive.adaptiveTopology.forAgent(me) ?? undefined;
    if (c.req.query('orders') === '1') return c.json({ you: me, standingOrders: standingOrders(me), adaptiveRouting });
    return c.json({ you: { name: me.name, role: me.role, seniority: me.seniority, focus: me.focus, online: me.online, project: me.project },
      ordersRef: 'unchanged', adaptiveRouting });
  });
  agent.get('/agents', c => c.json({ agents: hive.listAgents(c.get('me')).map(({ createdAt: _c, ...a }) => a) }));
  agent.get('/search', c => {
    const me = c.get('me');
    return c.json(hive.searchMessages(me, { q: String(c.req.query('q') ?? ''), project: c.req.query('project') || me.project,
      channel: c.req.query('channel') || undefined, beforeSeq: c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined }));
  });
  agent.get('/subscriptions', c => c.json({ subscriptions: hive.notifications.list(c.get('me')) }));
  agent.post('/subscriptions', async c => c.json({ subscriptions: hive.notifications.set(c.get('me'), await requestJson(c.req.raw)) }));
  agent.post('/subscriptions/reset', async c => c.json({ subscriptions: hive.notifications.reset(c.get('me'), await requestJson(c.req.raw)) }));
  agent.get('/channels', c => {
    const me = c.get('me');
    return c.json({ channels: hive.listChannels(me), unread: c.req.query('unread') === '1' ? hive.unreadCounts(me) : undefined });
  });
  agent.get('/channels/:id/messages', c => {
    const me = c.get('me'), after = c.req.query('afterSeq'), before = c.req.query('beforeSeq');
    const listed = hive.listMessages(me, c.req.param('id'), { threadId: c.req.query('threadId') || null,
      afterSeq: after !== undefined ? Number(after) : undefined, beforeSeq: before !== undefined ? Number(before) : undefined,
      limit: Number(c.req.query('limit') ?? 20) });
    const ch = hive.getChannel(c.req.param('id'), me.projectId), meta = c.req.query('meta') === '1';
    return c.json({ channel: { id: ch.id, name: ch.name, type: ch.type }, messages: listed.messages,
      hasOlder: listed.hasOlder, hasNewer: listed.hasNewer, cursors: listed.cursors,
      threads: meta ? hive.threadsInChannel(ch.id).map(thread => threadResponseSchema.parse(thread)) : undefined,
      replyCounts: meta ? hive.replyCounts(ch.id) : undefined });
  });
  agent.post('/channels', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ channel: hive.createChannel(c.get('me'), { name: String(body.name ?? ''), type: body.type ?? 'public', topic: body.topic, memberNames: body.memberNames }) });
  });
  agent.post('/channels/:id/messages', async c => c.json(await sendAdaptiveAgentMessage(
    hive, c.get('me'), c.req.param('id'), await requestJson(c.req.raw), c.get('token'))));
  agent.get('/messages/:seq', c => c.json({ message: hive.getVisibleMessage(c.get('me'), Number(c.req.param('seq'))) }));
  agent.post('/messages/expand', async c => c.json(hive.expandDigest(c.get('me'), await requestJson(c.req.raw))));
  agent.post('/tasks', async c => c.json(await assignAdaptiveTask(hive, c.get('me'), await requestJson(c.req.raw), c.get('token'))));
  agent.post('/decisions', async c => c.json(hive.decisions.create(c.get('me'), await requestJson(c.req.raw))));
  agent.get('/decisions/:id', c => c.json({ decision: hive.decisions.get(c.get('me'), c.req.param('id')) }));
  agent.get('/tasks/:id/decisions', c => c.json({ decisions: hive.decisions.forTask(c.get('me'), c.req.param('id')) }));
  agent.post('/decisions/:id/events', async c => c.json(hive.decisions.event(c.get('me'), c.req.param('id'), await requestJson(c.req.raw))));
  agent.get('/channels/:id/room', c => c.json(hive.rooms.view(c.get('me'), c.req.param('id'), c.req.query('beforeTask'))));
  agent.get('/channels/:id/room/history', c => c.json({ history: hive.rooms.history(c.get('me'), c.req.param('id'), Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)) }));
  agent.post('/channels/:id/room', async c => c.json(await mutateAdaptiveRoom(hive, c.get('me'), c.req.param('id'), await requestJson(c.req.raw), c.get('token'))));
  agent.get('/workers/:id/capabilities', c => c.json({ capability: hive.routing.get(c.get('me'), c.req.param('id')) }));
  agent.post('/capabilities', async c => c.json({ capability: hive.routing.set(c.get('me'), await requestJson(c.req.raw)) }));
  agent.post('/tasks/:id/routing', async c => c.json(hive.routing.suggest(c.get('me'), c.req.param('id'), await requestJson(c.req.raw))));
  agent.post('/tasks/:id/routing-outcome', async c => c.json(hive.routing.recordOutcome(c.get('me'), c.req.param('id'), await requestJson(c.req.raw))));
  agent.post('/tasks/:id/routing-override', async c => c.json(hive.routing.override(c.get('me'), c.req.param('id'), await requestJson(c.req.raw))));
  agent.get('/handoffs', c => c.json(hive.tasks.handoffs(c.get('me'), c.req.query('beforeTask'))));
  agent.post('/tasks/:id/claim-preview', async c => c.json(hive.tasks.previewClaim(c.get('me'), c.req.param('id'), await requestJson(c.req.raw))));
  agent.get('/tasks/:id/handoff', c => c.json(hive.tasks.handoff(c.get('me'), c.req.param('id'))));
  agent.get('/tasks/:id/timeline', c => c.json({ timeline: hive.timeline.traceForTask(c.get('me'), c.req.param('id')) }));
  agent.get('/tasks/:id/timeline/export', c => c.json({ fixture: hive.timeline.exportTask(c.get('me'), c.req.param('id')) }));
  agent.get('/tasks/:id', c => c.json({ task: hive.tasks.get(c.get('me'), c.req.param('id')) }));
  agent.post('/tasks/:id/events', async c => c.json(await mutateAdaptiveTask(hive, c.get('me'), c.req.param('id'), await requestJson(c.req.raw), c.get('token'))));
  agent.post('/files', async c => {
    const name = c.req.header('x-file-name') || 'file';
    const file = await hive.createFile(c.get('me'), { authorize: () => hive.agentByToken(c.get('token')), name,
      mime: resolveUploadMime(c.req.header('x-file-mime'), name), body: c.req.raw.body, signal: c.req.raw.signal,
      declaredBytes: uploadLength(c.req.header('content-length') ?? null) });
    return c.json({ file });
  });
  agent.get('/files/:id', c => fileDownload(hive, c.get('me'), c.req.param('id')));
  agent.post('/messages/:seq/reactions', async c => {
    const body = await requestJson(c.req.raw);
    const result = hive.setReaction(c.get('me'), Number(c.req.param('seq')), String(body.emoji ?? ''), body.present);
    return c.json({ ok: true, added: result.added, seq: result.message.seq });
  });
  agent.post('/dms', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ channel: hive.openDm(c.get('me'), String(body.name ?? body.to ?? '')) });
  });
  agent.post('/threads/:id/status', async c => {
    const body = await requestJson(c.req.raw);
    const thread = await setAdaptiveThreadStatus(hive, c.get('me'), c.req.param('id'), body.status ?? null, c.get('token'));
    return c.json({ thread: threadResponseSchema.parse(thread) });
  });
  agent.post('/channels/:id/invite', async c => {
    const body = await requestJson(c.req.raw);
    const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? body.member ?? '')];
    return c.json({ channel: hive.invite(c.get('me'), c.req.param('id'), names.filter(Boolean)) });
  });
  agent.post('/clear-context', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ message: hive.clearContext(c.get('me'), String(body.name ?? body.agent ?? '')) });
  });
  agent.post('/wait', async c => {
    const me = c.get('me'), body = await requestJson(c.req.raw);
    if (body?.sessionId == null) throw new HiveError(409, 'HTTP 409: Inbox delivery protocol changed. Restart the Hivemind MCP client and rejoin. HTTP/CLI clients must open an inbox session and include sessionId in wait. Do not retry this wait unchanged.');
    if (typeof body.sessionId !== 'string') throw new HiveError(400, 'Expected sessionId');
    const result = await hive.wait(me, Number(body.timeoutMs ?? DEFAULT_WAIT_MS), c.req.raw.signal, { compact: Boolean(body.compact), sessionId: body.sessionId });
    return c.json({ ...result, adaptiveRouting: hive.adaptiveTopology.forAgent(me) ?? undefined });
  });
  agent.post('/inbox/session', async c => {
    const body = await requestJson(c.req.raw);
    if (typeof body?.sessionId !== 'string') throw new HiveError(400, 'Expected sessionId');
    return c.json({ sessionId: hive.openInboxSession(c.get('me'), body.sessionId) });
  });
  agent.post('/inbox/ack', async c => {
    const body = await requestJson(c.req.raw);
    if (typeof body?.sessionId !== 'string' || typeof body?.deliveryId !== 'string') throw new HiveError(400, 'Expected sessionId and deliveryId');
    return c.json(hive.acknowledgeInbox(c.get('me'), body.sessionId, body.deliveryId));
  });
  agent.post('/ping', c => c.json({ ok: true, name: c.get('me').name, online: true }));
  agent.post('/leave', c => { hive.setOffline(c.get('me').id); return c.json({ ok: true }); });

  const botBudget = new BotIngressBudget();
  const bot = new Hono<{ Variables: { me: Agent; token: string } }>();
  bot.use('*', async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!match) throw new HiveError(401, 'A Bearer bot token is required');
    const me = hive.agentByToken(match[1]!);
    if (me.role !== 'bot') throw new HiveError(403, 'A bot identity is required');
    const release = botBudget.acquire(me.id);
    if (!release) { c.header('Retry-After', '1'); throw new HiveError(429, 'Bot ingress is busy; retry with the same event ID'); }
    c.set('me', me); c.set('token', match[1]!);
    try { await next(); } finally { release(); }
  });
  bot.post('/channels/:id/messages', async c => {
    const body = await readLimitedJson(c.req.raw, BOT_JSON_BYTES);
    const actor = hive.agentByToken(c.get('token'));
    const result = hive.postBotMessage(actor, c.req.param('id'), body);
    return c.json(result, result.duplicate ? 200 : 201);
  });
  bot.get('/channels/:id/links', c => c.json({ links: hive.rooms.botLinks(c.get('me'), c.req.param('id')) }));
  bot.post('/channels/:id/links', async c => c.json({ link: hive.rooms.registerLink(c.get('me'), c.req.param('id'), await requestJson(c.req.raw)) }));
  bot.post('/channels/:id/links/:link/status', async c => c.json({ link: hive.rooms.reportLink(c.get('me'), c.req.param('id'), c.req.param('link'), await requestJson(c.req.raw)) }));
  bot.post('/files', async c => {
    const name = c.req.header('x-file-name') || 'file';
    const file = await hive.createFile(c.get('me'), { authorize: () => hive.agentByToken(c.get('token')), name,
      mime: resolveUploadMime(c.req.header('x-file-mime'), name), body: c.req.raw.body, signal: c.req.raw.signal,
      declaredBytes: uploadLength(c.req.header('content-length') ?? null) });
    return c.json({ file }, 201);
  });
  app.route('/api/bot', bot); app.route('/api/ui', ui); app.route('/api/agent', agent);
  return app;
}
declare module 'hono' {
  interface ContextVariableMap { me: import('../shared/types.ts').Agent; token: string; }
}
