import { createHash } from 'node:crypto';
import type { InboxDelivery, Agent, Channel, Message } from '../shared/types.ts';
import {
  TIMELINE_EVENT_LIMIT, TIMELINE_MAX_DELIVERY_ROWS, TIMELINE_MAX_PROVENANCE_ROWS, TIMELINE_RETENTION_MS,
  traceMetadataSchema, type RedactedTimelineEvent, type TimelineDeliveryEvent, type TimelineExport,
  type TimelineMessageEvent, type TimelineView,
} from '../shared/timeline.ts';
import { HiveError } from '../shared/types.ts';
import type { TimelineHost } from './services/ports.ts';

type ProvenanceRow = {
  message_id: string; trace_id: string; parent_message_id: string | null; cause_message_id: string | null;
  source: 'hive' | 'telegram' | 'bot'; created_at: number;
};
type DeliveryRow = {
  delivery_id: string; agent_id: string; message_seq: number; wake_reason: string;
  offered_at: number; last_offered_at: number; acknowledged_at: number | null; attempt: number;
};

export class TimelineStore {
  constructor(private hive: TimelineHost) {
    this.prune();
  }

  prepare(actor: Agent, channel: Channel, raw: { traceId?: unknown; causeMessageId?: unknown }, threadId: string | null) {
    const parsed = traceMetadataSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid trace metadata');
    const traceId = parsed.data.traceId ?? threadId ?? null;
    if (parsed.data.causeMessageId) {
      const cause = this.hive.getMessageById(parsed.data.causeMessageId);
      const causeChannel = this.hive.getChannel(cause.channelId);
      if (causeChannel.projectId !== channel.projectId || !this.hive.canSeeChannel(actor, causeChannel))
        throw new HiveError(403, 'Causal message must be visible in the same project');
    }
    return { traceId, causeMessageId: parsed.data.causeMessageId ?? null };
  }

  recordMessage(messageId: string, input: { source?: 'hive' | 'telegram' | 'bot'; traceId?: string | null; causeMessageId?: string | null } = {}) {
    const row = this.hive.storage.db.prepare('SELECT id, thread_id, created_at FROM messages WHERE id = ?').get(messageId) as
      { id: string; thread_id: string | null; created_at: number } | undefined;
    if (!row) throw new HiveError(404, 'Message not found');
    const traceId = input.traceId ?? row.thread_id ?? row.id;
    this.hive.storage.db.prepare(`INSERT INTO message_provenance(message_id, trace_id, parent_message_id, cause_message_id, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET
        trace_id=excluded.trace_id, parent_message_id=excluded.parent_message_id,
        cause_message_id=excluded.cause_message_id, source=excluded.source`)
      .run(messageId, traceId, row.thread_id, input.causeMessageId ?? null, input.source ?? 'hive', row.created_at);
  }

  private header(seq: number) {
    return this.hive.storage.db.prepare(`SELECT m.id, m.seq, m.channel_id, COALESCE(m.thread_id,m.id) AS root_id,
      m.author_id, m.kind, m.event_type, m.created_at, m.mentions, m.recipients,
      c.type, c.project_id, a.role AS author_role,
      EXISTS(SELECT 1 FROM task_events t WHERE t.message_id=m.id) AS task,
      EXISTS(SELECT 1 FROM attachments f WHERE f.message_id=m.id) AS evidence
      FROM messages m JOIN channels c ON c.id=m.channel_id LEFT JOIN agents a ON a.id=m.author_id
      WHERE m.seq=?`).get(seq) as Record<string, any> | undefined;
  }

  private wakeReason(actor: Agent, seq: number): string {
    const row = this.header(seq); if (!row) return 'missing';
    const mentions = JSON.parse(String(row.mentions)) as string[], recipients = JSON.parse(String(row.recipients)) as string[];
    if (row.kind === 'control') return 'control';
    if (recipients.includes(actor.id)) return 'targeted';
    if (mentions.includes(actor.id)) return 'mention';
    if (row.task) return 'task';
    const root = String(row.root_id), event = String(row.event_type ?? 'message');
    const subscription = this.hive.storage.db.prepare(`SELECT event_types FROM notification_subscriptions
      WHERE agent_id=? AND channel_id=? AND thread_id IN ('',?) ORDER BY length(thread_id) DESC LIMIT 1`)
      .get(actor.id, row.channel_id, root) as { event_types: string } | undefined;
    if (subscription && (JSON.parse(subscription.event_types) as string[]).includes(event)) return 'subscription:' + event;
    const room = row.author_role === 'bot' && actor.role === 'brain' ? this.hive.rooms.peek(String(row.channel_id)) : null;
    if (room?.state === 'active' && room.coordinatorId === actor.id) return 'room_coordinator';
    if (!recipients.length && !row.task && ['dm','private','brains'].includes(String(row.type))) return 'channel_default';
    return 'routed';
  }

  recordOffer(actor: Agent, delivery: InboxDelivery) {
    for (const seq of delivery.messageSeqs) {
      this.hive.storage.db.prepare(`INSERT INTO timeline_deliveries
        (delivery_id,agent_id,message_seq,wake_reason,offered_at,last_offered_at,acknowledged_at,attempt)
        VALUES (?,?,?,?,?,?,NULL,?) ON CONFLICT(delivery_id,agent_id,message_seq) DO UPDATE SET
          last_offered_at=excluded.last_offered_at, attempt=MAX(timeline_deliveries.attempt,excluded.attempt),
          wake_reason=excluded.wake_reason`)
        .run(delivery.id, actor.id, seq, this.wakeReason(actor, seq), delivery.offeredAt, delivery.offeredAt, delivery.attempt);
    }
  }

  recordAcknowledgement(actor: Agent, deliveryId: string, at: number) {
    this.hive.storage.db.prepare(`UPDATE timeline_deliveries SET acknowledged_at=COALESCE(acknowledged_at,?)
      WHERE delivery_id=? AND agent_id=?`).run(at, deliveryId, actor.id);
  }

  source(messageId: string): Message['source'] {
    const row = this.hive.storage.db.prepare('SELECT source FROM message_provenance WHERE message_id=?').get(messageId) as
      { source: 'hive'|'telegram'|'bot' } | undefined;
    return row?.source === 'hive' ? undefined : row?.source;
  }

  private references(envelope: any): TimelineMessageEvent['references'] {
    const action = envelope?.action;
    if (!action) return { evidenceSeqs: [], artifactCount: 0, checkCount: 0 };
    const source = action.result ?? action.checkpoint ?? action;
    const evidenceSeqs = Array.isArray(source.evidenceSeqs) ? source.evidenceSeqs.filter((n: unknown) => Number.isSafeInteger(n)) : [];
    return { evidenceSeqs: evidenceSeqs.slice(0, 50),
      artifactCount: Array.isArray(source.artifacts) ? source.artifacts.length : 0,
      checkCount: Array.isArray(source.checks) ? source.checks.length : 0 };
  }

  private taskAction(envelope: any): string | null {
    const action = envelope?.action; if (!action?.type) return null;
    return action.type === 'review' ? 'review:' + String(action.decision) : String(action.type);
  }

  traceForTask(actor: Agent, taskId: string): TimelineView {
    const task = this.hive.tasks.get(actor, taskId);
    return this.trace(actor, task.id, task.id);
  }

  trace(actor: Agent, traceId: string, taskId: string | null = null): TimelineView {
    if (taskId) this.hive.tasks.get(actor, taskId);
    const rows = this.hive.storage.db.prepare(`SELECT m.id,m.seq,m.channel_id,m.author_id,m.body,m.event_type,m.created_at,
      a.name AS author_name,a.role AS author_role,p.trace_id,p.parent_message_id,p.cause_message_id,p.source,
      te.envelope FROM messages m
      LEFT JOIN message_provenance p ON p.message_id=m.id
      LEFT JOIN agents a ON a.id=m.author_id LEFT JOIN task_events te ON te.message_id=m.id
      WHERE COALESCE(p.trace_id,COALESCE(m.thread_id,m.id))=?
      ORDER BY m.seq LIMIT ?`).all(traceId, TIMELINE_EVENT_LIMIT + 1) as Array<Record<string, any>>;
    const events: Array<TimelineMessageEvent | TimelineDeliveryEvent> = [];
    for (const row of rows.slice(0, TIMELINE_EVENT_LIMIT)) {
      const ch = this.hive.getChannel(String(row.channel_id));
      if (!this.hive.canSeeChannel(actor, ch)) continue;
      const body = Buffer.from(row.body ?? '').toString('utf8');
      const envelope = row.envelope ? JSON.parse(String(row.envelope)) : null;
      const provenance = row.trace_id ? row as unknown as ProvenanceRow : null;
      const cause = provenance?.cause_message_id ?? null, parent = provenance?.parent_message_id ?? null;
      const messageEvent: TimelineMessageEvent = {
        kind:'message', id:'message:'+row.id, at:Number(row.created_at), traceId, messageId:String(row.id), seq:Number(row.seq),
        authorId:String(row.author_id), authorName:String(row.author_name ?? 'unknown'),
        authorRole:String(row.author_role ?? 'unknown'), source:(provenance?.source ?? (this.hive.storage.db.prepare('SELECT 1 FROM bot_events WHERE message_id=?').get(row.id) ? 'bot' : 'hive')) as any,
        eventType:row.event_type ? String(row.event_type) : null, taskAction:this.taskAction(envelope),
        relation:cause ? { kind:'explicit', messageId:cause } : parent ? { kind:'inferred', messageId:parent } : null,
        bodyBytes:Buffer.byteLength(body), bodySha256:createHash('sha256').update(body).digest('hex'), references:this.references(envelope),
      };
      events.push(messageEvent);
      const deliveries = this.hive.storage.db.prepare(`SELECT d.*,a.name,a.role FROM timeline_deliveries d
        JOIN agents a ON a.id=d.agent_id WHERE d.message_seq=? ORDER BY d.offered_at,d.agent_id`).all(row.seq) as Array<DeliveryRow & {name:string;role:string}>;
      for (const d of deliveries) {
        events.push({ kind:'delivery', id:`delivery:${d.delivery_id}:${row.seq}:${d.agent_id}:offered`,
          at:d.offered_at, traceId, messageId:String(row.id), seq:Number(row.seq), agentId:d.agent_id, agentName:d.name,
          agentRole:d.role, stage:'offered', deliveryId:d.delivery_id, attempt:d.attempt, wakeReason:d.wake_reason });
        if (d.acknowledged_at != null) events.push({ kind:'delivery', id:`delivery:${d.delivery_id}:${row.seq}:${d.agent_id}:acknowledged`,
          at:d.acknowledged_at, traceId, messageId:String(row.id), seq:Number(row.seq), agentId:d.agent_id, agentName:d.name,
          agentRole:d.role, stage:'acknowledged', deliveryId:d.delivery_id, attempt:d.attempt, wakeReason:d.wake_reason });
      }
    }
    events.sort((a,b)=>a.at-b.at || (a.kind==='message' ? -1 : 1));
    return { traceId, taskId, events:events.slice(0,TIMELINE_EVENT_LIMIT), truncated:rows.length>TIMELINE_EVENT_LIMIT || events.length>TIMELINE_EVENT_LIMIT,
      warning:'Timeline is observability metadata. Explicit causes are caller-supplied references; inferred causes come from thread structure. It is not task authority or hidden model reasoning.' };
  }

  exportTask(actor: Agent, taskId: string): TimelineExport {
    const view = this.traceForTask(actor, taskId), aliases = new Map<string,string>(), counts = new Map<string,number>();
    const alias = (role: string, id: string) => {
      if (aliases.has(id)) return aliases.get(id)!;
      const n=(counts.get(role)??0)+1; counts.set(role,n); const value=role+'-'+n; aliases.set(id,value); return value;
    };
    const events: RedactedTimelineEvent[] = view.events.map(event => event.kind==='message'
      ? { ...event, actor:alias(event.authorRole,event.authorId), authorId:undefined, authorName:undefined, authorRole:undefined } as unknown as RedactedTimelineEvent
      : { ...event, actor:alias(event.agentRole,event.agentId), agentId:undefined, agentName:undefined, agentRole:undefined } as unknown as RedactedTimelineEvent);
    return { schemaVersion:1, mode:'fake-only', traceId:view.traceId, taskId:view.taskId, exportedAt:Date.now(), events,
      truncated:view.truncated, redaction:{ messageBodies:'sha256+byte-length-only', actorNames:'stable-role-aliases',
        secrets:'not-included', artifacts:'counts-and-evidence-seqs-only' } };
  }

  prune(now=Date.now()) {
    const cutoff=now-TIMELINE_RETENTION_MS;
    const active=`EXISTS (SELECT 1 FROM task_records t WHERE t.id=p.trace_id
      AND json_extract(t.snapshot,'$.state')!='accepted_complete')`;
    const old=this.hive.storage.db.prepare(`DELETE FROM message_provenance AS p WHERE created_at<? AND NOT ${active}`).run(cutoff).changes;
    const deliveryOld=this.hive.storage.db.prepare(`DELETE FROM timeline_deliveries WHERE last_offered_at<?
      AND message_seq NOT IN (SELECT m.seq FROM messages m JOIN message_provenance p ON p.message_id=m.id WHERE ${active})`).run(cutoff).changes;
    const provExcess=Number(this.hive.storage.db.prepare('SELECT MAX(COUNT(*)-?,0) AS n FROM message_provenance').get(TIMELINE_MAX_PROVENANCE_ROWS)!.n);
    if (provExcess>0) this.hive.storage.db.prepare(`DELETE FROM message_provenance WHERE message_id IN (
      SELECT p.message_id FROM message_provenance p WHERE NOT ${active} ORDER BY p.created_at LIMIT ?)`).run(provExcess);
    const delExcess=Number(this.hive.storage.db.prepare('SELECT MAX(COUNT(*)-?,0) AS n FROM timeline_deliveries').get(TIMELINE_MAX_DELIVERY_ROWS)!.n);
    if (delExcess>0) this.hive.storage.db.prepare(`DELETE FROM timeline_deliveries WHERE rowid IN (
      SELECT d.rowid FROM timeline_deliveries d LEFT JOIN messages m ON m.seq=d.message_seq
      LEFT JOIN message_provenance p ON p.message_id=m.id WHERE p.trace_id IS NULL OR NOT ${active}
      ORDER BY d.last_offered_at LIMIT ?)`).run(delExcess);
    return { provenanceDeleted:Number(old), deliveriesDeleted:Number(deliveryOld), provenanceExcessDeleted:provExcess, deliveryExcessDeleted:delExcess };
  }

  stats() {
    const provenance=Number(this.hive.storage.db.prepare('SELECT COUNT(*) AS n FROM message_provenance').get()!.n);
    const deliveries=Number(this.hive.storage.db.prepare('SELECT COUNT(*) AS n FROM timeline_deliveries').get()!.n);
    const logicalBytes=Number(this.hive.storage.db.prepare(`SELECT COALESCE(SUM(length(message_id)+length(trace_id)+
      COALESCE(length(parent_message_id),0)+COALESCE(length(cause_message_id),0)+length(source)+16),0) AS n FROM message_provenance`).get()!.n)
      + Number(this.hive.storage.db.prepare(`SELECT COALESCE(SUM(length(delivery_id)+length(agent_id)+length(wake_reason)+40),0) AS n FROM timeline_deliveries`).get()!.n);
    return { provenance, deliveries, logicalBytes, caps:{ provenance:TIMELINE_MAX_PROVENANCE_ROWS, deliveries:TIMELINE_MAX_DELIVERY_ROWS, eventsPerTrace:TIMELINE_EVENT_LIMIT } };
  }
}
