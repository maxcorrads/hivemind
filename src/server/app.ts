import { Readable } from "node:stream";
import { z } from 'zod';
import { botAccessSchema } from '../shared/bot-capabilities.ts';
import { createBotSchema } from '../shared/bot-message.ts';
import { Hono } from "hono";
import { requestJson, validateRequest } from "./api-input.ts";
import { threadResponseSchema, uploadLength } from "../shared/api-contract.ts";
import { DEFAULT_WAIT_MS, HiveError, type Agent } from "../shared/types.ts";
import { resolveUploadMime } from "../shared/mime.ts";
import { standingOrders } from "../shared/standing-orders.ts";
import { Hive, describeAgent } from "./hive.ts";
import { safeFileName } from "./files.ts";
import { telegramDestinationForSeq, loadTelegramConfig, telegramConfigKey, publicTelegramView, readTelegramFile, removeTelegramProjectSlug, writeTelegramFile, type TelegramFileInput } from "./telegram.ts";
import { parseProjectSlug } from "../shared/project.ts";
import { launchContext, projectBotConfigurations, saveProjectBotConfiguration, setProjectBotAvailability, botErrorMessage, callProjectBot, connectProjectBot } from "./bot-definitions.ts";
import { BotIngressBudget, readLimitedJson, assertLocalHumanRequest, BOT_JSON_BYTES, BOT_CONFIGURATION_REQUEST_BYTES, CREDENTIAL_JSON_BYTES } from "./ingress.ts";
import { adaptiveRoutingPublic, saveAdaptiveRouting } from "./adaptive-config.ts";
import { decodeJevCallCursor } from "../shared/jev-calls.ts";
import { ACTIVITY_REASONS, type ActivityReason } from "../shared/read-state.ts";
import { installJevDiagnostics } from './adaptive-routing-diagnostics.ts';
import { installInstanceProof } from "./instance-proof.ts";
import { adviseAfterWait, assignAdaptiveTask, mutateAdaptiveTask, mutateAdaptiveRoom, sendAdaptiveAgentMessage, setAdaptiveThreadStatus } from './adaptive-topology-actions.ts';

export type AppHooks = {
  jevDiagnosticFetch?: typeof fetch;
  telegramRunning?: () => boolean;
  reloadTelegram?: () => boolean | Promise<boolean>;
  configureTelegram?: (input: TelegramFileInput) => Promise<boolean>;
  /** Hivemind Server.app's per-start secret (instance-proof.ts); null or absent answers the challenge with 404. */
  instanceSecret?: Buffer | null;
};
function fileDownload(hive: Hive, actor: Agent, id: string) {
  const opened = hive.files.openAttachment(actor, id);
  return new Response(Readable.toWeb(opened.stream) as ReadableStream, {
    headers: { "content-type": opened.meta.mime, "content-length": String(opened.meta.bytes),
      "content-disposition": `inline; filename="${safeFileName(opened.meta.name)}"` },
  });
}
/** Thread roots a message page shows: its messages and the open thread; aggregates are scoped to them. */
function windowRoots(messages: readonly { id: string }[], threadId: string | null): string[] {
  return threadId ? [threadId, ...messages.map(message => message.id)] : messages.map(message => message.id);
}

export function createApp(hive: Hive, hooks: AppHooks = {}) {
  const parseBotInput = <T>(schema: z.ZodType<T>, input: unknown): T => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new HiveError(400, 'Invalid bot request');
    return parsed.data;
  };
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HiveError) {
      if (err.status === 429) c.header("Retry-After", "1");
      return c.json({ error: err.message }, err.status as 400);
    }
    console.error("Unexpected Hivemind request failure");
    return c.json({ error: "Internal server error" }, 500);
  });
  app.get("/api/health", c => c.json({ ok: true, name: "hivemind" }));
  installInstanceProof(app, hooks.instanceSecret ?? null);
  /** The channel and root of a thread id (a message or task id); null when the id is unknown. */
  const threadOwner = (id: string): { channelId: string; threadId: string } | null => {
    const ref = hive.messageQueries.messageRef(id);
    if (ref) return { channelId: ref.channelId, threadId: ref.threadId ?? ref.id };
    const human = hive.identity.getAgent('human');
    if (hive.tasks.has(id)) return { channelId: hive.tasks.get(human, id).channelId, threadId: id };
    return null;
  };
  const ui = new Hono();
  ui.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    assertLocalHumanRequest(c.req.raw);
    await validateRequest(c.req.raw);
    await next();
  });
  const jevDiagnostics = installJevDiagnostics(ui, hive, hooks.jevDiagnosticFetch);
  // Register the static catalog before identity routes: a definition may be named "access".
  ui.get("/projects/:slug/bots/catalog", c => c.json({ configurations: projectBotConfigurations(hive.home, hive.projects.getProjectBySlug(c.req.param("slug"))) }));
  ui.patch("/projects/:slug/bots/catalog/:id", async c => {
    const project = hive.projects.getProjectBySlug(c.req.param("slug"));
    try {
      return c.json({ configuration: await setProjectBotAvailability(hive.home, project, c.req.param("id"), await readLimitedJson(c.req.raw, BOT_CONFIGURATION_REQUEST_BYTES)) });
    } catch (error) {
      if (error instanceof HiveError) throw error;
      throw new HiveError(400, botErrorMessage(error));
    }
  });
  ui.put("/projects/:slug/bots/catalog/:id", async c => {
    const project = hive.projects.getProjectBySlug(c.req.param("slug"));
    try {
      return c.json({ configuration: await saveProjectBotConfiguration(hive.home, project, c.req.url, c.req.param("id"), await readLimitedJson(c.req.raw, BOT_CONFIGURATION_REQUEST_BYTES)) });
    } catch (error) {
      if (error instanceof HiveError) throw error;
      throw new HiveError(400, botErrorMessage(error));
    }
  });
  const botDefinition = (projectId: string, id: string) => {
    const project = hive.projects.getProject(projectId);
    const definition = projectBotConfigurations(hive.home, project).find(p => p.id === id);
    if (!definition || definition.error) throw new HiveError(409, 'Bot definition is unavailable; check its configuration');
    return { project, definition };
  };
  ui.get('/projects/:id/bots/:botId/access', c => c.json(hive.bots.botAccess(hive.identity.getAgent('human'), c.req.param('id'), c.req.param('botId'))));
  ui.get('/projects/:id/bots', c => {
    const human = hive.identity.getAgent('human'), project = hive.projects.requireActorProject(human, c.req.param('id'));
    // Catalog/profile metadata must not make identity and credential recovery
    // unavailable. Mutations that need a definition still validate it separately.
    let catalog: { definitions: ReturnType<typeof projectBotConfigurations>; catalogError?: string };
    try { catalog = { definitions: projectBotConfigurations(hive.home, project) }; }
    catch { catalog = { definitions: [], catalogError: 'Bot catalog unavailable. Existing identities, access and credentials remain manageable. Repair the local catalog/configuration files and refresh. Running processes are unchanged.' }; }
    return c.json({ bots: hive.identity.listAgents(human).filter(bot => bot.role === 'bot' && bot.projectId === project.id)
      .map(bot => ({ bot, access: hive.bots.access(bot), credential: hive.bots.botCredential(human, project.id, bot.id).credential })),
      ...catalog, channels: hive.channels.listChannels(human).filter(channel => channel.projectId === project.id) });
  });
  ui.put('/projects/:id/bots/:botId/access', async c => {
    const input = parseBotInput(botAccessSchema, await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES));
    const current = hive.bots.botAccess(hive.identity.getAgent('human'), c.req.param('id'), c.req.param('botId'));
    // Revoking access must not depend on a healthy executable or readable profile.
    // New capabilities, subscriptions or bindings still validate the current definition.
    const reduction = input.definitionId === current.definitionId && input.capabilities.every(cap => current.capabilities.includes(cap)) &&
      input.receiveChannels.every(channel => current.receiveChannels.includes(channel));
    if (input.definitionId && !reduction) {
      const { definition } = botDefinition(c.req.param('id'), input.definitionId);
      if (!Array.isArray(input.capabilities) || input.capabilities.some((cap: unknown) => !definition.capabilities?.includes(cap as never)))
        throw new HiveError(400, 'Selected capabilities are not supported by this bot definition');
    }
    return c.json(hive.bots.setAccess(hive.identity.getAgent('human'), c.req.param('id'), c.req.param('botId'), input));
  });
  ui.post('/projects/:id/bots/:botId/control', async c => {
    const human = hive.identity.getAgent('human');
    const { bot } = hive.bots.botCredential(human, c.req.param('id'), c.req.param('botId'));
    const access = hive.bots.access(bot), body = parseBotInput(z.object({ action: z.enum(['status', 'start', 'stop']),
      expectedAccessRevision: z.number().int().positive().safe() }).strict(), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES));
    if (access.revision !== body.expectedAccessRevision) throw new HiveError(409, 'Bot access changed; refresh before this operation');
    if (!access.definitionId) throw new HiveError(409, 'Connect a bot definition first');
    if (!['status', 'start', 'stop'].includes(body?.action)) throw new HiveError(400, 'Choose status, start or stop');
    try {
      const { project } = botDefinition(bot.projectId!, access.definitionId);
      return c.json({ result: await callProjectBot(hive.home, project, c.req.url, access.definitionId, bot, { tool: body.action, arguments: {} }, true, () => {
        const current = hive.bots.botCredential(human, project.id, bot.id);
        if (hive.bots.access(current.bot).revision !== access.revision) throw new HiveError(409, 'Bot access changed; refresh before this operation');
        if (body.action === 'start' && current.credential.revoked) throw new HiveError(403, 'Reconnect active credentials before starting');
      }) });
    } catch (error) { if (error instanceof HiveError) throw error; throw new HiveError(400, botErrorMessage(error)); }
  });
  ui.post('/projects/:id/bots/setup', async c => {
    const human = hive.identity.getAgent('human'), body = parseBotInput(createBotSchema.extend({ definitionId: z.string().min(1).max(64) }), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES));
    const project = hive.projects.requireActorProject(human, c.req.param('id'));
    if (typeof body?.definitionId !== 'string') throw new HiveError(400, 'Choose a bot definition');
    const { definition } = botDefinition(project.id, body.definitionId);
    if (!definition.configured || !definition.enabled) throw new HiveError(409, 'Configure and enable this bot definition first');
    if (hive.identity.listAgents(human).some(bot => bot.role === 'bot' && bot.projectId === project.id && hive.bots.access(bot).definitionId === definition.id))
      throw new HiveError(409, 'A bot already uses this definition in the project');
    const created = hive.bots.createBot(human, project.id, { name: body.name });
    hive.bots.setAccess(human, project.id, created.bot.id, { capabilities: definition.capabilities!.filter(cap => cap !== 'receive'),
      definitionId: definition.id, receiveChannels: [], expectedRevision: 1 });
    try {
      await connectProjectBot(hive.home, project, c.req.url, definition.id, created.bot, created.token, () => {
        const bot = hive.identity.agentByToken(created.token);
        if (hive.bots.access(bot).definitionId !== definition.id) throw new HiveError(409, 'Bot connection changed before setup');
      });
      return c.json({ bot: created.bot, connected: true }, 201);
    } catch {
      // Preserve the created identity on ambiguous outcomes. A new request must not duplicate it.
      return c.json({ bot: created.bot, connected: false, error: 'Identity created; definition connection needs attention. Open its settings and reconnect instead of creating another bot.' }, 201);
    }
  });
  ui.post('/projects/:id/bots/:botId/connect', async c => {
    const human = hive.identity.getAgent('human'), input = parseBotInput(z.object({ expectedRevision: z.number().int().positive().safe(),
      expectedAccessRevision: z.number().int().positive().safe() }).strict(), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES));
    const current = hive.bots.botCredential(human, c.req.param('id'), c.req.param('botId'));
    const access = hive.bots.access(current.bot);
    if (access.revision !== input.expectedAccessRevision) throw new HiveError(409, 'Bot access changed; refresh before reconnecting');
    if (!access.definitionId) throw new HiveError(409, 'Select and save a definition first');
    const { project, definition } = botDefinition(current.bot.projectId!, access.definitionId);
    if (!definition.configured) throw new HiveError(409, 'Configure the definition first');
    const rotated = hive.bots.changeBotCredential(human, project.id, current.bot.id, { action: 'rotate', expectedRevision: input?.expectedRevision });
    try { return c.json(await connectProjectBot(hive.home, project, c.req.url, access.definitionId, current.bot, rotated.token!, () => {
      const bot = hive.identity.agentByToken(rotated.token!);
      if (hive.bots.access(bot).revision !== access.revision) throw new HiveError(409, 'Bot access changed before connection');
    })); }
    catch { throw new HiveError(502, 'Credential replaced; connection outcome is unknown. Check definition status before reconnecting.'); }
  });
  ui.get("/launch-context", c => {
    const slug = c.req.query("project");
    return c.json(launchContext(hive.home, c.req.url, slug ? hive.projects.getProjectBySlug(slug) : undefined));
  });
  ui.get("/adaptive-routing", c => {
    hive.identity.getAgent("human");
    return c.json(adaptiveRoutingPublic(hive.home));
  });
  ui.put("/adaptive-routing", async c => {
    hive.identity.getAgent("human");
    const saved = saveAdaptiveRouting(hive.home, await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES));
    jevDiagnostics.settingsChanged();
    return c.json(saved);
  });
  // Human-only history of every Jev exchange, grouped by the request that caused it.
  const projectRef = (ref: string) => { try { return hive.projects.getProjectBySlug(ref); } catch { return hive.projects.getProject(ref); } };
  ui.get('/projects/:id/jev-calls', c => {
    const cursor = decodeJevCallCursor(c.req.query('cursor') ?? c.req.query('before'));
    return c.json(hive.adaptiveTopology.observations.jevCalls.view(projectRef(c.req.param('id')).id, cursor));
  });
  ui.get('/adaptive-routing/evidence-health', c => {
    hive.identity.getAgent('human');
    return c.json(hive.adaptiveTopology.observations.collectorHealth());
  });
  ui.get('/projects/:id/jev-calls/:callId', c => c.json({ call: hive.adaptiveTopology.observations.jevCalls.get(projectRef(c.req.param('id')).id, c.req.param('callId')) }));
  ui.get("/channels/:id/adaptive-routing", c => c.json(hive.adaptiveTopology.view(hive.identity.getAgent("human"), c.req.param("id"))));
  ui.get("/snapshot", c => {
    const human = hive.identity.getAgent("human");
    const channels = hive.channels.listChannels(human);
    return c.json({ you: human, projects: hive.projects.listProjects(), agents: hive.identity.listAgents(), channels,
      archivedChannelIds: hive.rooms.archivedChannelIds(channels),
      ...hive.reads.readSnapshot(human), ...hive.delivery.queueSnapshot(),
      telegram: { running: Boolean(hooks.telegramRunning?.()), configured: publicTelegramView(hive.home).configured, ...hive.telegramAdmin.health() },
      jev: { enabled: adaptiveRoutingPublic(hive.home).enabled } });
  });
  // Roster status lines, refreshed on task events.
  ui.get("/nav-status", c => c.json({ agentWork: hive.tasks.workStatus() }));
  ui.get("/read-state", c => c.json(hive.reads.readSnapshot(hive.identity.getAgent("human"))));
  ui.get("/telegram", c => {
    hive.identity.getAgent("human");
    return c.json({ ...publicTelegramView(hive.home, Boolean(hooks.telegramRunning?.())), ...hive.telegramAdmin.health() });
  });
  ui.get("/telegram/failures", c => {
    hive.identity.getAgent("human");
    return c.json({ failures: hive.telegramAdmin.failures(Number(c.req.query("limit") ?? 50)) });
  });
  ui.post("/telegram/failures/:id/retry", c => {
    hive.identity.getAgent("human");
    hive.telegramAdmin.retryFailure(c.req.param("id"), seq => telegramDestinationForSeq(hive, seq));
    return c.json({ ok: true, failures: hive.telegramAdmin.failureCount() });
  });
  ui.post("/telegram/failures/:id/discard", c => {
    hive.identity.getAgent("human"); hive.telegramAdmin.discardFailure(c.req.param("id"));
    return c.json({ ok: true, failures: hive.telegramAdmin.failureCount() });
  });
  ui.get('/telegram/quarantine', c => {
    hive.identity.getAgent('human'); return c.json({ updates: hive.telegramAdmin.quarantine(Number(c.req.query('limit') ?? 50)) });
  });
  ui.post('/telegram/quarantine/:id/retry', c => {
    hive.identity.getAgent('human');
    const cfg = loadTelegramConfig(hive.home);
    hive.telegramAdmin.retryUpdate(c.req.param('id'), scope => {
      const project = hive.projects.listProjects().find(project => project.id === scope.projectId);
      return Boolean(cfg && project && scope.botKey === telegramConfigKey(cfg) && cfg.groups[project.slug] === scope.chatId);
    });
    return c.json({ ok: true });
  });
  ui.post('/telegram/quarantine/:id/discard', c => {
    hive.identity.getAgent('human'); hive.telegramAdmin.discardUpdate(c.req.param('id')); return c.json({ ok: true });
  });
  ui.put("/telegram", async c => {
    hive.identity.getAgent("human");
    const body = await requestJson(c.req.raw);
    const known = new Set(hive.projects.listProjects().map(p => p.slug));
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
    return c.json({ ...publicTelegramView(hive.home, running), ...hive.telegramAdmin.health() });
  });
  ui.post("/projects", async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ project: hive.projects.createProject(hive.identity.getAgent('human'), { name: String(body.name ?? ''), slug: body.slug, worktree: body.worktree ?? null }) });
  });
  ui.patch("/projects/:slug", async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ project: hive.projects.updateProject(hive.identity.getAgent('human'), c.req.param('slug'), { name: body.name, worktree: body.worktree }) });
  });
  ui.delete("/agents/:name", (c) => {
    const human = hive.identity.getAgent("human");
    const agent = hive.identity.removeAgent(human, decodeURIComponent(c.req.param("name")));
    return c.json({ ok: true, name: agent.name });
  });
  ui.delete("/projects/:slug", async c => {
    const human = hive.identity.getAgent('human'), slug = parseProjectSlug(c.req.param('slug'));
    const chatId = readTelegramFile(hive.home)?.projects[slug];
    hive.projects.deleteProject(human, slug, { telegramChatId: chatId });
    try { removeTelegramProjectSlug(slug, hive.home); } catch { /* Hive row already removed. */ }
    try { await hooks.reloadTelegram?.(); } catch { /* Next serve rereads configuration. */ }
    if (chatId != null) hive.telegramAdmin.forgetChat(chatId);
    return c.json({ ok: true });
  });
  ui.get("/mentions", c => {
    const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
    const project = c.req.query('project') ? hive.projects.getProjectBySlug(String(c.req.query('project'))).id : undefined;
    return c.json(hive.reads.mentionInbox(hive.identity.getAgent('human'), 30, beforeSeq, project));
  });
  ui.get("/activity", c => {
    const project = c.req.query('project') ? hive.projects.getProjectBySlug(String(c.req.query('project'))).id : undefined;
    const reasons = (c.req.query('reason') ?? '').split(',').filter(Boolean);
    if (reasons.length > ACTIVITY_REASONS.length || reasons.some(reason => !(ACTIVITY_REASONS as readonly string[]).includes(reason)))
      throw new HiveError(400, 'Unknown activity reason');
    return c.json(hive.reads.activity(hive.identity.getAgent('human'), {
      projectId: project, unreadOnly: c.req.query('unread') === '1', reasons: reasons as ActivityReason[],
      beforeSeq: c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    }));
  });
  ui.post("/mentions/seen", async c => {
    const human = hive.identity.getAgent('human'), body = await requestJson(c.req.raw);
    const project = body.project ? hive.projects.getProjectBySlug(String(body.project)).id : undefined;
    hive.reads.markMentionsSeen(human, project);
    const inbox = hive.reads.mentionInbox(human, 30, undefined, project), readState = hive.reads.readSnapshot(human);
    return c.json({ ...inbox, unread: readState.unread, readState });
  });
  ui.get("/search", c => c.json(hive.messageQueries.searchMessages(hive.identity.getAgent('human'), {
    q: String(c.req.query('q') ?? ''), project: c.req.query('project'), channel: c.req.query('channel') || undefined,
    beforeSeq: c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
  })));
  ui.get("/channels/:id/last-unread", c => c.json({
    target: hive.reads.latestUnread(hive.identity.getAgent('human'), c.req.param('id')),
  }));
  ui.get("/channels/:id/messages", c => {
    const human = hive.identity.getAgent('human'), id = c.req.param('id'), threadId = c.req.query('threadId') || null;
    const after = c.req.query('afterSeq'), before = c.req.query('beforeSeq');
    const ch = hive.channels.getChannel(id);
    // A thread opened under the wrong channel (a stale or hand-edited link) must not show another channel's task:
    // name the owning channel so the UI can redirect there.
    const owner = threadId ? threadOwner(threadId) : null;
    if (owner && owner.channelId !== ch.id) {
      return hive.channels.canSeeChannel(human, hive.channels.getChannel(owner.channelId))
        ? c.json({ error: 'This thread belongs to another channel', channelId: owner.channelId, threadId: owner.threadId }, 409)
        : c.json({ error: 'Thread not found in this channel' }, 404);
    }
    const listed = hive.messageQueries.listMessages(human, id, { threadId, afterSeq: after !== undefined ? Number(after) : undefined,
      beforeSeq: before !== undefined ? Number(before) : undefined, limit: Number(c.req.query('limit') ?? 80) });
    const roots = windowRoots(listed.messages, threadId);
    return c.json({ channel: ch, threadId, messages: listed.messages, hasOlder: listed.hasOlder, hasNewer: listed.hasNewer,
      cursors: listed.cursors, threads: hive.messageQueries.threadsInChannel(ch.id, roots).map(thread => threadResponseSchema.parse(thread)),
      replyCounts: hive.messageQueries.replyCounts(ch.id, roots), snapshotSeq: hive.messageQueries.latestSeq(ch.id),
      firstUnreadSeq: threadId ? undefined : hive.reads.firstUnreadSeq(human, ch.id),
      task: threadId && hive.tasks.has(threadId) ? hive.tasks.view(human, threadId) : undefined });
  });
  ui.get('/channels/:id/tasks', c => c.json(hive.tasks.listForChannel(hive.identity.getAgent('human'), c.req.param('id'))));
  ui.post("/channels", async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ channel: hive.channels.createChannel(hive.identity.getAgent('human'), { name: String(body.name ?? ''), type: body.type ?? 'public',
      topic: body.topic, memberNames: body.memberNames, project: body.project ?? null }) });
  });
  ui.get('/channels/:id/room', c => c.json(hive.rooms.view(hive.identity.getAgent('human'), c.req.param('id'))));
  ui.get('/channels/:id/room/history', c => c.json({ history: hive.rooms.history(hive.identity.getAgent('human'), c.req.param('id'), Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)) }));
  ui.post('/channels/:id/room', async c => c.json(hive.rooms.event(hive.identity.getAgent('human'), c.req.param('id'), await requestJson(c.req.raw))));
  ui.post('/projects/:id/bots', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(hive.bots.createBot(hive.identity.getAgent('human'), c.req.param('id'), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES)), 201);
  });
  ui.get('/projects/:id/bots/:botId/credential', c => {
    c.header('Cache-Control', 'no-store');
    return c.json(hive.bots.botCredential(hive.identity.getAgent('human'), c.req.param('id'), c.req.param('botId')));
  });
  ui.post('/projects/:id/bots/:botId/credential', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(hive.bots.changeBotCredential(hive.identity.getAgent('human'), c.req.param('id'), c.req.param('botId'), await readLimitedJson(c.req.raw, CREDENTIAL_JSON_BYTES)));
  });
  ui.post('/channels/:id/messages', async c => {
    const human = hive.identity.getAgent('human'), body = await requestJson(c.req.raw), channel = hive.channels.getChannel(c.req.param('id'));
    const originalBody = String(body.body ?? ''), threadId = body.threadId ?? null;
    const messageInput = { channel: channel.id, body: originalBody, requestId: body.requestId, threadId,
      eventType: body.eventType, traceId: body.traceId, causeMessageId: body.causeMessageId, recipients: body.recipients,
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : undefined };
    if (hive.messages.hasActiveSendRequest(human, channel.id, body.requestId))
      return c.json({ message: hive.messages.postMessage(human, messageInput) });
    const message = hive.messages.postMessage(human, messageInput);
    // Committed and broadcast first; Jev advises the owning brain in the background and never delays the send (#214).
    hive.adaptiveTopology.humanMessagePosted(human, message);
    return c.json({ message });
  });
  ui.post('/files', async c => {
    const human = hive.identity.getAgent('human'), name = c.req.header('x-file-name') || 'paste.png';
    const file = await hive.files.createFile(human, { name, mime: resolveUploadMime(c.req.header('x-file-mime'), name),
      body: c.req.raw.body, signal: c.req.raw.signal, declaredBytes: uploadLength(c.req.header('content-length') ?? null) });
    return c.json({ file });
  });
  ui.get('/files/:id', c => fileDownload(hive, hive.identity.getAgent('human'), c.req.param('id')));
  ui.post('/messages/:seq/reactions', async c => {
    const body = await requestJson(c.req.raw);
    return c.json(hive.messages.setReaction(hive.identity.getAgent('human'), Number(c.req.param('seq')), String(body.emoji ?? ''), body.present));
  });
  ui.post('/dms', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ channel: hive.channels.openDm(hive.identity.getAgent('human'), String(body.name ?? '')) });
  });
  ui.post('/threads/:id/status', async c => {
    const body = await requestJson(c.req.raw);
    const thread = hive.messages.setThreadStatus(hive.identity.getAgent('human'), c.req.param('id'), body.status ?? null);
    return c.json({ thread: threadResponseSchema.parse(thread) });
  });
  ui.post('/clear-context', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ message: hive.messages.clearContext(hive.identity.getAgent('human'), String(body.name ?? '')) });
  });
  ui.post('/channels/:id/invite', async c => {
    const body = await requestJson(c.req.raw);
    const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? '')];
    return c.json({ channel: hive.channels.invite(hive.identity.getAgent('human'), c.req.param('id'), names.filter(Boolean)) });
  });
  ui.post('/read', async c => {
    const human = hive.identity.getAgent('human'), body = await requestJson(c.req.raw);
    if (body.messageSeqs !== undefined) hive.reads.markMessagesRead(human, String(body.channelId), body.messageSeqs, body.threadId ?? null);
    else {
      const seq = Number(body.seq);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new HiveError(400, 'Invalid read-through sequence');
      const channel = hive.channels.getChannel(String(body.channelId));
      if (seq > hive.messageQueries.latestSeq(channel.id)) throw new HiveError(400, 'Read-through sequence is beyond the channel history');
      hive.reads.markRead(human, channel.id, seq);
    }
    return c.json({ ok: true, ...hive.reads.readSnapshot(human) });
  });
  ui.post('/unread', async c => {
    const human = hive.identity.getAgent('human'), body = await requestJson(c.req.raw);
    hive.reads.markUnreadFrom(human, String(body.channelId), body.fromSeq);
    return c.json({ ok: true, ...hive.reads.readSnapshot(human) });
  });
  ui.post('/tasks/:id/routing', async c => c.json(hive.routing.suggest(hive.identity.getAgent('human'), c.req.param('id'), await requestJson(c.req.raw))));
  ui.post('/tasks/:id/routing-override', async c => c.json(hive.routing.override(hive.identity.getAgent('human'), c.req.param('id'), await requestJson(c.req.raw))));
  ui.get('/tasks/:id/timeline', c => c.json({ timeline: hive.timeline.traceForTask(hive.identity.getAgent('human'), c.req.param('id')) }));
  ui.get('/tasks/:id/timeline/export', c => c.json({ fixture: hive.timeline.exportTask(hive.identity.getAgent('human'), c.req.param('id')) }));

  const agent = new Hono();
  agent.use('*', async (c, next) => {
    if (c.req.path === '/api/agent/join' && c.req.method === 'POST') { await validateRequest(c.req.raw); return next(); }
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new HiveError(401, 'Missing token. Join first.');
    let me = hive.identity.agentByToken(token);
    if (me.role !== 'brain' && me.role !== 'worker') throw new HiveError(403, 'Only brains and workers use the agent API');
    if (me.role !== 'brain' && c.req.method === 'POST' && (c.req.path === '/api/agent/tasks' || c.req.path === '/api/agent/channels' ||
      c.req.path.endsWith('/invite') || c.req.path.endsWith('/clear-context'))) throw new HiveError(403, 'This mutation requires a brain');
    await validateRequest(c.req.raw);
    me = hive.identity.agentByToken(token);
    hive.identity.touch(me.id, true); c.set('me', me); c.set('token', token);
    await next();
  });
  agent.post('/join', async c => {
    const body = await requestJson(c.req.raw);
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const result = hive.identity.join({ role: body.role, seniority: body.seniority ?? null, focus: body.focus ?? null,
      token: bearer || body.token || null, resumeName: body.resume || body.resumeName || null, project: body.project ?? null, cwd: body.cwd ?? null,
      terminalSession: body.terminalSession ?? null });
    return c.json({ ...result, describe: describeAgent(result.agent), standingOrders: result.created ? standingOrders(result.agent) : undefined,
      ordersRef: result.created ? undefined : 'unchanged', handoffs: hive.tasks.handoffs(result.agent) });
  });
  agent.get('/me', c => {
    const me = c.get('me');
    if (c.req.query('orders') === '1') return c.json({ you: me, standingOrders: standingOrders(me) });
    return c.json({ you: { name: me.name, role: me.role, seniority: me.seniority, focus: me.focus, online: me.online, project: me.project },
      ordersRef: 'unchanged' });
  });
  // terminalSession is a Human UI label; agents' roster stays as it was.
  agent.get('/agents', c => c.json({ agents: hive.identity.listAgents(c.get('me')).map(({ createdAt: _c, terminalSession: _t, ...a }) => a) }));
  agent.get('/bot-tools', c => {
    const me = c.get('me');
    if (me.role !== 'brain' || !me.projectId) throw new HiveError(403, 'Bot tools require a project brain');
    const definitions = projectBotConfigurations(hive.home, hive.projects.getProject(me.projectId));
    const bots = hive.identity.listAgents(me).filter(bot => bot.role === 'bot' && bot.projectId === me.projectId);
    return c.json({ bots: bots.flatMap(bot => {
      const access = hive.bots.access(bot), definition = definitions.find(p => p.id === access.definitionId);
      const credential = hive.bots.botCredential(hive.identity.getAgent('human'), me.projectId!, bot.id).credential;
      return !credential.revoked && access.capabilities.includes('tools') && definition?.enabled && definition.configured && !definition.error
        ? [{ id: bot.id, name: bot.name, tools: definition.tools ?? [] }] : [];
    }) });
  });
  agent.post('/bots/:botId/tools', async c => {
    const me = c.get('me');
    if (me.role !== 'brain' || !me.projectId) throw new HiveError(403, 'Bot tools require a project brain');
    const { bot, credential } = hive.bots.botCredential(hive.identity.getAgent('human'), me.projectId, c.req.param('botId'));
    if (credential.revoked) throw new HiveError(403, 'Bot credentials are revoked');
    const access = hive.bots.requireCapability(bot, 'tools');
    if (!access.definitionId) throw new HiveError(409, 'Bot definition is not connected');
    const input = await readLimitedJson(c.req.raw, BOT_CONFIGURATION_REQUEST_BYTES);
    try {
      return c.json({ result: await callProjectBot(hive.home, hive.projects.getProject(me.projectId), c.req.url, access.definitionId, bot, input, false, () => {
        const actor = hive.identity.agentByToken(c.get('token'));
        if (actor.role !== 'brain' || actor.projectId !== bot.projectId) throw new HiveError(403, 'Project brain access changed');
        const current = hive.bots.botCredential(hive.identity.getAgent('human'), actor.projectId!, bot.id);
        if (current.credential.revoked || hive.bots.requireCapability(current.bot, 'tools').revision !== access.revision)
          throw new HiveError(403, 'Bot access changed before execution');
      }) });
    } catch (error) { if (error instanceof HiveError) throw error; throw new HiveError(400, botErrorMessage(error)); }
  });
  agent.get('/search', c => {
    const me = c.get('me');
    return c.json(hive.messageQueries.searchMessages(me, { q: String(c.req.query('q') ?? ''), project: c.req.query('project') || me.project,
      channel: c.req.query('channel') || undefined, beforeSeq: c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined }));
  });
  agent.get('/subscriptions', c => c.json({ subscriptions: hive.notifications.list(c.get('me')) }));
  agent.post('/subscriptions', async c => c.json({ subscriptions: hive.notifications.set(c.get('me'), await requestJson(c.req.raw)) }));
  agent.post('/subscriptions/reset', async c => c.json({ subscriptions: hive.notifications.reset(c.get('me'), await requestJson(c.req.raw)) }));
  agent.get('/channels', c => {
    const me = c.get('me');
    return c.json({ channels: hive.channels.listChannels(me), unread: c.req.query('unread') === '1' ? hive.reads.unreadCounts(me) : undefined });
  });
  agent.get('/channels/:id/messages', c => {
    const me = c.get('me'), after = c.req.query('afterSeq'), before = c.req.query('beforeSeq');
    const threadId = c.req.query('threadId') || null;
    const listed = hive.messageQueries.listMessages(me, c.req.param('id'), { threadId,
      afterSeq: after !== undefined ? Number(after) : undefined, beforeSeq: before !== undefined ? Number(before) : undefined,
      limit: Number(c.req.query('limit') ?? 20) });
    const ch = hive.channels.getChannel(c.req.param('id'), me.projectId), meta = c.req.query('meta') === '1';
    return c.json({ channel: { id: ch.id, name: ch.name, type: ch.type }, messages: listed.messages,
      hasOlder: listed.hasOlder, hasNewer: listed.hasNewer, cursors: listed.cursors,
      threads: meta ? hive.messageQueries.threadsInChannel(ch.id, windowRoots(listed.messages, threadId)).map(thread => threadResponseSchema.parse(thread)) : undefined,
      replyCounts: meta ? hive.messageQueries.replyCounts(ch.id, windowRoots(listed.messages, threadId)) : undefined });
  });
  agent.post('/channels', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ channel: hive.channels.createChannel(c.get('me'), { name: String(body.name ?? ''), type: body.type ?? 'public', topic: body.topic, memberNames: body.memberNames }) });
  });
  agent.post('/channels/:id/messages', async c => c.json(await sendAdaptiveAgentMessage(
    hive, c.get('me'), c.req.param('id'), await requestJson(c.req.raw))));
  agent.get('/messages/:seq', c => c.json({ message: hive.messageQueries.getVisibleMessage(c.get('me'), Number(c.req.param('seq'))) }));
  agent.post('/messages/expand', async c => c.json(hive.messageQueries.expandDigest(c.get('me'), await requestJson(c.req.raw))));
  agent.post('/tasks', async c => c.json(await assignAdaptiveTask(hive, c.get('me'), await requestJson(c.req.raw))));
  agent.get('/channels/:id/room', c => c.json(hive.rooms.view(c.get('me'), c.req.param('id'), c.req.query('beforeTask'))));
  agent.get('/channels/:id/room/history', c => c.json({ history: hive.rooms.history(c.get('me'), c.req.param('id'), Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)) }));
  agent.post('/channels/:id/room', async c => c.json(await mutateAdaptiveRoom(hive, c.get('me'), c.req.param('id'), await requestJson(c.req.raw))));
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
  agent.get('/tasks/:id', c => c.json({ task: hive.tasks.view(c.get('me'), c.req.param('id')) }));
  agent.post('/tasks/:id/events', async c => c.json(await mutateAdaptiveTask(hive, c.get('me'), c.req.param('id'), await requestJson(c.req.raw))));
  agent.post('/files', async c => {
    const name = c.req.header('x-file-name') || 'file';
    const file = await hive.files.createFile(c.get('me'), { authorize: () => hive.identity.agentByToken(c.get('token')), name,
      mime: resolveUploadMime(c.req.header('x-file-mime'), name), body: c.req.raw.body, signal: c.req.raw.signal,
      declaredBytes: uploadLength(c.req.header('content-length') ?? null) });
    return c.json({ file });
  });
  agent.get('/files/:id', c => fileDownload(hive, c.get('me'), c.req.param('id')));
  agent.post('/messages/:seq/reactions', async c => {
    const body = await requestJson(c.req.raw);
    const result = hive.messages.setReaction(c.get('me'), Number(c.req.param('seq')), String(body.emoji ?? ''), body.present);
    return c.json({ ok: true, added: result.added, seq: result.message.seq });
  });
  agent.post('/dms', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ channel: hive.channels.openDm(c.get('me'), String(body.name ?? body.to ?? '')) });
  });
  agent.post('/threads/:id/status', async c => {
    const body = await requestJson(c.req.raw);
    const { thread, ...advice } = await setAdaptiveThreadStatus(hive, c.get('me'), c.req.param('id'), body.status ?? null);
    return c.json({ thread: threadResponseSchema.parse(thread), ...advice });
  });
  agent.post('/channels/:id/invite', async c => {
    const body = await requestJson(c.req.raw);
    const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? body.member ?? '')];
    return c.json({ channel: hive.channels.invite(c.get('me'), c.req.param('id'), names.filter(Boolean)) });
  });
  agent.post('/clear-context', async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ message: hive.messages.clearContext(c.get('me'), String(body.name ?? body.agent ?? '')) });
  });
  agent.post('/wait', async c => {
    const me = c.get('me'), body = await requestJson(c.req.raw);
    if (body?.sessionId == null) throw new HiveError(409, 'HTTP 409: Inbox delivery protocol changed. Restart the Hivemind MCP client and rejoin. HTTP/CLI clients must open an inbox session and include sessionId in wait. Do not retry this wait unchanged.');
    if (typeof body.sessionId !== 'string') throw new HiveError(400, 'Expected sessionId');
    const result = await hive.delivery.wait(me, Number(body.timeoutMs ?? DEFAULT_WAIT_MS), c.req.raw.signal, { compact: Boolean(body.compact), sessionId: body.sessionId });
    return c.json({ ...result, ...adviseAfterWait(hive, me, result) });
  });
  agent.post('/inbox/session', async c => {
    const body = await requestJson(c.req.raw);
    if (typeof body?.sessionId !== 'string') throw new HiveError(400, 'Expected sessionId');
    return c.json({ sessionId: hive.delivery.openInboxSession(c.get('me'), body.sessionId) });
  });
  agent.post('/inbox/ack', async c => {
    const body = await requestJson(c.req.raw);
    if (typeof body?.sessionId !== 'string' || typeof body?.deliveryId !== 'string') throw new HiveError(400, 'Expected sessionId and deliveryId');
    return c.json(hive.delivery.acknowledgeInbox(c.get('me'), body.sessionId, body.deliveryId));
  });
  agent.post('/ping', c => c.json({ ok: true, name: c.get('me').name, online: true }));
  agent.post('/leave', c => { hive.identity.setOffline(c.get('me').id); return c.json({ ok: true }); });

  const botBudget = new BotIngressBudget();
  const bot = new Hono<{ Variables: { me: Agent; token: string } }>();
  bot.use('*', async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!match) throw new HiveError(401, 'A Bearer bot token is required');
    const me = hive.identity.agentByToken(match[1]!);
    if (me.role !== 'bot') throw new HiveError(403, 'A bot identity is required');
    const release = botBudget.acquire(me.id);
    if (!release) { c.header('Retry-After', '1'); throw new HiveError(429, 'Bot ingress is busy; retry with the same event ID'); }
    c.set('me', me); c.set('token', match[1]!);
    try { await next(); } finally { release(); }
  });
  bot.post('/channels/:id/messages', async c => {
    const body = await readLimitedJson(c.req.raw, BOT_JSON_BYTES);
    const actor = hive.identity.agentByToken(c.get('token'));
    const result = hive.bots.postBotMessage(actor, c.req.param('id'), body);
    return c.json(result, result.duplicate ? 200 : 201);
  });
  bot.get('/channels/:id/messages', c => c.json(hive.bots.receive(c.get('me'), c.req.param('id'), Number(c.req.query('afterSeq') ?? 0), Number(c.req.query('limit') ?? 50))));
  bot.get('/channels/:id/links', c => c.json({ links: hive.rooms.botLinks(c.get('me'), c.req.param('id')) }));
  bot.post('/channels/:id/links', async c => {
    const body = await requestJson(c.req.raw);
    const actor = hive.identity.agentByToken(c.get('token'));
    return c.json({ link: hive.rooms.registerLink(actor, c.req.param('id'), body) });
  });
  bot.post('/channels/:id/links/:link/status', async c => {
    const body = await requestJson(c.req.raw);
    const actor = hive.identity.agentByToken(c.get('token'));
    return c.json({ link: hive.rooms.reportLink(actor, c.req.param('id'), c.req.param('link'), body) });
  });
  bot.post('/files', async c => {
    hive.bots.requireCapability(c.get('me'), 'publish');
    const name = c.req.header('x-file-name') || 'file';
    const file = await hive.files.createFile(c.get('me'), { authorize: () => {
      const actor = hive.identity.agentByToken(c.get('token')); hive.bots.requireCapability(actor, 'publish'); return actor;
    }, name,
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
