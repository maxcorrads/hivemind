import type { SQLInputValue } from "node:sqlite";
import { cursorSchema, limitSchema, validated } from "../../shared/api-contract.ts";
import { digestExpansionSchema } from "../../shared/digest.ts";
import { clampSearchLimit, likeNeedle, parseSearchQuery, snippetAround } from "../../shared/search-query.ts";
import type { TaskEnvelope } from "../../shared/tasks.ts";
import {
  FILES_PER_MESSAGE,
  WAIT_MAX_BYTES,
  HiveError,
  type Agent,
  type AttachmentMeta,
  type BotEvent,
  type DigestExpansionResult,
  type Message,
  type ReactionCount,
  type Role,
  type SearchHit,
  type Thread,
} from "../../shared/types.ts";
import type { ChannelService } from "./channels.ts";
import type { Core, MessageReader, ProjectDirectory } from "./ports.ts";
import { batches, type MessageRow } from "./rows.ts";

export type MessageRef = { id: string; channelId: string; threadId: string | null; createdAt: number };
export type WakeHeader = Record<string, any>;

export type MessageQueriesDeps = Core & {
  readonly channels: Pick<ChannelService, "getChannel" | "canSeeChannel" | "listChannels" | "visibleChannelScope">;
  readonly projects: { searchProject(actor: Agent, slug?: string | null): ReturnType<ProjectDirectory["getProject"]> };
};

/** Message reads: hydration (authors, provenance, attachments, reactions), history pages, digests and search. */
export class MessageQueries implements MessageReader {
  constructor(private readonly deps: MessageQueriesDeps) {}

  private get db() { return this.deps.storage.db; }

  getVisibleMessage(actor: Agent, seq: number): Message {
    const msg = this.getMessageBySeq(seq);
    const ch = this.deps.channels.getChannel(msg.channelId);
    if (!this.deps.channels.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot read this message");
    return this.decorate([msg], actor.id)[0]!;
  }

  getMessageBySeq(seq: number): Message {
    const row = this.db.prepare("SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE seq = ?").get(seq) as MessageRow | undefined;
    if (!row) throw new HiveError(404, "Message not found");
    return this.decorate([this.mapMessage(row)])[0]!;
  }

  getMessageById(id: string): Message {
    const row = this.db.prepare("SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    if (!row) throw new HiveError(404, "Message not found");
    return this.decorate([this.mapMessage(row)])[0]!;
  }

  mapMessages(rows: MessageRow[]): Message[] {
    type Author = { id: string; name: string; role: Role };
    const authors = new Map<string, Author>();
    const botEvents = new Map<string, BotEvent>();
    const taskEvents = new Map<string, TaskEnvelope>();
    const sources = new Map<string, Message["source"]>();
    for (const ids of batches(rows.map(row => row.id))) {
      const found = this.db.prepare(`SELECT message_id, envelope FROM task_events WHERE message_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Array<{ message_id: string; envelope: string }>;
      for (const event of found) taskEvents.set(event.message_id, JSON.parse(event.envelope) as TaskEnvelope);
    }
    for (const ids of batches(rows.map(row => row.id))) {
      const found = this.db.prepare(`SELECT message_id, source FROM message_provenance WHERE message_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Array<{ message_id: string; source: "hive" | "telegram" | "bot" }>;
      for (const item of found) if (item.source !== "hive") sources.set(item.message_id, item.source);
    }
    for (const ids of batches([...new Set(rows.map((row) => row.author_id))])) {
      const found = this.db.prepare(
        `SELECT id, name, role FROM agents WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).all(...ids) as Author[];
      for (const author of found) authors.set(author.id, author);
    }
    const botMessageIds = [...new Set(
      rows.filter((row) => authors.get(row.author_id)?.role === "bot").map((row) => row.id),
    )];
    for (const ids of batches(botMessageIds)) {
      const found = this.db.prepare(
        `SELECT message_id, metadata FROM bot_events WHERE message_id IN (${ids.map(() => "?").join(",")})`,
      ).all(...ids) as Array<{ message_id: string; metadata: string }>;
      for (const event of found) botEvents.set(event.message_id, JSON.parse(event.metadata) as BotEvent);
    }
    return rows.map((row) => ({
      id: row.id, seq: row.seq, channelId: row.channel_id, threadId: row.thread_id,
      authorId: row.author_id,
      authorName: authors.get(row.author_id)?.name ?? "unknown",
      authorRole: authors.get(row.author_id)?.role ?? "worker",
      // Read message bodies through a BLOB projection: older Node SQLite TEXT
      // conversion truncates at embedded NUL even though the stored value is intact.
      body: typeof row.body === "string" ? row.body : Buffer.from(row.body).toString("utf8"),
      kind: row.kind, control: row.control,
      ...(row.event_type ? { eventType: row.event_type } : {}),
      mentions: JSON.parse(row.mentions) as string[], createdAt: row.created_at,
      ...(row.recipients && row.recipients !== '[]' ? { recipientIds: JSON.parse(row.recipients) as string[] } : {}),
      ...(taskEvents.has(row.id) ? { taskEvent: taskEvents.get(row.id)! } : {}),
      ...(sources.has(row.id) ? { source: sources.get(row.id)! } : {}),
      ...(botEvents.has(row.id) ? { source: "bot" as const, botEvent: botEvents.get(row.id)! } : {}),
    }));
  }

  mapMessage(row: MessageRow): Message {
    return this.mapMessages([row])[0]!;
  }

  /** Hydrates messages in the order of `ids`, decorated for `actorId`. */
  loadMessagesByIds(ids: string[], actorId: string): Message[] {
    const byId = new Map<string, MessageRow>();
    for (const batch of batches([...new Set(ids)])) {
      const rows = this.db.prepare(
        `SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE id IN (${batch.map(() => "?").join(",")})`,
      ).all(...batch) as MessageRow[];
      for (const row of rows) byId.set(row.id, row);
    }
    return this.decorate(this.mapMessages(
      ids.map((id) => byId.get(id)).filter((row): row is MessageRow => Boolean(row)),
    ), actorId);
  }

  /** Adds attachments and reaction counts (`mine` from `actorId`'s point of view). */
  decorate(messages: Message[], actorId?: string): Message[] {
    if (messages.length === 0) return messages;
    const atts: Array<{ id: string; message_id: string; name: string; mime: string; bytes: number }> = [];
    const reacts: Array<{ message_id: string; emoji: string; agent_id: string }> = [];
    for (const ids of batches([...new Set(messages.map((m) => m.id))])) {
      const placeholders = ids.map(() => "?").join(",");
      atts.push(...this.db.prepare(
        `SELECT id, message_id, name, mime, bytes FROM attachments WHERE message_id IN (${placeholders})`,
      ).all(...ids) as typeof atts);
      reacts.push(...this.db.prepare(
        `SELECT message_id, emoji, agent_id FROM reactions WHERE message_id IN (${placeholders})`,
      ).all(...ids) as typeof reacts);
    }
    const attMap = new Map<string, AttachmentMeta[]>();
    for (const a of atts) {
      const list = attMap.get(a.message_id) ?? [];
      list.push({ id: a.id, name: a.name, mime: a.mime, bytes: a.bytes });
      attMap.set(a.message_id, list);
    }
    const reactMap = new Map<string, ReactionCount[]>();
    for (const r of reacts) {
      const list = reactMap.get(r.message_id) ?? [];
      const found = list.find((x) => x.emoji === r.emoji);
      if (found) {
        found.count += 1;
        if (actorId && r.agent_id === actorId) found.mine = true;
      } else {
        list.push({ emoji: r.emoji, count: 1, mine: Boolean(actorId && r.agent_id === actorId) });
      }
      reactMap.set(r.message_id, list);
    }
    return messages.map((m) => ({
      ...m,
      attachments: attMap.get(m.id) ?? [],
      reactions: reactMap.get(m.id) ?? [],
    }));
  }

  hasReaction(agentId: string, messageId: string, emoji: string): boolean {
    return Boolean(
      this.db.prepare(
        "SELECT 1 AS ok FROM reactions WHERE message_id = ? AND agent_id = ? AND emoji = ?",
      ).get(messageId, agentId, emoji),
    );
  }

  listMessages(
    actor: Agent,
    channelRef: string,
    opts: { threadId?: string | null; afterSeq?: number; beforeSeq?: number; limit?: number } = {},
  ): { messages: Message[]; hasOlder: boolean; hasNewer: boolean; cursors: { before?: number; after?: number } } {
    const ch = this.deps.channels.getChannel(channelRef, actor.projectId);
    if (!this.deps.channels.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot read this channel");
    for (const [name, value] of [["afterSeq", opts.afterSeq], ["beforeSeq", opts.beforeSeq]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new HiveError(400, `${name} must be a nonnegative safe integer`);
      }
    }
    if (opts.afterSeq !== undefined && opts.beforeSeq !== undefined) {
      throw new HiveError(400, "Use either afterSeq or beforeSeq, not both");
    }
    if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
      throw new HiveError(400, "limit must be a positive safe integer");
    }
    const limit = Math.min(opts.limit ?? 80, 200);
    // Root-channel reads default to latest-N. Explicit forward cursors and a
    // thread's default opening page are oldest-first.
    const ascending = opts.beforeSeq === undefined && (opts.afterSeq !== undefined || Boolean(opts.threadId));
    const op = ascending ? ">" : "<";
    const order = ascending ? "ASC" : "DESC";
    const boundary = ascending ? (opts.afterSeq ?? 0) : (opts.beforeSeq ?? Number.MAX_SAFE_INTEGER);
    let rows: MessageRow[];

    if (opts.threadId) {
      // Keep the root PK lookup separate from the indexed reply range. An OR
      // over id/thread_id can otherwise scan unrelated channel history.
      const root = this.db.prepare(
        `SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE id = ? AND channel_id = ? AND seq ${op} ?`,
      ).get(opts.threadId, ch.id, boundary) as MessageRow | undefined;
      const replies = this.db.prepare(
        `SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE channel_id = ? AND thread_id = ? AND seq ${op} ?
         ORDER BY seq ${order} LIMIT ?`,
      ).all(ch.id, opts.threadId, boundary, limit) as MessageRow[];
      rows = [...(root ? [root] : []), ...replies]
        .sort((a, b) => (ascending ? a.seq - b.seq : b.seq - a.seq))
        .slice(0, limit);
    } else {
      rows = this.db.prepare(
        `SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE channel_id = ? AND thread_id IS NULL AND seq ${op} ?
         ORDER BY seq ${order} LIMIT ?`,
      ).all(ch.id, boundary, limit) as MessageRow[];
    }

    if (!ascending) rows.reverse();
    const messages = this.decorate(this.mapMessages(rows), actor.id);
    const existsBeyond = (operator: "<" | ">", seq: number): boolean => {
      if (opts.threadId) {
        return Boolean(this.db.prepare(
          `SELECT 1 FROM messages WHERE id = ? AND channel_id = ? AND seq ${operator} ? LIMIT 1`,
        ).get(opts.threadId, ch.id, seq)) || Boolean(this.db.prepare(
          `SELECT 1 FROM messages WHERE channel_id = ? AND thread_id = ? AND seq ${operator} ? LIMIT 1`,
        ).get(ch.id, opts.threadId, seq));
      }
      return Boolean(this.db.prepare(
        `SELECT 1 FROM messages WHERE channel_id = ? AND thread_id IS NULL AND seq ${operator} ? LIMIT 1`,
      ).get(ch.id, seq));
    };
    const oldest = messages[0]?.seq;
    const newest = messages.at(-1)?.seq;
    const hasOlder = oldest !== undefined && existsBeyond("<", oldest);
    const hasNewer = newest !== undefined && existsBeyond(">", newest);
    return {
      messages,
      hasOlder,
      hasNewer,
      cursors: {
        before: hasOlder ? oldest : undefined,
        after: hasNewer ? newest : undefined,
      },
    };
  }

  /** Expand an immutable set of digest IDs; this never reads or mutates receipt state. */
  expandDigest(actor: Agent, raw: unknown): DigestExpansionResult {
    if (actor.role !== "brain" && actor.role !== "worker") throw new HiveError(403, "Only agents expand inbox digests");
    const parsed = digestExpansionSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, "Invalid digest reference: " + parsed.error.issues.map(i => i.message).join("; "));
    const { channel, messageIds, afterSeq = 0 } = parsed.data;
    const ch = this.deps.channels.getChannel(channel, actor.projectId);
    if (!this.deps.channels.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot read this channel");
    const headers = this.db.prepare(`SELECT id, seq, channel_id, length(CAST(body AS BLOB)) AS body_bytes,
      COALESCE((SELECT length(CAST(metadata AS BLOB)) FROM bot_events WHERE message_id = messages.id), 0) +
      COALESCE((SELECT length(CAST(envelope AS BLOB)) FROM task_events WHERE message_id = messages.id), 0) AS metadata_bytes FROM messages
      WHERE id IN (SELECT value FROM json_each(?)) ORDER BY seq`).all(JSON.stringify(messageIds)) as
        { id: string; seq: number; channel_id: string; body_bytes: number; metadata_bytes: number }[];
    // Validate the entire selection before emitting any content, including past pages.
    if (headers.length !== messageIds.length || headers.some(m => m.channel_id !== ch.id))
      throw new HiveError(404, "Digest messages are missing or outside this channel");
    if (afterSeq !== 0 && !headers.some(m => m.seq === afterSeq))
      throw new HiveError(400, "afterSeq must be a sequence from this digest");
    const pending = headers.filter(m => m.seq > afterSeq);
    const messages: Message[] = [];
    const result = (items: Message[]): DigestExpansionResult => ({ messages: items,
      hasMore: items.length < pending.length,
      nextAfterSeq: items.length < pending.length ? items.at(-1)!.seq : null });
    for (const header of pending) {
      // No reaction rosters or file bytes; hydrate one selected original at a time.
      // Legacy oversized originals are rejected before loading their content.
      const tooLarge = () => new HiveError(413, "Original exceeds expansion byte limit. Use history with " +
        JSON.stringify({ channel: ch.id, threadId: header.id, since: header.seq - 1, limit: 1, meta: false }));
      if (header.body_bytes + header.metadata_bytes > WAIT_MAX_BYTES) {
        if (!messages.length) throw tooLarge();
        break;
      }
      const row = this.db.prepare("SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE id = ?").get(header.id) as MessageRow;
      const message = this.mapMessage(row);
      message.attachments = this.db.prepare("SELECT id, name, mime, bytes FROM attachments WHERE message_id = ? ORDER BY id LIMIT ?")
        .all(header.id, FILES_PER_MESSAGE) as AttachmentMeta[];
      const candidate = result([...messages, message]);
      const pretty = JSON.stringify(candidate, null, 2);
      const bytes = Math.max(Buffer.byteLength(pretty),
        Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: pretty }] })));
      if (bytes > WAIT_MAX_BYTES) {
        if (!messages.length) throw tooLarge();
        break;
      }
      messages.push(message);
      if (messages.length === 8) break;
    }
    return result(messages);
  }

  searchMessages(
    actor: Agent,
    input: { q: string; project?: string | null; channel?: string | null; beforeSeq?: number; limit?: number },
  ): { hits: SearchHit[]; hasMore: boolean } {
    if (input.beforeSeq !== undefined) validated(cursorSchema, input.beforeSeq);
    if (input.limit !== undefined) validated(limitSchema, input.limit);
    const tokens = parseSearchQuery(input.q ?? "");
    if (tokens.length === 0) throw new HiveError(400, "Search needs a query");
    const project = this.deps.projects.searchProject(actor, input.project);
    let rooms = this.deps.channels.listChannels(actor).filter((ch) => ch.projectId === project.id);
    if (input.channel) {
      const ch = this.deps.channels.getChannel(input.channel, project.id);
      if (!this.deps.channels.canSeeChannel(actor, ch) || ch.projectId !== project.id) {
        throw new HiveError(403, "Cannot search this channel");
      }
      rooms = [ch];
    }
    if (rooms.length === 0) return { hits: [], hasMore: false };
    const limit = clampSearchLimit(input.limit);
    const before =
      Number.isFinite(input.beforeSeq) && Number(input.beforeSeq) > 0
        ? Number(input.beforeSeq)
        : Number.MAX_SAFE_INTEGER;
    const roomScope = input.channel
      ? { sql: "SELECT id FROM channels WHERE id = ?", args: [rooms[0]!.id] }
      : this.deps.channels.visibleChannelScope(actor);
    const params: SQLInputValue[] = [project.id, ...roomScope.args, before];
    const tokenSql = tokens.map((token) => {
      const like = likeNeedle(token);
      params.push(like, like, like, like, like, like);
      let extra = "";
      if (/^\d+$/.test(token)) {
        extra = " OR m.seq = ?";
        params.push(Number(token));
      }
      return `(
        m.body LIKE ? ESCAPE '\\'
        OR a.name LIKE ? ESCAPE '\\'
        OR c.name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM attachments att WHERE att.message_id = m.id AND att.name LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM reactions r WHERE r.message_id = m.id AND r.emoji LIKE ? ESCAPE '\\')
        OR EXISTS (
          SELECT 1 FROM agents ma
          WHERE instr(m.mentions, ma.id) > 0 AND ma.name LIKE ? ESCAPE '\\'
        )
        ${extra}
      )`;
    });
    params.push(limit + 1);
    const rows = this.db.prepare(
      `SELECT m.id
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN agents a ON a.id = m.author_id
       WHERE c.project_id = ?
         AND c.id IN (${roomScope.sql})
         AND m.seq < ?
         AND ${tokenSql.join(" AND ")}
       ORDER BY m.seq DESC
       LIMIT ?`,
    ).all(...params) as { id: string }[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const messages = this.loadMessagesByIds(
      page.map((row) => row.id),
      actor.id,
    );
    const byId = new Map(rooms.map((ch) => [ch.id, ch]));
    return {
      hasMore,
      hits: messages.map((msg) => {
        const ch = byId.get(msg.channelId) ?? this.deps.channels.getChannel(msg.channelId);
        return {
          seq: msg.seq,
          channelId: msg.channelId,
          channelName: ch.name,
          channelType: ch.type,
          threadId: msg.threadId,
          authorName: msg.authorName,
          authorRole: msg.authorRole,
          body: snippetAround(msg.body, tokens),
          createdAt: msg.createdAt,
          kind: msg.kind,
          botEvent: msg.botEvent,
          attachments: (msg.attachments ?? []).map((a) => a.name),
          reactions: [...new Set((msg.reactions ?? []).map((r) => r.emoji))],
        };
      }),
    };
  }

  threadsInChannel(channelId: string): Thread[] {
    return this.db
      .prepare("SELECT id, channel_id AS channelId, status FROM threads WHERE channel_id = ?")
      .all(channelId) as Thread[];
  }

  replyCounts(channelId: string): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT thread_id AS id, COUNT(*) AS n FROM messages
       WHERE channel_id = ? AND thread_id IS NOT NULL GROUP BY thread_id`,
    ).all(channelId) as { id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }

  /** A thread's stored status: undefined when it has none, null when it was cleared. */
  threadStatus(threadId: string): string | null | undefined {
    const row = this.db.prepare("SELECT status FROM threads WHERE id=?").get(threadId) as { status: string | null } | undefined;
    return row?.status;
  }

  /** A message's identity and position, without decoration; undefined when it does not exist. */
  messageRef(id: string): MessageRef | undefined {
    const row = this.db.prepare("SELECT id, channel_id, thread_id, created_at FROM messages WHERE id = ?").get(id) as
      { id: string; channel_id: string; thread_id: string | null; created_at: number } | undefined;
    return row && { id: row.id, channelId: row.channel_id, threadId: row.thread_id, createdAt: row.created_at };
  }

  /** True when the thread has a message newer than `afterSeq` in the channel. */
  hasNewerInThread(channelId: string, threadId: string, afterSeq: number): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM messages WHERE channel_id = ? AND thread_id = ? AND seq > ? LIMIT 1",
    ).get(channelId, threadId, afterSeq));
  }

  /** True when a bot posted the message. */
  postedByBot(messageId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM bot_events WHERE message_id=?").get(messageId));
  }

  /** Seqs of the given messages (missing ids are skipped). */
  seqsOf(ids: string[]): number[] {
    return (this.db.prepare("SELECT seq FROM messages WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { seq: number }[])
      .map((row) => row.seq);
  }

  /** The routing facts of one message that explain why an agent was woken (timeline wake reasons). */
  wakeHeader(seq: number): WakeHeader | undefined {
    return this.db.prepare(`SELECT m.id, m.seq, m.channel_id, COALESCE(m.thread_id,m.id) AS root_id,
      m.author_id, m.kind, m.event_type, m.created_at, m.mentions, m.recipients,
      c.type, c.project_id, a.role AS author_role,
      EXISTS(SELECT 1 FROM task_events t WHERE t.message_id=m.id) AS task,
      EXISTS(SELECT 1 FROM attachments f WHERE f.message_id=m.id) AS evidence
      FROM messages m JOIN channels c ON c.id=m.channel_id LEFT JOIN agents a ON a.id=m.author_id
      WHERE m.seq=?`).get(seq) as WakeHeader | undefined;
  }

  /**
   * The messages of one trace in seq order: those whose recorded provenance names the trace, and
   * those without provenance whose thread root is the trace id. Includes author and task envelope.
   */
  traceMessages(traceId: string, limit: number): Array<Record<string, any>> {
    return this.db.prepare(`SELECT m.id,m.seq,m.channel_id,m.author_id,m.body,m.event_type,m.created_at,
      a.name AS author_name,a.role AS author_role,p.trace_id,p.parent_message_id,p.cause_message_id,p.source,
      te.envelope FROM messages m
      LEFT JOIN message_provenance p ON p.message_id=m.id
      LEFT JOIN agents a ON a.id=m.author_id LEFT JOIN task_events te ON te.message_id=m.id
      WHERE COALESCE(p.trace_id,COALESCE(m.thread_id,m.id))=?
      ORDER BY m.seq LIMIT ?`).all(traceId, limit) as Array<Record<string, any>>;
  }

  /** Stored status of each thread among `ids` that has one (null when it was cleared). */
  threadStatuses(ids: string[]): Map<string, string | null> {
    const rows = this.db.prepare("SELECT id, status FROM threads WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids)) as { id: string; status: string | null }[];
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  /** True when `messageId` is a message of `channelId`. */
  isInChannel(messageId: string, channelId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?").get(messageId, channelId));
  }

  latestSeq(channelId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE channel_id = ?").get(
      channelId,
    ) as { n: number };
    return row.n;
  }
}
