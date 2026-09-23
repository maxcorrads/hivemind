import { attachmentIdsSchema, memberNamesSchema, validated } from "../../shared/api-contract.ts";
import { parseMentions } from "../../shared/mentions.ts";
import {
  BODY_MAX,
  FILES_PER_MESSAGE,
  MESSAGE_EVENT_TYPES,
  REACTION_EMOJIS,
  HiveError,
  HUMAN_ID,
  type Agent,
  type Message,
  type Thread,
  type ThreadStatus,
} from "../../shared/types.ts";
import type { AdaptiveTopologyRuntime } from "../adaptive-topology.ts";
import type { DecisionStore } from "../decisions.ts";
import type { RoomStore } from "../rooms.ts";
import type { SendRequests } from "../send-requests.ts";
import type { TaskStore } from "../tasks.ts";
import type { TimelineStore } from "../timeline.ts";
import { channelLabel, type ChannelService } from "./channels.ts";
import type { DeliveryService } from "./delivery.ts";
import type { FileService } from "./files.ts";
import type { MessageQueries } from "./message-queries.ts";
import type { AgentDirectory, Core, MessagePoster, PostMessageInput } from "./ports.ts";
import { now } from "./rows.ts";

export type MessageServiceDeps = Core & {
  readonly identity: AgentDirectory & { touch(agentId: string, online?: boolean): void };
  readonly channels: Pick<ChannelService, "getChannel" | "canSeeChannel" | "canPost" | "addMember" | "openDm">;
  readonly messageQueries: Pick<MessageQueries, "getMessageById" | "getMessageBySeq" | "decorate">;
  readonly files: Pick<FileService, "validateAttachments" | "bindAttachments">;
  readonly delivery: Pick<DeliveryService, "wakeMembers">;
  /** Idempotent send receipts (requestId). */
  readonly sendRequests: SendRequests;
  readonly rooms: Pick<RoomStore, "peek">;
  readonly tasks: Pick<TaskStore, "has">;
  readonly timeline: Pick<TimelineStore, "prepare" | "recordMessage" | "source">;
  readonly decisions: Pick<DecisionStore, "replyRecipientNames" | "captureHumanReply">;
  readonly adaptiveTopology: Pick<AdaptiveTopologyRuntime, "humanMessageCommitted" | "threadStatusChange">;
};

/**
 * The message write path: posting (with idempotent request IDs, recipients,
 * attachments and trace provenance), adaptive requests, system notices,
 * thread status, clear_context control messages and reactions.
 */
export class MessageService implements MessagePoster {
  /** Messages committed from Telegram in this process (provenance is also stored durably). */
  private readonly telegramOrigin = new Set<string>();

  constructor(private readonly deps: MessageServiceDeps) {}

  private get db() { return this.deps.storage.db; }

  postMessage(
    actor: Agent,
    input: PostMessageInput,
    persistReceipt?: (message: Message) => void,
  ): Message {
    if (input.attachmentIds !== undefined) validated(attachmentIdsSchema, input.attachmentIds);
    const decisionRecipients = actor.role === 'human' ? this.deps.decisions?.replyRecipientNames(input.threadId ?? null) ?? [] : [];
    const recipientNames = [...new Set([...(input.recipients ?? []), ...decisionRecipients])];
    if (recipientNames.length) validated(memberNamesSchema.min(1), recipientNames);
    if (input.eventType !== undefined && !MESSAGE_EVENT_TYPES.includes(input.eventType))
      throw new HiveError(400, "Unknown message eventType");
    const ch = this.deps.channels.getChannel(input.channel, actor.projectId);
    if (!this.deps.channels.canSeeChannel(actor, ch) || !this.deps.channels.canPost(actor, ch)) {
      throw new HiveError(403, `You cannot post to ${channelLabel(ch)}`);
    }
    if (actor.role !== 'human' && this.deps.rooms.peek(ch.id)?.state === 'archived' &&
      (!input.threadId || !this.deps.tasks.has(input.threadId)))
      throw new HiveError(409, 'Archived room: no new work or root messages; use an existing task thread for closure');
    if (recipientNames.length > 32 || recipientNames.some(name => typeof name !== 'string')) throw new HiveError(400, 'Provide 1–32 recipient names');
    const recipients = [...new Set(recipientNames.map(name => {
      const target = this.deps.identity.getAgentByName(name);
      if (!target || target.role === 'bot' || !this.deps.channels.canSeeChannel(target, ch) ||
        (actor.role === 'worker' && target.role === 'human')) throw new HiveError(403, 'Recipient must be an accessible permitted person');
      return target.id;
    }))];
    if (typeof input.body !== "string") throw new HiveError(400, "Expected a string body");
    const body = input.body.trim();
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length > FILES_PER_MESSAGE) {
      throw new HiveError(400, `At most ${FILES_PER_MESSAGE} files per message`);
    }
    if (!body && input.kind !== "control" && attachmentIds.length === 0) {
      throw new HiveError(400, "Empty message");
    }
    if (input.kind !== "control" && body.length > BODY_MAX) {
      throw new HiveError(400, `Message too long (${body.length} > ${BODY_MAX}). Split or use a thread.`);
    }
    const mentions = parseMentions(body, this.deps.identity.listAgents(actor));
    if (actor.role === "worker" && mentions.some((id) => id === HUMAN_ID)) {
      throw new HiveError(403, "Workers cannot mention @Human. Ask a brain.");
    }
    if (input.threadId) {
      const root = this.db.prepare("SELECT id, channel_id FROM messages WHERE id = ?").get(input.threadId) as
        | { id: string; channel_id: string }
        | undefined;
      if (!root || root.channel_id !== ch.id) throw new HiveError(400, "Thread not in this channel");
    }
    const trace = this.deps.timeline.prepare(actor, ch, { traceId: input.traceId, causeMessageId: input.causeMessageId }, input.threadId ?? null);
    const id = crypto.randomUUID();
    const t = now();
    const kind = input.kind ?? "chat";
    if (kind === "system" && actor.role !== "human") {
      throw new HiveError(403, "Only Human can post system messages");
    }
    if (kind === "control") {
      if (actor.role === "worker") throw new HiveError(403, "Only a brain or Human can send control");
      if (input.control && input.control !== "clear_context") {
        throw new HiveError(400, "Unknown control action");
      }
    }

    // Validate the complete attachment set before any mutation. The transaction
    // below then owns every remaining database write caused by the send.
    return this.deps.storage.transaction(() => {
      if (input.requestId !== undefined) return this.deps.sendRequests.run(actor.id, ch.projectId, input.requestId,
        [ch.id, body, input.threadId ?? null, kind, input.control ?? null, input.source ?? "hive",
          input.eventType ?? null, attachmentIds, [...recipients].sort(), trace.traceId, trace.causeMessageId],
        () => this.postMessage(actor, { ...input, requestId: undefined }, persistReceipt), id => this.deps.messageQueries.getMessageById(id));
      if (attachmentIds.length) this.deps.files.validateAttachments(actor, attachmentIds);
      if (actor.role === "human" && !ch.memberIds.includes(actor.id)) {
        this.deps.channels.addMember(ch.id, actor.id);
        ch.memberIds.push(actor.id);
      }
      this.db.prepare(
        `INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, control, mentions, created_at, event_type, recipients)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, ch.id, input.threadId ?? null, actor.id, body, kind,
        input.control ?? null, JSON.stringify(mentions), t, input.eventType ?? null, JSON.stringify(recipients));
      this.deps.timeline.recordMessage(id, { source: input.source ?? 'hive', traceId: trace.traceId, causeMessageId: trace.causeMessageId });
      if (input.threadId) {
        this.db.prepare(
          `INSERT OR IGNORE INTO threads (id, channel_id, status) VALUES (?, ?, 'open')`,
        ).run(input.threadId, ch.id);
      }
      if (attachmentIds.length) this.deps.files.bindAttachments(id, attachmentIds);
      // Transport receipts participate in the same message/attachment transaction.
      persistReceipt?.(this.deps.messageQueries.getMessageById(id));
      this.deps.identity.touch(actor.id, true);
      const msg = this.deps.messageQueries.getMessageById(id);
      const decision = actor.role === 'human' ? this.deps.decisions?.captureHumanReply(actor, msg, input.source ?? 'hive') ?? null : null;
      this.deps.storage.afterCommit(() => {
        if (input.source === "telegram") this.telegramOrigin.add(msg.id);
        this.deps.adaptiveTopology?.humanMessageCommitted(msg);
        this.deps.bus.emit("message", msg);
        this.deps.delivery.wakeMembers(ch, msg);
        if (decision) this.deps.bus.emit('decision', decision);
      });
      return msg;
    });
  }

  hasActiveSendRequest(actor: Agent, channelRef: string, requestId: string | undefined): boolean {
    if (!requestId) return false;
    const channel = this.deps.channels.getChannel(channelRef, actor.projectId);
    const row = this.db.prepare(`SELECT 1 AS found FROM send_requests
      WHERE actor_id=? AND project_id=? AND request_id=? AND expires_at>?`)
      .get(actor.id, channel.projectId, requestId, Date.now()) as { found: number } | undefined;
    return Boolean(row?.found);
  }

  postAdaptiveRequest(
    actor: Agent,
    input: {
      channel: string;
      body: string;
      requestId?: string;
      threadId?: string | null;
      eventType?: Message["eventType"];
      traceId?: string;
      causeMessageId?: string;
      attachmentIds?: string[];
      recipients?: string[];
      source?: "hive" | "telegram";
    },
    directives: Array<{ body: string; requestId: string; recipients?: string[] }>,
    persistReceipt?: (message: Message) => void,
    persistRouting?: (message: Message) => void,
  ): { message: Message; routingMessages: Message[] } {
    return this.deps.storage.transaction(() => {
      // One directive per owning brain, in the request's thread, immediately before the request.
      const routingMessages = directives.map(directive => this.postMessage(actor, {
        channel: input.channel,
        body: directive.body,
        requestId: directive.requestId,
        threadId: input.threadId ?? null,
        recipients: directive.recipients,
        eventType: "assignment",
      }));
      const message = this.postMessage(actor, input, persistReceipt);
      persistRouting?.(message);
      return { message, routingMessages };
    });
  }

  fromTelegram(messageId: string): boolean {
    return this.telegramOrigin.has(messageId) || this.deps.timeline.source(messageId) === 'telegram';
  }

  postSystem(channelId: string, body: string) {
    const human = this.deps.identity.getAgent(HUMAN_ID);
    try {
      this.postMessage(human, { channel: channelId, body, kind: "system" });
    } catch {
      // bootstrap edge
    }
  }

  setThreadStatus(actor: Agent, threadId: string, status: ThreadStatus | null): Thread {
    if (this.deps.tasks.has(threadId)) throw new HiveError(409, 'Use structured task events; generic thread status cannot change a task');
    if (actor.role === "bot") throw new HiveError(403, "Bots cannot change thread status");
    const row = this.db.prepare(
      `SELECT m.id, m.channel_id FROM messages m WHERE m.id = ?`,
    ).get(threadId) as { id: string; channel_id: string } | undefined;
    if (!row) throw new HiveError(404, "Thread not found");
    if (status !== null && !["open", "in_progress", "blocked", "done"].includes(status)) {
      throw new HiveError(400, "Invalid thread status");
    }
    const ch = this.deps.channels.getChannel(row.channel_id);
    if (!this.deps.channels.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access thread");
    const commitments = this.db.prepare('SELECT execution_id FROM adaptive_topology_messages WHERE root_id=?').all(threadId);
    if (commitments.length) {
      if (actor.role !== 'human' && actor.id !== this.deps.messageQueries.getMessageById(threadId).authorId)
        throw new HiveError(403, 'Only Human or the delegating brain can close adaptive delegated work');
      if (this.db.prepare('SELECT status FROM threads WHERE id=?').get(threadId)?.status === 'done' && status !== 'done')
        throw new HiveError(409, 'Start a new guarded assignment instead of reopening completed adaptive work');
    }
    return this.deps.storage.transaction(() => {
      const routingChanged = this.deps.adaptiveTopology?.threadStatusChange(actor, threadId, status);
      this.db.prepare(`INSERT INTO threads (id, channel_id, status) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status`).run(threadId, row.channel_id, status);
      const thread = this.db.prepare('SELECT id, channel_id AS channelId, status FROM threads WHERE id=?').get(threadId) as Thread;
      this.deps.storage.afterCommit(() => { this.deps.bus.emit('thread', thread); routingChanged?.(); });
      return thread;
    });
  }

  clearContext(actor: Agent, targetName: string): Message {
    if (actor.role === "worker") throw new HiveError(403, "Only a brain or Human can clear context");
    const target = this.deps.identity.getAgentByName(targetName);
    if (!target) throw new HiveError(404, `No agent named ${targetName}`);
    if (target.role !== "worker") throw new HiveError(400, "clear_context is for workers");
    const dm = this.deps.channels.openDm(actor, target.name);
    return this.postMessage(actor, {
      channel: dm.id,
      body: `CONTROL clear_context: before following this request, use get_handoffs and save a checkpoint for relevant active tasks where possible (task_event checkpoint with the current revision). Then discard prior task memory, keeping your Hivemind identity (${target.name}) and standing orders, and wait. This is an instruction only: Hivemind has not erased host context or stopped execution. Do not clear automatically after every result.`,
      kind: "control",
      control: "clear_context",
    });
  }

  /** Publish only after the structured event and its message commit atomically. */
  publishTaskMessage(message: Message) {
    this.deps.bus.emit('message', message);
    this.deps.delivery.wakeMembers(this.deps.channels.getChannel(message.channelId), message);
  }

  toggleReaction(actor: Agent, seq: number, emoji: string): { message: Message; added: boolean } {
    return this.setReaction(actor, seq, emoji);
  }

  /** Omitted present retains legacy toggle; retryable clients use explicit state. */
  setReaction(actor: Agent, seq: number, emoji: string, present?: boolean): { message: Message; added: boolean } {
    if (!Number.isSafeInteger(seq) || seq < 1 || !REACTION_EMOJIS.includes(emoji as (typeof REACTION_EMOJIS)[number]) ||
      (present !== undefined && typeof present !== "boolean")) throw new HiveError(400, "Invalid reaction");
    return this.deps.storage.transaction(() => {
      const msg = this.deps.messageQueries.getMessageBySeq(seq), ch = this.deps.channels.getChannel(msg.channelId);
      if (!this.deps.channels.canSeeChannel(actor, ch) || !this.deps.channels.canPost(actor, ch)) throw new HiveError(403, "Cannot react here");
      const had = Boolean(this.db.prepare('SELECT 1 FROM reactions WHERE message_id=? AND agent_id=? AND emoji=?').get(msg.id, actor.id, emoji));
      const wanted = present ?? !had;
      if (had !== wanted) {
        if (wanted) this.db.prepare('INSERT INTO reactions(message_id,agent_id,emoji,created_at) VALUES(?,?,?,?)').run(msg.id, actor.id, emoji, now());
        else this.db.prepare('DELETE FROM reactions WHERE message_id=? AND agent_id=? AND emoji=?').run(msg.id, actor.id, emoji);
        const forUi = this.deps.messageQueries.decorate([msg], HUMAN_ID)[0]!;
        this.deps.storage.afterCommit(() => this.deps.bus.emit("reaction", { seq: msg.seq, message: forUi }));
      }
      return { message: this.deps.messageQueries.decorate([msg], actor.id)[0]!, added: wanted };
    });
  }
}
