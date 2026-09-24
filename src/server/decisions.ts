import { createHash } from 'node:crypto';
import type { DecisionDeps } from './services/ports.ts';
import { HiveError, type Agent, type Channel, type Message } from '../shared/types.ts';
import { receiptKey } from './inbox-delivery.ts';
import {
  decisionAnswerSchema, decisionBody, decisionEventSchema, requestDecisionSchema,
  type DecisionDeliveryState, type DecisionPage, type DecisionSnapshot, type DecisionView,
} from '../shared/decisions.ts';

type DecisionRow = { id: string; snapshot: string };
type MutationRow = { decision_id: string; message_id: string | null; request_hash: string };

export class DecisionStore {
  constructor(private readonly deps: DecisionDeps, private atomic: <T>(work: () => T) => T) {}

  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private row(id: string): DecisionRow {
    const row = this.deps.storage.db.prepare('SELECT id, snapshot FROM decision_requests WHERE id = ?').get(id) as DecisionRow | undefined;
    if (!row) throw new HiveError(404, 'Decision request not found');
    return row;
  }
  private snapshot(id: string): DecisionSnapshot { return JSON.parse(this.row(id).snapshot) as DecisionSnapshot; }
  has(id: string) { return Boolean(this.deps.storage.db.prepare('SELECT 1 FROM decision_requests WHERE id = ?').get(id)); }
  private save(snapshot: DecisionSnapshot) {
    this.deps.storage.db.prepare('UPDATE decision_requests SET snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), snapshot.id);
  }
  /** Channel access per distinct channel of the batch (each channel is read once). */
  private visible(actor: Agent, snapshots: readonly DecisionSnapshot[]) {
    const channels = new Map<string, Channel>();
    for (const snapshot of snapshots) {
      let channel = channels.get(snapshot.channelId);
      if (!channel) channels.set(snapshot.channelId, channel = this.deps.channels.getChannel(snapshot.channelId));
      if (actor.role === 'bot' || !this.deps.channels.canSeeChannel(actor, channel)) throw new HiveError(403, 'Cannot read this decision');
    }
  }
  private projected(snapshot: DecisionSnapshot, revision: number | undefined) {
    if (revision === undefined) throw new HiveError(404, 'Task not found');
    if (snapshot.storedState !== 'awaiting_input')
      return { state: snapshot.storedState, currentTaskRevision: revision, staleReason: null } as const;
    if (revision !== snapshot.taskRevision)
      return { state: 'superseded' as const, currentTaskRevision: revision, staleReason: 'task_changed' as const };
    if (snapshot.requestedByAt !== null && Date.now() >= snapshot.requestedByAt)
      return { state: 'expired' as const, currentTaskRevision: revision, staleReason: 'deadline_passed' as const };
    return { state: 'awaiting_input' as const, currentTaskRevision: revision, staleReason: null };
  }
  private recipients(snapshot: DecisionSnapshot) {
    return [{ id: snapshot.requesterId, name: snapshot.requesterName }, ...snapshot.affectedWorkers]
      .filter((value, index, all) => all.findIndex(other => other.id === value.id) === index);
  }
  private view(actor: Agent, snapshot: DecisionSnapshot): DecisionView { return this.views(actor, [snapshot])[0]!; }
  /** Projects a batch with a constant number of statements: task revisions and receipts are read together. */
  private views(actor: Agent, snapshots: readonly DecisionSnapshot[]): DecisionView[] {
    if (!snapshots.length) return [];
    this.visible(actor, snapshots);
    const revisions = this.deps.tasks.revisions([...new Set(snapshots.map(snapshot => snapshot.taskId))]);
    const receipts = this.deps.inbox.receiptStates(snapshots.flatMap(snapshot => snapshot.answer
      ? this.recipients(snapshot).map(person => ({ agentId: person.id, seq: snapshot.answer!.seq })) : []));
    return snapshots.map(snapshot => {
      const projection = this.projected(snapshot, revisions.get(snapshot.taskId));
      return {
        ...snapshot,
        ...projection,
        delivery: snapshot.answer ? this.recipients(snapshot).map(person => ({
          agentId: person.id, name: person.name,
          state: receipts.get(receiptKey(person.id, snapshot.answer!.seq)) ?? 'pending' as DecisionDeliveryState,
        })) : [],
        warning: projection.state === 'awaiting_input'
          ? 'Human input is advisory to the current task revision; answering does not complete, assign or execute the task.'
          : projection.state === 'superseded'
            ? 'This request is stale or explicitly superseded. Replies remain history and do not apply to the changed task.'
            : projection.state === 'expired'
              ? 'The requested-by time passed. No recommendation was applied automatically.'
              : 'Delivery receipts confirm transport only, not task acceptance or completion.',
      };
    });
  }

  get(actor: Agent, id: string) { return this.view(actor, this.snapshot(id)); }

  forTask(actor: Agent, taskId: string) {
    this.deps.tasks.get(actor, taskId);
    const rows = this.deps.storage.db.prepare('SELECT id, snapshot FROM decision_requests WHERE task_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(taskId) as DecisionRow[];
    return this.views(actor, rows.map(row => JSON.parse(row.snapshot) as DecisionSnapshot));
  }

  listHuman(actor: Agent, projectId: string, includeClosed = true): DecisionPage {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human has the decision queue');
    const now = Date.now();
    const open = `json_extract(d.snapshot, '$.storedState') = 'awaiting_input'
      AND CAST(json_extract(d.snapshot, '$.taskRevision') AS INTEGER) = CAST(json_extract(t.snapshot, '$.revision') AS INTEGER)
      AND (json_extract(d.snapshot, '$.requestedByAt') IS NULL OR CAST(json_extract(d.snapshot, '$.requestedByAt') AS INTEGER) > ?)`;
    const awaiting = Number(this.deps.storage.db.prepare(`SELECT COUNT(*) AS n FROM decision_requests d
      JOIN task_records t ON t.id = d.task_id WHERE d.project_id = ? AND ${open}`).get(projectId, now)!.n);
    const openRows = this.deps.storage.db.prepare(`SELECT d.id, d.snapshot FROM decision_requests d
      JOIN task_records t ON t.id = d.task_id WHERE d.project_id = ? AND ${open}
      ORDER BY COALESCE(CAST(json_extract(d.snapshot, '$.requestedByAt') AS INTEGER), 9223372036854775807),
        d.created_at ASC LIMIT 100`).all(projectId, now) as DecisionRow[];
    const remaining = includeClosed ? Math.max(0, 100 - openRows.length) : 0;
    const closedRows = remaining ? this.deps.storage.db.prepare(`SELECT d.id, d.snapshot FROM decision_requests d
      JOIN task_records t ON t.id = d.task_id WHERE d.project_id = ? AND NOT (${open})
      ORDER BY CAST(json_extract(d.snapshot, '$.updatedAt') AS INTEGER) DESC, d.created_at DESC LIMIT ?`)
      .all(projectId, now, remaining) as DecisionRow[] : [];
    const items = this.views(actor, [...openRows, ...closedRows].map(row => JSON.parse(row.snapshot) as DecisionSnapshot));
    return { items, awaiting,
      warning: 'Shows up to 100 requests, always prioritizing currently applicable awaiting decisions. Recommendations are not authority and expired/stale requests never auto-apply.' };
  }

  private linked(actor: Agent, id: string) {
    const decision = this.get(actor, id);
    if (decision.projectId !== actor.projectId && actor.role !== 'human') throw new HiveError(403, 'Decision belongs to another project');
    return decision;
  }

  create(actor: Agent, raw: unknown) {
    if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain can request a Human decision');
    const parsed = requestDecisionSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid decision request: ' + parsed.error.message);
    const input = parsed.data, requestHash = this.hash(input);
    const previous = this.deps.storage.db.prepare('SELECT id, request_hash FROM decision_requests WHERE requester_id = ? AND request_id = ?')
      .get(actor.id, input.requestId) as { id: string; request_hash: string } | undefined;
    if (previous) {
      if (previous.request_hash !== requestHash) throw new HiveError(409, 'requestId was already used for another decision request');
      return { decision: this.get(actor, previous.id), message: this.deps.messageQueries.getMessageById(previous.id), duplicate: true };
    }

    let created!: DecisionSnapshot, superseded: DecisionView | null = null;
    const message = this.atomic(() => {
      const task = this.deps.tasks.get(actor, input.taskId);
      if (task.assignerId !== actor.id) throw new HiveError(403, 'Only the assigning brain can request a decision for this task');
      if (task.revision !== input.expectedTaskRevision) throw new HiveError(409, 'Task changed; reread before requesting a decision');
      const channel = this.deps.channels.getChannel(task.channelId);
      for (const seq of input.evidenceSeqs) this.deps.messageQueries.getVisibleMessage(actor, seq);
      const affectedWorkers = input.affectedWorkers.map(name => {
        const worker = this.deps.identity.getAgentByName(name);
        if (!worker || worker.role !== 'worker' || worker.projectId !== actor.projectId ||
          !this.deps.channels.canSeeChannel(worker, channel) || !this.deps.channels.canPost(worker, channel))
          throw new HiveError(400, `Affected worker ${name} must already have task-channel access`);
        return { id: worker.id, name: worker.name };
      });
      for (const id of input.relatedDecisionIds) {
        const related = this.linked(actor, id);
        if (related.id === input.supersedesDecisionId) throw new HiveError(400, 'Superseded decision is linked separately');
      }
      let old: DecisionView | null = null;
      if (input.supersedesDecisionId) {
        old = this.linked(actor, input.supersedesDecisionId);
        if (old.taskId !== task.id) throw new HiveError(400, 'Only a decision for the same task can be superseded');
        if (old.state !== 'awaiting_input') throw new HiveError(409, 'Only an awaiting decision can be explicitly superseded');
      }
      const root = this.deps.messages.postMessage(actor, {
        channel: task.channelId, body: decisionBody(input, actor.name), eventType: 'question', recipients: ['Human'],
        traceId: task.id, causeMessageId: task.id,
      });
      const now = Date.now();
      created = {
        id: root.id, projectId: channel.projectId, channelId: task.channelId, taskId: task.id, taskRevision: task.revision,
        requesterId: actor.id, requesterName: actor.name, revision: 1, storedState: 'awaiting_input',
        question: input.question, options: input.options, recommendation: input.recommendation,
        evidenceSeqs: input.evidenceSeqs, artifacts: input.artifacts, affectedWorkers,
        requestedByAt: input.requestedByAt ?? null, relatedDecisionIds: input.relatedDecisionIds,
        supersedesDecisionId: input.supersedesDecisionId ?? null, supersededByDecisionId: null,
        rootSeq: root.seq, createdAt: now, updatedAt: now, answer: null, withdrawn: null,
      };
      this.deps.storage.db.prepare(`INSERT INTO decision_requests
        (id, project_id, channel_id, task_id, requester_id, request_id, request_hash, created_at, snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(created.id, created.projectId, created.channelId, created.taskId, actor.id, input.requestId, requestHash, now, JSON.stringify(created));
      if (old) {
        const rawOld = this.snapshot(old.id);
        rawOld.storedState = 'superseded'; rawOld.supersededByDecisionId = created.id;
        rawOld.revision += 1; rawOld.updatedAt = now; this.save(rawOld);
        superseded = this.view(actor, rawOld);
      }
      return root;
    });
    const decision = this.view(actor, created);
    this.deps.bus.emit('decision', decision);
    if (superseded) this.deps.bus.emit('decision', superseded);
    return { decision, message, duplicate: false };
  }

  replyRecipientNames(threadId: string | null) {
    if (!threadId || !this.has(threadId)) return [];
    const snapshot = this.snapshot(threadId);
    return [...new Set([snapshot.requesterName, ...snapshot.affectedWorkers.map(worker => worker.name)])];
  }

  captureHumanReply(actor: Agent, message: Message, source: 'hive' | 'telegram' = 'hive'): DecisionView | null {
    if (actor.role !== 'human' || !message.threadId || !this.has(message.threadId)) return null;
    const snapshot = this.snapshot(message.threadId);
    if (snapshot.channelId !== message.channelId) return null;
    const projection = this.projected(snapshot, this.deps.tasks.revisions([snapshot.taskId]).get(snapshot.taskId));
    if (projection.state !== 'awaiting_input') return this.view(actor, snapshot);
    snapshot.storedState = 'answered'; snapshot.revision += 1; snapshot.updatedAt = message.createdAt;
    snapshot.answer = { messageId: message.id, seq: message.seq, body: message.body, at: message.createdAt,
      source };
    this.save(snapshot);
    return this.view(actor, snapshot);
  }

  private retry(actor: Agent, requestId: string, hash: string) {
    const old = this.deps.storage.db.prepare('SELECT decision_id, message_id, request_hash FROM decision_mutations WHERE actor_id = ? AND request_id = ?')
      .get(actor.id, requestId) as MutationRow | undefined;
    if (!old) return null;
    if (old.request_hash !== hash) throw new HiveError(409, 'requestId was already used for another decision mutation');
    return { decision: this.get(actor, old.decision_id), message: old.message_id ? this.deps.messageQueries.getMessageById(old.message_id) : null, duplicate: true };
  }

  answer(actor: Agent, id: string, raw: unknown) {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human can answer a decision request');
    const parsed = decisionAnswerSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid decision answer: ' + parsed.error.message);
    const input = parsed.data, mutationHash = this.hash({ id, input });
    const duplicate = this.retry(actor, input.requestId, mutationHash); if (duplicate) return duplicate;
    let message!: Message;
    this.atomic(() => {
      const decision = this.get(actor, id);
      if (decision.revision !== input.expectedRevision) throw new HiveError(409, 'Decision changed; reread before answering');
      if (decision.state !== 'awaiting_input') throw new HiveError(409, `Decision is ${decision.state}; reply may remain chat but cannot apply`);
      message = this.deps.messages.postMessage(actor, { channel: decision.channelId, threadId: id, body: input.body, eventType: 'decision' });
      const applied = this.get(actor, id);
      if (applied.state !== 'answered' || applied.answer?.messageId !== message.id) throw new HiveError(409, 'Decision changed while answering');
      this.deps.storage.db.prepare('INSERT INTO decision_mutations VALUES (?, ?, ?, ?, ?)').run(actor.id, input.requestId, id, mutationHash, message.id);
    });
    return { decision: this.get(actor, id), message, duplicate: false };
  }

  event(actor: Agent, id: string, raw: unknown) {
    if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain can withdraw its decision request');
    const parsed = decisionEventSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid decision event: ' + parsed.error.message);
    const input = parsed.data, mutationHash = this.hash({ id, input });
    const duplicate = this.retry(actor, input.requestId, mutationHash); if (duplicate) return duplicate;
    let message!: Message;
    this.atomic(() => {
      const decision = this.get(actor, id);
      if (decision.requesterId !== actor.id) throw new HiveError(403, 'Only the requesting brain can withdraw this decision');
      if (decision.revision !== input.expectedRevision) throw new HiveError(409, 'Decision changed; reread before withdrawing');
      if (decision.state !== 'awaiting_input') throw new HiveError(409, `Decision is already ${decision.state}`);
      message = this.deps.messages.postMessage(actor, { channel: decision.channelId, threadId: id,
        body: `Decision request withdrawn: ${input.action.reason}`, eventType: 'decision', recipients: ['Human'] });
      const snapshot = this.snapshot(id), now = Date.now();
      snapshot.storedState = 'withdrawn'; snapshot.revision += 1; snapshot.updatedAt = now;
      snapshot.withdrawn = { reason: input.action.reason, at: now }; this.save(snapshot);
      this.deps.storage.db.prepare('INSERT INTO decision_mutations VALUES (?, ?, ?, ?, ?)').run(actor.id, input.requestId, id, mutationHash, message.id);
    });
    const decision = this.get(actor, id); this.deps.bus.emit('decision', decision);
    return { decision, message, duplicate: false };
  }
}
