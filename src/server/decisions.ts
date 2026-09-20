import { createHash } from 'node:crypto';
import type { Hive } from './hive.ts';
import { HiveError, type Agent, type Message } from '../shared/types.ts';
import {
  decisionAnswerSchema, decisionBody, decisionEventSchema, requestDecisionSchema,
  type DecisionDeliveryState, type DecisionPage, type DecisionSnapshot, type DecisionView,
} from '../shared/decisions.ts';

type DecisionRow = { id: string; snapshot: string };
type MutationRow = { decision_id: string; message_id: string | null; request_hash: string };

export class DecisionStore {
  constructor(private hive: Hive, private atomic: <T>(work: () => T) => T) {
    hive.db.exec(`CREATE TABLE IF NOT EXISTS decision_requests (
      id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      UNIQUE(requester_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS decision_project_created ON decision_requests(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS decision_task_created ON decision_requests(task_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_mutations (
      actor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      decision_id TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
      request_hash TEXT NOT NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      PRIMARY KEY(actor_id, request_id)
    );`);
  }

  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private row(id: string): DecisionRow {
    const row = this.hive.db.prepare('SELECT id, snapshot FROM decision_requests WHERE id = ?').get(id) as DecisionRow | undefined;
    if (!row) throw new HiveError(404, 'Decision request not found');
    return row;
  }
  private snapshot(id: string): DecisionSnapshot { return JSON.parse(this.row(id).snapshot) as DecisionSnapshot; }
  has(id: string) { return Boolean(this.hive.db.prepare('SELECT 1 FROM decision_requests WHERE id = ?').get(id)); }
  private save(snapshot: DecisionSnapshot) {
    this.hive.db.prepare('UPDATE decision_requests SET snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), snapshot.id);
  }
  private visible(actor: Agent, snapshot: DecisionSnapshot) {
    if (actor.role === 'bot' || !this.hive.canSeeChannel(actor, this.hive.getChannel(snapshot.channelId)))
      throw new HiveError(403, 'Cannot read this decision');
    return snapshot;
  }
  private projected(snapshot: DecisionSnapshot) {
    const task = this.hive.tasks.get(this.hive.getAgent('human'), snapshot.taskId);
    if (snapshot.storedState !== 'awaiting_input')
      return { state: snapshot.storedState, currentTaskRevision: task.revision, staleReason: null } as const;
    if (task.revision !== snapshot.taskRevision)
      return { state: 'superseded' as const, currentTaskRevision: task.revision, staleReason: 'task_changed' as const };
    if (snapshot.requestedByAt !== null && Date.now() >= snapshot.requestedByAt)
      return { state: 'expired' as const, currentTaskRevision: task.revision, staleReason: 'deadline_passed' as const };
    return { state: 'awaiting_input' as const, currentTaskRevision: task.revision, staleReason: null };
  }
  private delivery(agentId: string, seq: number): DecisionDeliveryState {
    const rows = this.hive.db.prepare(`SELECT acknowledged_at FROM inbox_deliveries d
      WHERE d.agent_id = ? AND EXISTS (SELECT 1 FROM json_each(d.seqs) WHERE CAST(value AS INTEGER) = ?)
      ORDER BY acknowledged_at IS NOT NULL DESC LIMIT 1`).all(agentId, seq) as Array<{ acknowledged_at: number | null }>;
    if (!rows.length) return 'pending';
    return rows[0]!.acknowledged_at === null ? 'offered' : 'acknowledged';
  }
  private view(actor: Agent, snapshot: DecisionSnapshot): DecisionView {
    this.visible(actor, snapshot);
    const projection = this.projected(snapshot);
    const recipients = [{ id: snapshot.requesterId, name: snapshot.requesterName }, ...snapshot.affectedWorkers]
      .filter((value, index, all) => all.findIndex(other => other.id === value.id) === index);
    return {
      ...snapshot,
      ...projection,
      delivery: snapshot.answer ? recipients.map(person => ({
        agentId: person.id, name: person.name, state: this.delivery(person.id, snapshot.answer!.seq),
      })) : [],
      warning: projection.state === 'awaiting_input'
        ? 'Human input is advisory to the current task revision; answering does not complete, assign or execute the task.'
        : projection.state === 'superseded'
          ? 'This request is stale or explicitly superseded. Replies remain history and do not apply to the changed task.'
          : projection.state === 'expired'
            ? 'The requested-by time passed. No recommendation was applied automatically.'
            : 'Delivery receipts confirm transport only, not task acceptance or completion.',
    };
  }

  get(actor: Agent, id: string) { return this.view(actor, this.snapshot(id)); }

  forTask(actor: Agent, taskId: string) {
    this.hive.tasks.get(actor, taskId);
    const rows = this.hive.db.prepare('SELECT id, snapshot FROM decision_requests WHERE task_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(taskId) as DecisionRow[];
    return rows.map(row => this.view(actor, JSON.parse(row.snapshot) as DecisionSnapshot));
  }

  listHuman(actor: Agent, projectId: string, includeClosed = true): DecisionPage {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human has the decision queue');
    const now = Date.now();
    const open = `json_extract(d.snapshot, '$.storedState') = 'awaiting_input'
      AND CAST(json_extract(d.snapshot, '$.taskRevision') AS INTEGER) = CAST(json_extract(t.snapshot, '$.revision') AS INTEGER)
      AND (json_extract(d.snapshot, '$.requestedByAt') IS NULL OR CAST(json_extract(d.snapshot, '$.requestedByAt') AS INTEGER) > ?)`;
    const awaiting = Number(this.hive.db.prepare(`SELECT COUNT(*) AS n FROM decision_requests d
      JOIN task_records t ON t.id = d.task_id WHERE d.project_id = ? AND ${open}`).get(projectId, now)!.n);
    const openRows = this.hive.db.prepare(`SELECT d.id, d.snapshot FROM decision_requests d
      JOIN task_records t ON t.id = d.task_id WHERE d.project_id = ? AND ${open}
      ORDER BY COALESCE(CAST(json_extract(d.snapshot, '$.requestedByAt') AS INTEGER), 9223372036854775807),
        d.created_at ASC LIMIT 100`).all(projectId, now) as DecisionRow[];
    const remaining = includeClosed ? Math.max(0, 100 - openRows.length) : 0;
    const closedRows = remaining ? this.hive.db.prepare(`SELECT d.id, d.snapshot FROM decision_requests d
      JOIN task_records t ON t.id = d.task_id WHERE d.project_id = ? AND NOT (${open})
      ORDER BY CAST(json_extract(d.snapshot, '$.updatedAt') AS INTEGER) DESC, d.created_at DESC LIMIT ?`)
      .all(projectId, now, remaining) as DecisionRow[] : [];
    const items = [...openRows, ...closedRows].map(row => this.view(actor, JSON.parse(row.snapshot) as DecisionSnapshot));
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
    const previous = this.hive.db.prepare('SELECT id, request_hash FROM decision_requests WHERE requester_id = ? AND request_id = ?')
      .get(actor.id, input.requestId) as { id: string; request_hash: string } | undefined;
    if (previous) {
      if (previous.request_hash !== requestHash) throw new HiveError(409, 'requestId was already used for another decision request');
      return { decision: this.get(actor, previous.id), message: this.hive.getMessageById(previous.id), duplicate: true };
    }

    let created!: DecisionSnapshot, superseded: DecisionView | null = null;
    const message = this.atomic(() => {
      const task = this.hive.tasks.get(actor, input.taskId);
      if (task.assignerId !== actor.id) throw new HiveError(403, 'Only the assigning brain can request a decision for this task');
      if (task.revision !== input.expectedTaskRevision) throw new HiveError(409, 'Task changed; reread before requesting a decision');
      const channel = this.hive.getChannel(task.channelId);
      for (const seq of input.evidenceSeqs) this.hive.getVisibleMessage(actor, seq);
      const affectedWorkers = input.affectedWorkers.map(name => {
        const worker = this.hive.getAgentByName(name);
        if (!worker || worker.role !== 'worker' || worker.projectId !== actor.projectId ||
          !this.hive.canSeeChannel(worker, channel) || !this.hive.canPost(worker, channel))
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
      const root = this.hive.postMessage(actor, {
        channel: task.channelId, body: decisionBody(input, actor.name), eventType: 'question', recipients: ['Human'],
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
      this.hive.db.prepare(`INSERT INTO decision_requests
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
    this.hive.bus.emit('decision', decision);
    if (superseded) this.hive.bus.emit('decision', superseded);
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
    const projection = this.projected(snapshot);
    if (projection.state !== 'awaiting_input') return this.view(actor, snapshot);
    snapshot.storedState = 'answered'; snapshot.revision += 1; snapshot.updatedAt = message.createdAt;
    snapshot.answer = { messageId: message.id, seq: message.seq, body: message.body, at: message.createdAt,
      source };
    this.save(snapshot);
    return this.view(actor, snapshot);
  }

  private retry(actor: Agent, requestId: string, hash: string) {
    const old = this.hive.db.prepare('SELECT decision_id, message_id, request_hash FROM decision_mutations WHERE actor_id = ? AND request_id = ?')
      .get(actor.id, requestId) as MutationRow | undefined;
    if (!old) return null;
    if (old.request_hash !== hash) throw new HiveError(409, 'requestId was already used for another decision mutation');
    return { decision: this.get(actor, old.decision_id), message: old.message_id ? this.hive.getMessageById(old.message_id) : null, duplicate: true };
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
      message = this.hive.postMessage(actor, { channel: decision.channelId, threadId: id, body: input.body, eventType: 'decision' });
      const applied = this.get(actor, id);
      if (applied.state !== 'answered' || applied.answer?.messageId !== message.id) throw new HiveError(409, 'Decision changed while answering');
      this.hive.db.prepare('INSERT INTO decision_mutations VALUES (?, ?, ?, ?, ?)').run(actor.id, input.requestId, id, mutationHash, message.id);
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
      message = this.hive.postMessage(actor, { channel: decision.channelId, threadId: id,
        body: `Decision request withdrawn: ${input.action.reason}`, eventType: 'decision', recipients: ['Human'] });
      const snapshot = this.snapshot(id), now = Date.now();
      snapshot.storedState = 'withdrawn'; snapshot.revision += 1; snapshot.updatedAt = now;
      snapshot.withdrawn = { reason: input.action.reason, at: now }; this.save(snapshot);
      this.hive.db.prepare('INSERT INTO decision_mutations VALUES (?, ?, ?, ?, ?)').run(actor.id, input.requestId, id, mutationHash, message.id);
    });
    const decision = this.get(actor, id); this.hive.bus.emit('decision', decision);
    return { decision, message, duplicate: false };
  }
}
