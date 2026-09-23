import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { HiveError } from "../shared/types.ts";
import { Storage } from "./storage.ts";
import type { ReadStamp } from "../shared/read-state.ts";

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

  page(actorId: string, channelIds: string[], limit = 30, beforeSeq?: number, projectId?: string) {
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      throw new HiveError(400, "beforeSeq must be a positive safe integer");
    }
    const cap = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.trunc(limit))) : 30;
    const q = this.scope(actorId, channelIds, projectId);
    let where = `${q.where} AND (EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value = ?))`;
    q.params.push(actorId, actorId);
    if (beforeSeq !== undefined) {
      where += " AND m.seq < ?";
      q.params.push(beforeSeq);
    }
    const rows = this.db.prepare(`SELECT m.id ${q.from} WHERE ${where} ORDER BY m.seq DESC LIMIT ?`)
      .all(...q.params, cap + 1) as { id: string }[];
    return { ids: rows.slice(0, cap).map((row) => row.id), hasMore: rows.length > cap };
  }

  counts(actorId: string, channelIds: string[]) {
    const q = this.scope(actorId, channelIds);
    const rows = this.db.prepare(`SELECT m.channel_id AS id, COUNT(*) AS n
      ${q.from} WHERE ${q.where} GROUP BY m.channel_id`).all(...q.params) as { id: string; n: number }[];
    return { ...Object.fromEntries(channelIds.map((id) => [id, 0])), ...Object.fromEntries(rows.map((r) => [r.id, r.n])) };
  }

  mentionCounts(actorId: string, channelIds: string[]) {
    const q = this.scope(actorId, channelIds);
    const rows = this.db.prepare(`SELECT c.project_id AS id, COUNT(*) AS n ${q.from}
      WHERE ${q.where} AND (EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value = ?))
      GROUP BY c.project_id`).all(...q.params, actorId, actorId) as { id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }

  markMentions(actorId: string, channelIds: string[], projectId?: string) {
    const q = this.scope(actorId, channelIds, projectId);
    this.db.prepare(`INSERT OR IGNORE INTO message_reads (agent_id, message_id)
      SELECT ?, m.id ${q.from} WHERE ${q.where}
      AND (EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value = ?))`)
      .run(actorId, ...q.params, actorId, actorId);
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
