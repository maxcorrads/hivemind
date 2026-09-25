import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { HiveError, HUMAN_ID } from "../shared/types.ts";
import { Storage } from "./storage.ts";
import type { ActivityReason, ReadStamp } from "../shared/read-state.ts";

export type FeedOptions = {
  projectId?: string;
  /** Only unread rows (default for `feed`); false also returns read ones (Activity). */
  unreadOnly?: boolean;
  /** Only these reasons; empty or omitted means every reason. */
  reasons?: readonly ActivityReason[];
  beforeSeq?: number;
  limit?: number;
  /** Classify this single message (realtime Activity). */
  messageId?: string;
};
type FeedRow = { id: string; channel_id: string; reason: ActivityReason; read: number };

/** Explicit seen-message receipts complement, but never reinterpret, legacy reads. */
export class ReadState {
  private readonly instance = randomUUID();
  constructor(private readonly db: DatabaseSync) {}

  /** Writes read receipts atomically (IMMEDIATE when outermost). */
  atomic<T>(run: () => T): T {
    return Storage.for(this.db).transaction(run);
  }

  /** One consistent read snapshot (DEFERRED when outermost: takes no write lock). */
  snapshot<T>(run: () => T): T {
    return Storage.for(this.db).transaction(run, { immediate: false });
  }

  stamp(): ReadStamp {
    return {
      readInstance: this.instance,
      readRevision: Number(this.db.prepare("SELECT revision FROM ui_read_revision WHERE singleton = 1").get()!.revision),
      // AUTOINCREMENT's high-water mark does not move backwards on deletion.
      readSeq: Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get()?.seq ?? 0),
    };
  }

  private scope(actorId: string, channelIds: string[], projectId?: string) {
    const params: SQLInputValue[] = [actorId, actorId, ...channelIds, actorId];
    let where = `m.channel_id IN (${channelIds.map(() => "?").join(",") || "NULL"})
      AND m.author_id != ?
      AND m.seq > COALESCE(r.last_read_seq, 0) AND seen.message_id IS NULL`;
    if (projectId !== undefined) {
      where += " AND c.project_id = ?";
      params.push(projectId);
    }
    return {
      from: `FROM messages m JOIN channels c ON c.id = m.channel_id
        LEFT JOIN reads r ON r.agent_id = ? AND r.channel_id = m.channel_id
        LEFT JOIN message_reads seen ON seen.agent_id = ? AND seen.message_id = m.id`,
      where,
      params,
    };
  }

  /**
   * Why `m` (in channel `c`) is For you, as a SQL expression that is NULL when it is
   * not. The unread badge, the Unread tab, "mark all read" and the Activity feed all
   * use this one definition, so they cannot disagree. The reader's own messages are
   * never For you, except the Human's replies in a decision thread (their answers).
   */
  private reason(actorId: string) {
    const decision = actorId === HUMAN_ID
      ? "WHEN EXISTS (SELECT 1 FROM decision_requests d WHERE d.id = COALESCE(m.thread_id, m.id)) THEN 'decision'" : "";
    return {
      sql: `CASE ${decision}
        WHEN m.author_id = ? THEN NULL
        WHEN EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value = ?)
          AND EXISTS (SELECT 1 FROM task_events te WHERE te.message_id = m.id) THEN 'task'
        WHEN c.type = 'dm' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = m.channel_id AND cm.agent_id = ?) THEN 'direct'
        WHEN EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?)
          OR EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value = ?) THEN 'mention'
        WHEN m.thread_id IS NOT NULL AND (EXISTS (SELECT 1 FROM messages p WHERE p.id = m.thread_id AND p.author_id = ?)
          OR EXISTS (SELECT 1 FROM messages p WHERE p.thread_id = m.thread_id AND p.author_id = ? AND p.seq < m.seq)) THEN 'thread'
      END`,
      params: Array<SQLInputValue>(7).fill(actorId),
    };
  }

  /** For you rows of the visible channels, newest first; `unreadOnly` applies the same unread test as `counts`. */
  private forYou(actorId: string, channelIds: string[], options: FeedOptions) {
    const reason = this.reason(actorId);
    const params: SQLInputValue[] = [...reason.params, actorId, actorId, actorId, ...channelIds];
    let where = `m.channel_id IN (${channelIds.map(() => "?").join(",") || "NULL"})`;
    if (options.unreadOnly) {
      where += " AND m.author_id != ? AND m.seq > COALESCE(r.last_read_seq, 0) AND seen.message_id IS NULL";
      params.push(actorId);
    }
    if (options.projectId !== undefined) { where += " AND c.project_id = ?"; params.push(options.projectId); }
    if (options.beforeSeq !== undefined) { where += " AND m.seq < ?"; params.push(options.beforeSeq); }
    if (options.messageId !== undefined) { where += " AND m.id = ?"; params.push(options.messageId); }
    let outer = "reason IS NOT NULL";
    if (options.reasons?.length) {
      outer += ` AND reason IN (${options.reasons.map(() => "?").join(",")})`;
      params.push(...options.reasons);
    }
    return {
      sql: `SELECT * FROM (SELECT m.id, m.seq, m.channel_id, c.project_id, ${reason.sql} AS reason,
          (m.author_id = ? OR m.seq <= COALESCE(r.last_read_seq, 0) OR seen.message_id IS NOT NULL) AS read
        FROM messages m JOIN channels c ON c.id = m.channel_id
          LEFT JOIN reads r ON r.agent_id = ? AND r.channel_id = m.channel_id
          LEFT JOIN message_reads seen ON seen.agent_id = ? AND seen.message_id = m.id
        WHERE ${where}) WHERE ${outer}`,
      params,
    };
  }

  /** One newest-first page of For you (only unread rows unless `unreadOnly` is false). */
  feed(actorId: string, channelIds: string[], options: FeedOptions = {}) {
    const beforeSeq = options.beforeSeq, limit = options.limit ?? 30;
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      throw new HiveError(400, "beforeSeq must be a positive safe integer");
    }
    const cap = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.trunc(limit))) : 30;
    const q = this.forYou(actorId, channelIds, { ...options, unreadOnly: options.unreadOnly !== false });
    const rows = this.db.prepare(`${q.sql} ORDER BY seq DESC LIMIT ?`).all(...q.params, cap + 1) as FeedRow[];
    return {
      rows: rows.slice(0, cap).map((row) => ({ id: row.id, channelId: row.channel_id, reason: row.reason, read: Boolean(row.read) })),
      hasMore: rows.length > cap,
    };
  }

  page(actorId: string, channelIds: string[], limit = 30, beforeSeq?: number, projectId?: string) {
    const page = this.feed(actorId, channelIds, { limit, beforeSeq, projectId });
    return { ids: page.rows.map((row) => row.id), hasMore: page.hasMore };
  }

  latestUnread(actorId: string, channelId: string) {
    const q = this.scope(actorId, [channelId]);
    const row = this.db.prepare(`SELECT m.seq, m.thread_id AS threadId
      ${q.from} WHERE ${q.where} ORDER BY m.seq DESC LIMIT 1`).get(...q.params) as
      { seq: number; threadId: string | null } | undefined;
    return row ? { channelId, seq: row.seq, threadId: row.threadId } : null;
  }

  counts(actorId: string, channelIds: string[]) {
    const q = this.scope(actorId, channelIds);
    const rows = this.db.prepare(`SELECT m.channel_id AS id, COUNT(*) AS n
      ${q.from} WHERE ${q.where} GROUP BY m.channel_id`).all(...q.params) as { id: string; n: number }[];
    return { ...Object.fromEntries(channelIds.map((id) => [id, 0])), ...Object.fromEntries(rows.map((r) => [r.id, r.n])) };
  }

  /** Unread For you rows per project id: exactly what the Unread tab lists. */
  mentionCounts(actorId: string, channelIds: string[]) {
    const q = this.forYou(actorId, channelIds, { unreadOnly: true });
    const rows = this.db.prepare(`SELECT project_id AS id, COUNT(*) AS n FROM (${q.sql}) GROUP BY project_id`)
      .all(...q.params) as { id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }

  /** Marks every unread For you row read (the Unread tab's "Mark all read"). */
  markMentions(actorId: string, channelIds: string[], projectId?: string) {
    const q = this.forYou(actorId, channelIds, { unreadOnly: true, projectId });
    this.db.prepare(`INSERT OR IGNORE INTO message_reads (agent_id, message_id) SELECT ?, id FROM (${q.sql})`)
      .run(actorId, ...q.params);
  }

  markMessages(actorId: string, channelId: string, seqs: number[], threadId: string | null) {
    if (!Array.isArray(seqs) || seqs.length < 1 || seqs.length > 200 ||
      seqs.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) {
      throw new HiveError(400, "messageSeqs must contain 1 to 200 positive safe integers");
    }
    const unique = [...new Set(seqs)];
    this.atomic(() => {
      const rows = this.db.prepare(`SELECT id, thread_id FROM messages WHERE channel_id = ?
        AND seq IN (${unique.map(() => "?").join(",")})`).all(channelId, ...unique) as { id: string; thread_id: string | null }[];
      if (rows.length !== unique.length || rows.some((row) =>
        threadId ? row.id !== threadId && row.thread_id !== threadId : row.thread_id !== null)) {
        throw new HiveError(400, "Messages must belong to the selected channel/thread");
      }
      const insert = this.db.prepare("INSERT OR IGNORE INTO message_reads (agent_id, message_id) VALUES (?, ?)");
      for (const row of rows) insert.run(actorId, row.id);
    });
  }
}
