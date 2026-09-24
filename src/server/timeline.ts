import { createHash } from 'node:crypto';
import type { InboxDelivery, Agent, Channel, Message } from '../shared/types.ts';
import {
  TIMELINE_EVENT_LIMIT, TIMELINE_MAX_DELIVERY_ROWS, TIMELINE_MAX_PROVENANCE_ROWS, TIMELINE_RETENTION_MS,
  traceMetadataSchema, type RedactedTimelineEvent, type TimelineDeliveryEvent, type TimelineExport,
  type TimelineMessageEvent, type TimelineView,
} from '../shared/timeline.ts';
import { agentLabel, HiveError } from '../shared/types.ts';
import type { TimelineDeps } from './services/ports.ts';

type ProvenanceRow = {
  message_id: string; trace_id: string; parent_message_id: string | null; cause_message_id: string | null;
  source: 'hive' | 'telegram' | 'bot'; created_at: number;
};
type DeliveryRow = {
  delivery_id: string; agent_id: string; message_seq: number; wake_reason: string;
  offered_at: number; last_offered_at: number; acknowledged_at: number | null; attempt: number;
};

export class TimelineStore {
  constructor(private readonly deps: TimelineDeps) {
    this.prune();
  }

  prepare(actor: Agent, channel: Channel, raw: { traceId?: unknown; causeMessageId?: unknown }, threadId: string | null) {
    const parsed = traceMetadataSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid trace metadata');
    const traceId = parsed.data.traceId ?? threadId ?? null;
    if (parsed.data.causeMessageId) {
      const cause = this.deps.messageQueries.getMessageById(parsed.data.causeMessageId);
      const causeChannel = this.deps.channels.getChannel(cause.channelId);
      if (causeChannel.projectId !== channel.projectId || !this.deps.channels.canSeeChannel(actor, causeChannel))
        throw new HiveError(403, 'Causal message must be visible in the same project');
    }
    return { traceId, causeMessageId: parsed.data.causeMessageId ?? null };
  }

  recordMessage(messageId: string, input: { source?: 'hive' | 'telegram' | 'bot'; traceId?: string | null; causeMessageId?: string | null } = {}) {
    const ref = this.deps.messageQueries.messageRef(messageId);
    if (!ref) throw new HiveError(404, 'Message not found');
    const row = { id: ref.id, thread_id: ref.threadId, created_at: ref.createdAt };
    const traceId = input.traceId ?? row.thread_id ?? row.id;
    this.deps.storage.db.prepare(`INSERT INTO message_provenance(message_id, trace_id, parent_message_id, cause_message_id, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET
        trace_id=excluded.trace_id, parent_message_id=excluded.parent_message_id,
        cause_message_id=excluded.cause_message_id, source=excluded.source`)
      .run(messageId, traceId, row.thread_id, input.causeMessageId ?? null, input.source ?? 'hive', row.created_at);
  }

  private wakeReason(actor: Agent, seq: number): string {
    const row = this.deps.messageQueries.wakeHeader(seq); if (!row) return 'missing';
    const mentions = JSON.parse(String(row.mentions)) as string[], recipients = JSON.parse(String(row.recipients)) as string[];
    if (row.kind === 'control') return 'control';
    if (recipients.includes(actor.id)) return 'targeted';
    if (mentions.includes(actor.id)) return 'mention';
    if (row.task) return 'task';
    const root = String(row.root_id), event = String(row.event_type ?? 'message');
    const subscribed = this.deps.notifications.subscribedEventTypes(actor.id, String(row.channel_id), root);
    if (subscribed?.includes(event)) return 'subscription:' + event;
    const room = row.author_role === 'bot' && actor.role === 'brain' ? this.deps.rooms.peek(String(row.channel_id)) : null;
    if (room?.state === 'active' && room.coordinatorId === actor.id) return 'room_coordinator';
    if (!recipients.length && !row.task && ['dm','private','brains'].includes(String(row.type))) return 'channel_default';
    return 'routed';
  }

  recordOffer(actor: Agent, delivery: InboxDelivery) {
    for (const seq of delivery.messageSeqs) {
      this.deps.storage.db.prepare(`INSERT INTO timeline_deliveries
        (delivery_id,agent_id,message_seq,wake_reason,offered_at,last_offered_at,acknowledged_at,attempt)
        VALUES (?,?,?,?,?,?,NULL,?) ON CONFLICT(delivery_id,agent_id,message_seq) DO UPDATE SET
          last_offered_at=excluded.last_offered_at, attempt=MAX(timeline_deliveries.attempt,excluded.attempt),
          wake_reason=excluded.wake_reason`)
        .run(delivery.id, actor.id, seq, this.wakeReason(actor, seq), delivery.offeredAt, delivery.offeredAt, delivery.attempt);
    }
  }

  recordAcknowledgement(actor: Agent, deliveryId: string, at: number) {
    this.deps.storage.db.prepare(`UPDATE timeline_deliveries SET acknowledged_at=COALESCE(acknowledged_at,?)
      WHERE delivery_id=? AND agent_id=?`).run(at, deliveryId, actor.id);
  }

  source(messageId: string): Message['source'] {
    const row = this.deps.storage.db.prepare('SELECT source FROM message_provenance WHERE message_id=?').get(messageId) as
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
    const task = this.deps.tasks.get(actor, taskId);
    return this.trace(actor, task.id, task.id);
  }

  trace(actor: Agent, traceId: string, taskId: string | null = null): TimelineView {
    if (taskId) this.deps.tasks.get(actor, taskId);
    const rows = this.deps.messageQueries.traceMessages(traceId, TIMELINE_EVENT_LIMIT + 1);
    const agents = new Map<string, Agent | null>();
    const agent = (id: string) => {
      if (!agents.has(id)) agents.set(id, this.deps.identity.findAgent(id));
      return agents.get(id)!;
    };
    const events: Array<TimelineMessageEvent | TimelineDeliveryEvent> = [];
    for (const row of rows.slice(0, TIMELINE_EVENT_LIMIT)) {
      const ch = this.deps.channels.getChannel(String(row.channel_id));
      if (!this.deps.channels.canSeeChannel(actor, ch)) continue;
      const body = Buffer.from(row.body ?? '').toString('utf8');
      const envelope = row.envelope ? JSON.parse(String(row.envelope)) : null;
      const provenance = row.trace_id ? row as unknown as ProvenanceRow : null;
      const cause = provenance?.cause_message_id ?? null, parent = provenance?.parent_message_id ?? null;
      const messageEvent: TimelineMessageEvent = {
        kind:'message', id:'message:'+row.id, at:Number(row.created_at), traceId, messageId:String(row.id), seq:Number(row.seq),
        authorId:String(row.author_id), authorName:String(row.author_name ?? 'unknown'),
        authorRole:String(row.author_role ?? 'unknown'), source:(provenance?.source ?? (this.deps.messageQueries.postedByBot(String(row.id)) ? 'bot' : 'hive')) as any,
        eventType:row.event_type ? String(row.event_type) : null, taskAction:this.taskAction(envelope),
        relation:cause ? { kind:'explicit', messageId:cause } : parent ? { kind:'inferred', messageId:parent } : null,
        bodyBytes:Buffer.byteLength(body), bodySha256:createHash('sha256').update(body).digest('hex'), references:this.references(envelope),
      };
      events.push(messageEvent);
      // Deliveries to agents removed since are dropped, as before.
      const deliveries = (this.deps.storage.db.prepare(`SELECT d.* FROM timeline_deliveries d
        WHERE d.message_seq=? ORDER BY d.offered_at,d.agent_id`).all(row.seq) as DeliveryRow[])
        .flatMap(d => { const a = agent(d.agent_id); return a ? [{ ...d, name: agentLabel(a), role: a.role }] : []; });
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
    const cutoff=now-TIMELINE_RETENTION_MS, db=this.deps.storage.db;
    // Provenance of an unfinished task's trace is kept, and so are the deliveries of its messages.
    const traces=(db.prepare('SELECT DISTINCT trace_id FROM message_provenance').all() as { trace_id: string }[]).map(row => row.trace_id);
    const activeTraces=JSON.stringify(this.deps.tasks.unfinished(traces));
    const active=`p.trace_id IN (SELECT value FROM json_each(?))`;
    const kept=(db.prepare(`SELECT p.message_id FROM message_provenance p WHERE ${active}`).all(activeTraces) as { message_id: string }[])
      .map(row => row.message_id);
    const keptSeqs=JSON.stringify(this.deps.messageQueries.seqsOf(kept));
    const old=db.prepare(`DELETE FROM message_provenance AS p WHERE created_at<? AND NOT ${active}`).run(cutoff, activeTraces).changes;
    const deliveryOld=db.prepare(`DELETE FROM timeline_deliveries WHERE last_offered_at<?
      AND message_seq NOT IN (SELECT value FROM json_each(?))`).run(cutoff, keptSeqs).changes;
    const provExcess=Number(db.prepare('SELECT MAX(COUNT(*)-?,0) AS n FROM message_provenance').get(TIMELINE_MAX_PROVENANCE_ROWS)!.n);
    if (provExcess>0) db.prepare(`DELETE FROM message_provenance WHERE message_id IN (
      SELECT p.message_id FROM message_provenance p WHERE NOT ${active} ORDER BY p.created_at LIMIT ?)`).run(activeTraces, provExcess);
    const delExcess=Number(db.prepare('SELECT MAX(COUNT(*)-?,0) AS n FROM timeline_deliveries').get(TIMELINE_MAX_DELIVERY_ROWS)!.n);
    if (delExcess>0) db.prepare(`DELETE FROM timeline_deliveries WHERE rowid IN (
      SELECT d.rowid FROM timeline_deliveries d WHERE d.message_seq NOT IN (SELECT value FROM json_each(?))
      ORDER BY d.last_offered_at LIMIT ?)`).run(keptSeqs, delExcess);
    return { provenanceDeleted:Number(old), deliveriesDeleted:Number(deliveryOld), provenanceExcessDeleted:provExcess, deliveryExcessDeleted:delExcess };
  }

  stats() {
    const provenance=Number(this.deps.storage.db.prepare('SELECT COUNT(*) AS n FROM message_provenance').get()!.n);
    const deliveries=Number(this.deps.storage.db.prepare('SELECT COUNT(*) AS n FROM timeline_deliveries').get()!.n);
    const logicalBytes=Number(this.deps.storage.db.prepare(`SELECT COALESCE(SUM(length(message_id)+length(trace_id)+
      COALESCE(length(parent_message_id),0)+COALESCE(length(cause_message_id),0)+length(source)+16),0) AS n FROM message_provenance`).get()!.n)
      + Number(this.deps.storage.db.prepare(`SELECT COALESCE(SUM(length(delivery_id)+length(agent_id)+length(wake_reason)+40),0) AS n FROM timeline_deliveries`).get()!.n);
    return { provenance, deliveries, logicalBytes, caps:{ provenance:TIMELINE_MAX_PROVENANCE_ROWS, deliveries:TIMELINE_MAX_DELIVERY_ROWS, eventsPerTrace:TIMELINE_EVENT_LIMIT } };
  }
}
