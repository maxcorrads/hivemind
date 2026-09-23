import { HiveError, type Agent } from "../../shared/types.ts";
import type { MentionPage, ReadSnapshot } from "../../shared/read-state.ts";
import type { ReadState } from "../read-state.ts";
import type { ChannelService } from "./channels.ts";
import type { MessageQueries } from "./message-queries.ts";
import type { AgentDirectory, Core } from "./ports.ts";

export type ReadServiceDeps = Core & {
  readonly readState: ReadState;
  readonly channels: Pick<ChannelService, "listChannels" | "getChannel" | "canSeeChannel">;
  readonly reader: Pick<MessageQueries, "loadMessagesByIds">;
  readonly agents: AgentDirectory;
};

/** Per-reader state: channel read cursors, explicit message receipts, unread counts and the mention inbox. */
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
    this.deps.agents.getAgent(actor.id);
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

  markMentionsSeen(actor: Agent, projectId?: string) {
    this.deps.readState.markMentions(actor.id, this.deps.channels.listChannels(actor).map((channel) => channel.id), projectId);
  }

  mentionInbox(actor: Agent, limit = 30, beforeSeq?: number, projectId?: string): MentionPage {
    return this.deps.readState.snapshot(() => {
      const page = this.deps.readState.page(actor.id, this.deps.channels.listChannels(actor).map((channel) => channel.id), limit, beforeSeq, projectId);
      return { messages: this.deps.reader.loadMessagesByIds(page.ids, actor.id), hasMore: page.hasMore, ...this.deps.readState.stamp() };
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
        mentions: this.deps.reader.loadMessagesByIds(page.ids, actor.id),
        mentionsHasMore: page.hasMore,
        mentionCounts: Object.fromEntries(channels.map((channel) => [channel.project, counts[channel.projectId] ?? 0])),
      };
    });
  }
}
