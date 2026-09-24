import { HiveError, HUMAN_ID, type Agent, type Channel, type Message } from "../../shared/types.ts";
import type { ActivityItem, ActivityPage, MentionPage, ReadSnapshot } from "../../shared/read-state.ts";
import type { FeedOptions, ReadState } from "../read-state.ts";
import type { ChannelService } from "./channels.ts";
import type { MessageQueries } from "./message-queries.ts";
import type { AgentDirectory, Core } from "./ports.ts";

export type ReadServiceDeps = Core & {
  readonly readState: ReadState;
  readonly channels: Pick<ChannelService, "listChannels" | "getChannel" | "canSeeChannel">;
  readonly messageQueries: Pick<MessageQueries, "loadMessagesByIds">;
  readonly identity: AgentDirectory;
};

/** Per-reader state: channel read cursors, explicit message receipts, unread counts and the For you feed. */
export class ReadService {
  constructor(private readonly deps: ReadServiceDeps) {}

  private get db() { return this.deps.storage.db; }

  markRead(actor: Agent, channelId: string, seq: number) {
    this.db.prepare(
      `INSERT INTO reads (agent_id, channel_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT(agent_id, channel_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`,
    ).run(actor.id, channelId, seq);
  }

  readsFor(actor: Agent): Record<string, number> {
    const rows = this.db.prepare("SELECT channel_id, last_read_seq FROM reads WHERE agent_id = ?").all(actor.id) as {
      channel_id: string;
      last_read_seq: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.channel_id, r.last_read_seq]));
  }

  unreadCounts(actor: Agent): Record<string, number> {
    return this.deps.readState.counts(actor.id, this.deps.channels.listChannels(actor).map((channel) => channel.id));
  }

  /** Explicit receipts for the rendered channel/thread page, not a global cursor. */
  markMessagesRead(actor: Agent, channelId: string, seqs: number[], threadId: string | null = null) {
    this.deps.identity.getAgent(actor.id);
    const channel = this.deps.channels.getChannel(channelId, actor.projectId);
    if (!this.deps.channels.canSeeChannel(actor, channel)) throw new HiveError(403, "Cannot read this channel");
    if (threadId !== null && (typeof threadId !== "string" || !threadId)) throw new HiveError(400, "Invalid thread ID");
    if (threadId !== null) {
      const root = this.db.prepare("SELECT channel_id, thread_id FROM messages WHERE id = ?").get(threadId) as
        { channel_id: string; thread_id: string | null } | undefined;
      if (!root || root.channel_id !== channel.id || root.thread_id !== null) throw new HiveError(400, "Thread must be a root in the selected channel");
    }
    this.deps.readState.markMessages(actor.id, channel.id, seqs, threadId);
  }

  /** Oldest unread root message of the channel, for the UI's "New messages" divider; null when all are read. */
  firstUnreadSeq(actor: Agent, channelId: string): number | null {
    const row = this.db.prepare(`SELECT MIN(m.seq) AS seq FROM messages m
      LEFT JOIN reads r ON r.agent_id = ? AND r.channel_id = m.channel_id
      LEFT JOIN message_reads seen ON seen.agent_id = ? AND seen.message_id = m.id
      WHERE m.channel_id = ? AND m.thread_id IS NULL AND m.author_id != ?
        AND m.seq > COALESCE(r.last_read_seq, 0) AND seen.message_id IS NULL`)
      .get(actor.id, actor.id, channelId, actor.id) as { seq: number | null } | undefined;
    return row?.seq ?? null;
  }

  /**
   * "Mark unread from here": root messages from `fromSeq` on become unread again. Thread replies keep
   * their read state, so a lowered channel cursor is backed by explicit receipts for replies it covered.
   */
  markUnreadFrom(actor: Agent, channelId: string, fromSeq: number) {
    const channel = this.deps.channels.getChannel(channelId, actor.projectId);
    if (!this.deps.channels.canSeeChannel(actor, channel)) throw new HiveError(403, "Cannot read this channel");
    const root = this.db.prepare("SELECT thread_id FROM messages WHERE channel_id = ? AND seq = ?").get(channel.id, fromSeq) as
      { thread_id: string | null } | undefined;
    if (!root || root.thread_id !== null) throw new HiveError(400, "Mark unread needs a root message of this channel");
    this.deps.readState.atomic(() => {
      const cursor = (this.db.prepare("SELECT last_read_seq FROM reads WHERE agent_id = ? AND channel_id = ?")
        .get(actor.id, channel.id) as { last_read_seq: number } | undefined)?.last_read_seq ?? 0;
      if (cursor >= fromSeq) {
        this.db.prepare(`INSERT OR IGNORE INTO message_reads (agent_id, message_id)
          SELECT ?, id FROM messages WHERE channel_id = ? AND thread_id IS NOT NULL AND seq >= ? AND seq <= ?`)
          .run(actor.id, channel.id, fromSeq, cursor);
        this.db.prepare("UPDATE reads SET last_read_seq = ? WHERE agent_id = ? AND channel_id = ?").run(fromSeq - 1, actor.id, channel.id);
      }
      this.db.prepare(`DELETE FROM message_reads WHERE agent_id = ? AND message_id IN
        (SELECT id FROM messages WHERE channel_id = ? AND thread_id IS NULL AND seq >= ?)`).run(actor.id, channel.id, fromSeq);
    });
  }

  markMentionsSeen(actor: Agent, projectId?: string) {
    this.deps.readState.markMentions(actor.id, this.deps.channels.listChannels(actor).map((channel) => channel.id), projectId);
  }

  mentionInbox(actor: Agent, limit = 30, beforeSeq?: number, projectId?: string): MentionPage {
    return this.deps.readState.snapshot(() => {
      const page = this.deps.readState.page(actor.id, this.deps.channels.listChannels(actor).map((channel) => channel.id), limit, beforeSeq, projectId);
      return { messages: this.deps.messageQueries.loadMessagesByIds(page.ids, actor.id), hasMore: page.hasMore, ...this.deps.readState.stamp() };
    });
  }

  /** One newest-first page of For you: every entry, or only unread ones (`unreadOnly`). */
  activity(actor: Agent, options: Omit<FeedOptions, "messageId"> = {}): ActivityPage {
    return this.deps.readState.snapshot(() => {
      const channels = this.deps.channels.listChannels(actor);
      const page = this.deps.readState.feed(actor.id, channels.map((channel) => channel.id), options);
      return { items: this.items(actor, channels, page.rows), hasMore: page.hasMore, ...this.deps.readState.stamp() };
    });
  }

  /** The For you entry for one committed message, or null when it is not For you. */
  activityItem(actor: Agent, message: Pick<Message, "id" | "channelId">): ActivityItem | null {
    const channel = this.deps.channels.getChannel(message.channelId);
    if (!this.deps.channels.canSeeChannel(actor, channel)) return null;
    const page = this.deps.readState.feed(actor.id, [channel.id], { messageId: message.id, unreadOnly: false, limit: 1 });
    return this.items(actor, [channel], page.rows)[0] ?? null;
  }

  /** Publishes `activity` when a committed message is in the Human's For you feed (a `message` listener). */
  publishActivity(message: Message) {
    let item: ActivityItem | null;
    // Listeners run after the sender's commit: a projection failure must never fail the send.
    try { item = this.activityItem(this.deps.identity.getAgent(HUMAN_ID), message); } catch { return; }
    if (item) this.deps.bus.emit("activity", item);
  }

  private items(actor: Agent, channels: Channel[], rows: ReturnType<ReadState["feed"]>["rows"]): ActivityItem[] {
    const projects = new Map(channels.map((channel) => [channel.id, channel.project]));
    const messages = new Map(this.deps.messageQueries.loadMessagesByIds(rows.map((row) => row.id), actor.id).map((m) => [m.id, m]));
    return rows.flatMap((row) => {
      const message = messages.get(row.id);
      return message ? [{ message, project: projects.get(row.channelId) ?? "", reason: row.reason, read: row.read }] : [];
    });
  }

  readSnapshot(actor: Agent): ReadSnapshot {
    return this.deps.readState.snapshot(() => {
      const channels = this.deps.channels.listChannels(actor);
      const ids = channels.map((channel) => channel.id);
      const page = this.deps.readState.page(actor.id, ids);
      const counts = this.deps.readState.mentionCounts(actor.id, ids);
      return {
        ...this.deps.readState.stamp(),
        unread: this.deps.readState.counts(actor.id, ids),
        mentions: this.deps.messageQueries.loadMessagesByIds(page.ids, actor.id),
        mentionsHasMore: page.hasMore,
        mentionCounts: Object.fromEntries(channels.map((channel) => [channel.project, counts[channel.projectId] ?? 0])),
      };
    });
  }
}
