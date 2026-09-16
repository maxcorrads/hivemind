import type { DatabaseSync } from "node:sqlite";
import {
  BODY_MAX, FILES_PER_MESSAGE, WAIT_MAIL_CAP, WAIT_MAX_BYTES, WAIT_SCAN_MAX, WAIT_URGENT_RESERVE,
  HiveError, type Agent, type AttachmentMeta, type BotEvent, type InboxDelivery,
  type InboxPage, type Message, type QueueEstimate, type WaitResult,
} from "../shared/types.ts";
import { InboxDeliveryStore, INBOX_BATCH_MAX } from "./inbox-delivery.ts";
import { packWait, waitWireBytes } from "./wait-format.ts";

type Header = { seq: number; channel_id: string; addressed: number; urgent: number };
type Window = { rows: Header[]; through: number; end: boolean };

/** Only headers cross the scan boundary. Bodies and files are read after admission checks. */
export class InboxReader {
  constructor(private db: DatabaseSync, private receipts: InboxDeliveryStore) {}

  private cursor(actor: Agent): number {
    return Number(this.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(actor.id)!.inbox_cursor);
  }

  private highwater(): number {
    return Number(this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages").get()!.n);
  }

  private headers(actor: Agent, source: string, params: (string | number)[]): Header[] {
    // MATERIALIZED is important: filtering on visibility before LIMIT would scan an
    // unbounded backlog of other projects/public chatter. No channel-ID IN list.
    return this.db.prepare(`WITH scanned AS MATERIALIZED (${source}), classified AS (
      SELECT m.seq, m.channel_id, m.author_id, m.kind, c.type,
        c.project_id = ? AND (c.type != 'brains' OR ? = 'brain') AND
          EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = m.channel_id AND cm.agent_id = ?) AS visible,
        EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ?) AS mentioned,
        EXISTS (SELECT 1 FROM inbox_early_receipts r WHERE r.agent_id = ? AND r.seq = m.seq) AS received
      FROM scanned m LEFT JOIN channels c ON c.id = m.channel_id)
      SELECT seq, channel_id,
        visible AND author_id != ? AND NOT received AND
          (mentioned OR kind = 'control' OR type IN ('dm', 'private', 'brains')) AS addressed,
        mentioned OR kind = 'control' AS urgent
      FROM classified ORDER BY seq`).all(...params, actor.projectId ?? "", actor.role,
        actor.id, actor.id, actor.id, actor.id) as Header[];
  }

  private scan(actor: Agent, cursor: number, limit = WAIT_SCAN_MAX): Window {
    const rows = this.headers(actor,
      "SELECT seq, channel_id, author_id, kind, mentions FROM messages WHERE seq > ? ORDER BY seq LIMIT ?",
      [cursor, limit]);
    const through = rows.at(-1)?.seq ?? cursor;
    return { rows, through, end: through >= this.highwater() };
  }

  estimate(actor: Agent): QueueEstimate {
    const pending = this.receipts.pending(actor.id);
    const reserved = new Set<number>(pending ? JSON.parse(pending.seqs) : []);
    const window = this.scan(actor, this.cursor(actor));
    return { atLeast: window.rows.filter(r => r.addressed && !reserved.has(r.seq)).length, exact: window.end };
  }

  private label(id: string): string {
    const ch = this.db.prepare(`SELECT substr(name, 1, 200) AS name,
      substr(name, 201, 1) != '' AS shortened, type FROM channels WHERE id = ?`).get(id)!;
    return `${ch.type === "dm" ? "" : "#"}${ch.name}${ch.shortened ? "…" : ""}`;
  }

  private hydrate(seq: number): Message {
    const row = this.db.prepare(`SELECT m.id, m.seq, m.channel_id, m.thread_id, m.author_id,
      substr(CAST(m.body AS BLOB), 1, ?) AS body, length(CAST(m.body AS BLOB)) AS body_bytes, m.kind, m.control,
      m.mentions, m.created_at, m.event_type, a.name AS author_name, a.role AS author_role
      FROM messages m LEFT JOIN agents a ON a.id = m.author_id WHERE m.seq = ?`).get(BODY_MAX * 3, seq)!;
    // SQLite's TEXT substr/length stop at NUL. Bound the byte read instead: UTF-8
    // needs at most three bytes per UTF-16 unit (our BODY_MAX convention). A
    // streaming decode drops an incomplete trailing code point from a clipped read.
    // SQLite substr on an empty BLOB can return NULL (attachment-only mail).
    const bodyBytes = (row.body ?? new Uint8Array()) as Uint8Array;
    const bodyClipped = Number(row.body_bytes) > bodyBytes.byteLength;
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bodyBytes, { stream: bodyClipped });
    // Current bot metadata is schema-bounded. Avoid materializing oversized
    // metadata left by another/older writer before applying the wire budget.
    const bot = this.db.prepare(`SELECT substr(metadata, 1, 16384) AS metadata,
      length(metadata) > 16384 AS oversized FROM bot_events WHERE message_id = ?`).get(row.id);
    const attachments = this.db.prepare(`SELECT id, name, mime, bytes FROM attachments
      WHERE message_id = ? ORDER BY id LIMIT ?`).all(row.id, FILES_PER_MESSAGE) as AttachmentMeta[];
    // Reactions are not necessary to deliver mail. History/UI retain them; don't
    // hydrate an unbounded list of reactors on this latency-sensitive path.
    const message: Message = {
      id: String(row.id), seq, channelId: String(row.channel_id), threadId: row.thread_id as string | null,
      authorId: String(row.author_id), authorName: String(row.author_name ?? "unknown"),
      authorRole: (row.author_role ?? "worker") as Message["authorRole"], body,
      kind: row.kind as Message["kind"], control: row.control as Message["control"],
      ...(row.event_type ? { eventType: row.event_type as Message["eventType"] } : {}),
      mentions: JSON.parse(String(row.mentions)), createdAt: Number(row.created_at), attachments,
      ...(bot ? { source: "bot" as const,
        ...(bot.oversized ? {} : { botEvent: JSON.parse(String(bot.metadata)) as BotEvent }) } : {}),
    };
    if (bodyClipped || message.body.length > BODY_MAX || bot?.oversized) {
      message.body = bot?.oversized
        ? "[Message metadata exceeds the wait budget. Read the original with history using recovery.]"
        : message.body.slice(0, BODY_MAX);
      // Do not split a surrogate pair at the character ceiling either.
      if (/[\uD800-\uDBFF]$/.test(message.body)) message.body = message.body.slice(0, -1);
      message.recovery = this.recovery(message);
    }
    return message;
  }

  private recovery(message: Message): NonNullable<Message["recovery"]> {
    // History without a thread returns the latest N items. A root's own ID (or
    // the reply's parent ID) selects the forward-ordered branch, so limit=1
    // recovers exactly this sequence even when newer messages have arrived.
    return { channel: message.channelId, threadId: message.threadId ?? message.id,
      since: message.seq - 1, limit: 1, meta: false };
  }

  take(actor: Agent, sessionId: string, compact: boolean, scanLimit = WAIT_SCAN_MAX): WaitResult {
    this.receipts.requireSession(actor.id, sessionId);
    const acknowledged = this.cursor(actor);
    const pending = this.receipts.pending(actor.id);
    let window: Window;
    if (pending) {
      const seqs: number[] = JSON.parse(pending.seqs);
      // Another request may have offered a batch while this long poll slept.
      // If the residual budget cannot inspect it, leave the receipt untouched
      // and let the next wait replay it with a fresh full budget.
      if (seqs.length > scanLimit) return {
        ...packWait(actor, [], 0, compact, () => ""),
        page: { scannedRows: 0, hydratedMessages: 0, scanThroughSeq: acknowledged,
          acknowledgedThroughSeq: acknowledged, afterAckThroughSeq: acknowledged,
          continuation: true, remaining: { atLeast: 0, exact: false } },
      };
      // The receipt ledger already caps this list at 100. JSON keeps bind count
      // constant, including a pending batch written by the previous release.
      const rows = this.headers(actor, `SELECT seq, channel_id, author_id, kind, mentions FROM messages
        WHERE seq IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT ?`, [pending.seqs, INBOX_BATCH_MAX]);
      if (rows.length !== seqs.length || rows.some(r => !r.addressed))
        throw new HiveError(409, "Pending inbox message is no longer accessible");
      window = { rows, through: pending.through_seq, end: pending.through_seq >= this.highwater() };
    } else window = this.scan(actor, acknowledged, scanLimit);

    const addressed = window.rows.filter(r => r.addressed);
    const messages: Message[] = [];
    const admitted = new Set<number>();
    const channels = new Set<string>();
    const labels = new Map<string, string>();
    const label = (id: string) => {
      if (!labels.has(id)) labels.set(id, this.label(id));
      return labels.get(id)!;
    };
    let hydrated = 0;
    const maxMessages = actor.role === "brain" ? INBOX_BATCH_MAX : WAIT_MAIL_CAP;
    const ceiling = Number.MAX_SAFE_INTEGER;
    const budgetPage: InboxPage = { scannedRows: ceiling, hydratedMessages: ceiling, scanThroughSeq: ceiling,
      acknowledgedThroughSeq: ceiling, afterAckThroughSeq: ceiling, continuation: false,
      remaining: { atLeast: ceiling, exact: false } };
    const fits = (items: Message[]) => {
      const receipt: InboxDelivery = { id: "0".repeat(36), sessionId: "0".repeat(36),
        messageSeqs: items.map(m => m.seq), attempt: ceiling, offeredAt: ceiling, leaseExpiresAt: ceiling, redelivered: false };
      // Fit both wire formats so retrying via another client cannot enlarge a
      // previously offered receipt beyond the cap.
      return [false, true].every(format => waitWireBytes({
        ...packWait(actor, items, ceiling, format, label), delivery: receipt, page: budgetPage,
      }) <= WAIT_MAX_BYTES);
    };
    const add = (header: Header): boolean => {
      if (admitted.has(header.seq)) return true;
      if (messages.length >= maxMessages || (!channels.has(header.channel_id) && channels.size >= WAIT_MAIL_CAP)) return false;
      let message = this.hydrate(header.seq); hydrated++;
      if (!fits([...messages, message])) {
        if (messages.length) return false;
        // A single oversized legacy/control item must not permanently block the
        // inbox. Explicitly expose how to recover its original via history.
        message = { ...message, body: "[Message exceeds the wait budget. Read the original with history using recovery.]",
          attachments: [], botEvent: undefined, mentions: header.urgent ? [actor.id] : [],
          recovery: this.recovery(message) };
        if (!fits([message])) throw new HiveError(413, "Inbox item metadata exceeds the wait budget");
      }
      messages.push(message); admitted.add(header.seq); channels.add(header.channel_id);
      return true;
    };
    // Oldest first guarantees ordinary-mail progress. Reserve the next slots for
    // explicit mentions/control *inside this bounded window*, not a global search.
    if (addressed[0]) add(addressed[0]);
    const priority = addressed.filter(r => r.urgent && !admitted.has(r.seq)).slice(0, WAIT_URGENT_RESERVE);
    for (const header of priority) add(header);
    const attemptedPriority = new Set(priority.map(r => r.seq));
    for (const header of addressed) {
      if (admitted.has(header.seq) || attemptedPriority.has(header.seq)) continue;
      if (!add(header)) break;
    }
    messages.sort((a, b) => a.seq - b.seq);
    const firstOmitted = addressed.find(r => !admitted.has(r.seq));
    const through = Math.min(window.through, firstOmitted ? firstOmitted.seq - 1 : window.through);
    const remaining = { atLeast: addressed.length - messages.length, exact: window.end };
    const page: InboxPage = { scannedRows: window.rows.length, hydratedMessages: hydrated,
      scanThroughSeq: Math.max(window.through, window.rows.at(-1)?.seq ?? acknowledged),
      acknowledgedThroughSeq: acknowledged, afterAckThroughSeq: through,
      continuation: !remaining.exact || remaining.atLeast > 0, remaining };
    const packed = packWait(actor, messages, remaining.atLeast, compact, label);
    if (messages.length) {
      packed.delivery = this.receipts.offer(actor.id, sessionId, messages.map(m => m.seq), through, pending?.id);
    } else if (through > acknowledged) this.receipts.skipUnaddressed(actor.id, sessionId, through);
    packed.page = page;
    return packed;
  }
}
