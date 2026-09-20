import { z } from 'zod';
import { TaskCoordination } from './task-coordination.ts';
import { claimActionSchema, claimPreviewSchema, isClaimAction } from '../shared/task-claims.ts';
import { validated } from '../shared/api-contract.ts';
import { checkpointFreshness, type HandoffSummary } from '../shared/handoffs.ts';
import { immediateTransaction } from './transaction.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Hive } from './hive.ts';
import { BODY_MAX, HiveError, type Agent, type Channel } from '../shared/types.ts';
import { assignTaskSchema, taskEventSchema, taskBody, type TaskContract, type TaskEnvelope, type TaskSnapshot } from '../shared/tasks.ts';

type Row = { id: string; channel_id: string; worker_id: string; dispatch_seq: number; received_at: number | null; snapshot: string };
type StoredEvent = { message_id: string; task_id: string; request_hash: string };

export class TaskStore {
  private coordination: TaskCoordination;
  constructor(private hive: Hive) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_records (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, worker_id TEXT NOT NULL,
      dispatch_seq INTEGER NOT NULL, received_at INTEGER, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_dispatch ON task_records(worker_id, dispatch_seq);
      CREATE INDEX IF NOT EXISTS task_channel ON task_records(channel_id);
      CREATE INDEX IF NOT EXISTS task_worker_handoff ON task_records(worker_id, id) WHERE json_extract(snapshot, '$.state') != 'accepted_complete';
      CREATE INDEX IF NOT EXISTS task_assigner_handoff ON task_records(json_extract(snapshot, '$.assignerId'), id) WHERE json_extract(snapshot, '$.state') != 'accepted_complete';
      CREATE TABLE IF NOT EXISTS task_events (
        message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, envelope TEXT NOT NULL,
        UNIQUE(actor_id, request_id));
      CREATE INDEX IF NOT EXISTS task_event_task ON task_events(task_id);
      CREATE TABLE IF NOT EXISTS task_request_aliases (actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
        PRIMARY KEY(actor_id, request_id));`);
    this.coordination = new TaskCoordination(hive);
  }
  private get db() { return this.hive.db; }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM task_records WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HiveError(404, 'Task not found');
    return row;
  }
  has(id: string) { return Boolean(this.db.prepare('SELECT 1 FROM task_records WHERE id = ?').get(id)); }
  get(actor: Agent, id: string): TaskSnapshot {
    const row = this.row(id);
    if (actor.role === 'bot' || !this.hive.canSeeChannel(actor, this.hive.getChannel(row.channel_id)))
      throw new HiveError(403, 'Cannot read this task');
    const task = JSON.parse(row.snapshot) as TaskSnapshot;
    return { ...task, room: this.hive.rooms.taskInfo(task), coordination: this.coordination.view(actor, task), receivedAt: row.received_at,
      state: task.state === 'sent' && row.received_at !== null ? 'delivered' : task.state };
  }
  previewClaim(actor: Agent, id: string, raw: unknown) {
    validated(z.string().uuid(), id);
    const task = this.get(actor, id);
    const { paths } = validated(claimPreviewSchema, raw);
    return this.coordination.preview(actor, task, paths);
  }
  handoff(actor: Agent, id: string) {
    validated(z.string().uuid(), id);
    const task = this.get(actor, id);
    const checkpoint = task.checkpoint ?? null;
    const newerMessages = checkpoint ? Boolean(this.db.prepare(
      'SELECT 1 FROM messages WHERE channel_id = ? AND thread_id = ? AND seq > ? LIMIT 1',
    ).get(task.channelId, task.id, checkpoint.messageSeq)) : false;
    const handoff = { taskId: task.id, channelId: task.channelId, workerId: task.workerId,
      objective: task.contract.objective, revision: task.revision, contractVersion: task.contractVersion,
      state: task.state, checkpoint, ...(task.claim ? { claim: task.claim, coordination: task.coordination } : {}), ...checkpointFreshness(task), newerMessages,
      warning: 'A saved report is not verified repository state. Later unsaved work may exist; inspect referenced evidence before acting.',
      expand: { tool: 'history', channel: task.channelId, threadId: task.id } };
    if (Buffer.byteLength(JSON.stringify(handoff)) > 32 * 1024) throw new HiveError(413, 'Legacy handoff exceeds budget; recover explicit messages from thread history');
    return handoff;
  }
  /** Participant-only, indexed, bounded discovery; never a global task roster. */
  handoffs(actor: Agent, before?: string) {
    if (actor.role !== 'brain' && actor.role !== 'worker') throw new HiveError(403, 'Only task participants have a resume inbox');
    if (before !== undefined) validated(z.string().uuid(), before);
    const participant = actor.role === 'worker' ? 'r.worker_id' : "json_extract(r.snapshot, '$.assignerId')";
    const rows = this.db.prepare(`SELECT r.id FROM task_records r
      JOIN channels c ON c.id = r.channel_id
      WHERE ${participant} = ? AND c.project_id = ?
        AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = r.channel_id AND cm.agent_id = ?)
        AND (? = 'brain' OR c.type != 'brains')
        AND json_extract(r.snapshot, '$.state') != 'accepted_complete'
        ${before ? 'AND r.id < ?' : ''}
      ORDER BY r.id DESC LIMIT 6`).all(actor.id, actor.projectId, actor.id, actor.role, ...(before ? [before] : [])) as { id: string }[];
    const page = rows.slice(0, 5);
    const items: HandoffSummary[] = page.map(row => {
      const task = this.get(actor, row.id);
      return { taskId: task.id, channelId: task.channelId, workerId: task.workerId,
        objective: task.contract.objective, revision: task.revision, contractVersion: task.contractVersion,
        checkpointVersion: task.checkpoint?.version ?? null,
        nextAction: task.checkpoint?.data.nextAction ?? null, state: task.state,
        ...checkpointFreshness(task) };
    });
    return { items, hasMore: rows.length > 5, nextCursor: rows.length > 5 ? page.at(-1)!.id : null,
      next: 'Read get_handoff for the current task before acting. An identity resume does not restore model memory or verify saved work.' };
  }
  private worker(actor: Agent, name: string) {
    const worker = this.hive.getAgentByName(name);
    if (!worker || worker.role !== 'worker' || worker.projectId !== actor.projectId)
      throw new HiveError(400, 'Choose a worker in your project');
    return worker;
  }
  private evidence(actor: Agent, sequences: number[]) {
    for (const seq of sequences) this.hive.getVisibleMessage(actor, seq);
  }
  private contract(actor: Agent, contract: TaskContract, taskId?: string) {
    this.evidence(actor, contract.evidenceSeqs);
    this.coordination.validateDependencies(actor, contract, taskId);
  }
  private writable(actor: Agent, worker: Agent, channel: Channel) {
    if (!this.hive.canSeeChannel(actor, channel) || !this.hive.canPost(actor, channel) ||
      !this.hive.canSeeChannel(worker, channel) || !this.hive.canPost(worker, channel))
      throw new HiveError(403, 'Both participants must already have access to the task channel');
  }
  private hash(input: unknown) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
  private retry(actor: Agent, requestId: string, hash: string) {
    const old = (this.db.prepare('SELECT message_id, task_id, request_hash FROM task_events WHERE actor_id = ? AND request_id = ?')
      .get(actor.id, requestId) ?? this.db.prepare('SELECT task_id AS message_id, task_id, request_hash FROM task_request_aliases WHERE actor_id=? AND request_id=?')
        .get(actor.id, requestId)) as StoredEvent | undefined;
    if (!old) return;
    const task = this.get(actor, old.task_id);
    if (old.request_hash !== hash) throw new HiveError(409, 'requestId was already used for a different task event');
    return { task, message: this.hive.getMessageById(old.message_id), duplicate: true };
  }
  private transaction<T>(f: () => T): T {
    return immediateTransaction(this.db, f);
  }
  private write(actor: Agent, task: TaskSnapshot, envelope: TaskEnvelope, requestId: string, hash: string, initial: boolean) {
    const body = taskBody(envelope);
    if (body.length > BODY_MAX || Buffer.byteLength(JSON.stringify(envelope)) > 16000)
      throw new HiveError(400, 'Task envelope is too large; use a compact contract and evidence references');
    const id = initial ? task.id : randomUUID();
    const target = ['assign', 'revise', 'review'].includes(envelope.action.type) ? task.workerId : task.assignerId;
    const now = Date.now();
    const recipients = JSON.stringify([...new Set([target, ...(envelope.previousWorkerId ? [envelope.previousWorkerId] : []),
      ...(isClaimAction(envelope.action.type) ? [task.assignerId, task.workerId] : [])])]);
    this.db.prepare(`INSERT INTO messages(id, channel_id, thread_id, author_id, body, kind, event_type, mentions, created_at, recipients)
      VALUES (?, ?, ?, ?, ?, 'chat', ?, ?, ?, ?)`)
      .run(id, task.channelId, initial ? null : task.id, actor.id, body,
        envelope.action.type === 'block' || envelope.action.type === 'reject' ? 'blocker' :
          envelope.action.type === 'assign' || envelope.action.type === 'revise' ? 'assignment' :
            envelope.action.type === 'review' ? 'decision' :
              envelope.action.type === 'accept' ? 'acknowledgement' :
                envelope.action.type === 'checkpoint' ? 'progress' : 'action_required',
        recipients, now, recipients);
    const seq = Number(this.db.prepare('SELECT seq FROM messages WHERE id = ?').get(id)!.seq);
    task.lastEventSeq = seq; task.updatedAt = now;
    if (envelope.action.type === 'checkpoint' && task.checkpoint) {
      task.checkpoint.messageId = id;
      task.checkpoint.messageSeq = seq;
    }
    if (initial || envelope.action.type === 'revise') { task.dispatchSeq = seq; task.receivedAt = null; }
    this.db.prepare(`INSERT INTO task_records(id, channel_id, worker_id, dispatch_seq, received_at, snapshot) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id, dispatch_seq=excluded.dispatch_seq,
        received_at=excluded.received_at, snapshot=excluded.snapshot`)
      .run(task.id, task.channelId, task.workerId, task.dispatchSeq, task.receivedAt, JSON.stringify(this.record(task)));
    this.db.prepare('INSERT INTO task_events(message_id, task_id, actor_id, request_id, request_hash, envelope) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, task.id, actor.id, requestId, hash, JSON.stringify(envelope));
    this.db.prepare('INSERT OR IGNORE INTO threads(id, channel_id, status) VALUES (?, ?, NULL)').run(task.id, task.channelId);
    return id;
  }
  private record(task: TaskSnapshot) {
    // Room metadata is a projection of the channel contract and current worker ACK,
    // not another task-owned state machine. Never persist that derived snapshot.
    const { room: _room, coordination: _coordination, ...record } = task;
    return record;
  }
  private published(actor: Agent, taskId: string, messageId: string) {
    const task = this.get(actor, taskId);
    const message = this.hive.getMessageById(messageId);
    this.hive.publishTaskMessage(message);
    this.hive.bus.emit('task', task);
    return { task, message, duplicate: false };
  }
  assign(actor: Agent, raw: unknown) {
    if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain can assign a structured task');
    const parsed = assignTaskSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid task assignment: ' + parsed.error.message);
    const input = parsed.data, hash = this.hash({ assign: input });
    let taskId = '', duplicate: ReturnType<TaskStore['retry']>;
    this.transaction(() => {
      duplicate = this.retry(actor, input.requestId, hash); if (duplicate) return;
      const worker = this.worker(actor, input.worker);
      this.contract(actor, input.contract);
      this.evidence(worker, input.contract.evidenceSeqs);
      const channel = input.channel ? this.hive.getChannel(input.channel, actor.projectId) : this.hive.openDm(actor, worker.name, true);
      this.writable(actor, worker, channel);
      const room = this.hive.rooms.assignment(actor, channel, worker, input);
      if (room?.existing) {
        this.db.prepare('INSERT INTO task_request_aliases(actor_id,request_id,request_hash,task_id) VALUES(?,?,?,?)')
          .run(actor.id, input.requestId, hash, room.existing);
        duplicate = { task: this.get(actor, room.existing), message: this.hive.getMessageById(room.existing), duplicate: true };
        return;
      }
      taskId = randomUUID();
      const task: TaskSnapshot = { id: taskId, channelId: channel.id, assignerId: actor.id, assignerName: actor.name,
        workerId: worker.id, workerName: worker.name, revision: 1, contractVersion: 1, state: 'sent', contract: input.contract,
        dispatchSeq: 0, receivedAt: null, lastEventSeq: 0, updatedAt: 0, result: null, review: null };
      this.write(actor, task, { taskId, channelId: channel.id, revision: 1, contractVersion: 1, actorId: actor.id,
        actorRole: 'brain', assignerId: actor.id, workerId: worker.id, action: { type: 'assign', contract: input.contract } }, input.requestId, hash, true);
      if (input.room && room) this.hive.rooms.linkTask(task, input.room, room.hash);
    });
    if (duplicate!) return duplicate;
    this.hive.bus.emit('channel', this.hive.getChannel(this.row(taskId).channel_id));
    return this.published(actor, taskId, taskId);
  }
  event(actor: Agent, taskId: string, raw: unknown) {
    if (actor.role !== 'brain' && actor.role !== 'worker') throw new HiveError(403, 'Only task participants submit events');
    const parsed = taskEventSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid task event: ' + parsed.error.message);
    const input = parsed.data, action = input.action, hash = this.hash({ taskId, event: input });
    let messageId = '', duplicate: ReturnType<TaskStore['retry']>;
    this.transaction(() => {
      const task = this.get(actor, taskId);
      duplicate = this.retry(actor, input.requestId, hash); if (duplicate) return;
      const brainAction = action.type === 'revise' || action.type === 'review';
      if (!isClaimAction(action.type) && (brainAction ? actor.role !== 'brain' || actor.id !== task.assignerId : actor.role !== 'worker' || actor.id !== task.workerId))
        throw new HiveError(403, 'This event belongs to the assigning brain or the assigned worker');
      if (!this.hive.canPost(actor, this.hive.getChannel(task.channelId))) throw new HiveError(403, 'Cannot post in this task channel');
      if (input.expectedRevision !== task.revision) throw new HiveError(409, 'Task changed; get_task and use its current revision');
      this.hive.rooms.checkTask(actor, task, action.type);
      const previousWorkerId = task.workerId;
      if (action.type === 'accept' || action.type === 'result' || (action.type === 'review' && action.decision === 'accepted'))
        this.coordination.assertReady(task);
      if (isClaimAction(action.type)) {
        this.coordination.apply(actor, task, claimActionSchema.parse(action));
      } else if (action.type === 'revise') {
        const worker = this.worker(actor, action.worker);
        const room = this.hive.rooms.peek(task.channelId);
        if (room && !room.participantIds.includes(worker.id)) throw new HiveError(403, 'Replacement worker must be a declared room participant');
        this.writable(actor, worker, this.hive.getChannel(task.channelId));
        this.contract(actor, action.contract, task.id);
        this.evidence(worker, action.contract.evidenceSeqs);
        task.workerId = worker.id; task.workerName = worker.name;
        task.contract = action.contract; task.contractVersion++; task.state = 'sent'; task.result = null; task.review = null;
      } else if (action.type === 'review') {
        if (task.state !== 'result_submitted') throw new HiveError(409, 'Review requires a submitted result');
        this.evidence(actor, action.evidenceSeqs);
        if (action.decision === 'changes_requested' && action.evidenceSeqs.length) {
          try { this.evidence(this.hive.getAgent(task.workerId), action.evidenceSeqs); }
          catch (error) {
            if (error instanceof HiveError && error.status === 403)
              throw new HiveError(403, 'Changes-requested review evidence must be readable by the assigned worker; use a reference in a shared channel');
            throw error;
          }
        }
        task.review = { reviewerId: actor.id, decision: action.decision, summary: action.summary };
        task.state = action.decision === 'accepted' ? 'accepted_complete' : 'changes_requested';
        if (action.decision === 'accepted' && task.claim?.state === 'held')
          task.claim = { ...task.claim, state: 'released', version: task.claim.version + 1, updatedAt: Date.now() };
      } else if (action.type === 'accept' || action.type === 'reject') {
        if (!(action.type === 'accept' ? ['sent', 'delivered', 'blocked', 'changes_requested'] : ['sent', 'delivered']).includes(task.state))
          throw new HiveError(409, 'Task cannot be accepted/rejected in its current state');
        task.state = action.type === 'accept' ? 'accepted' : 'rejected';
      } else {
        if (!['accepted', 'blocked', 'changes_requested'].includes(task.state)) throw new HiveError(409, 'Accept the current contract before submitting work');
        if (action.type === 'block') task.state = 'blocked';
        else if (action.type === 'checkpoint') {
          const references = [...action.checkpoint.evidenceSeqs, ...action.checkpoint.checks.flatMap(check => check.evidenceSeqs)];
          this.evidence(actor, references);
          this.evidence(this.hive.getAgent(task.assignerId), references);
          task.checkpoint = { version: (task.checkpoint?.version ?? 0) + 1,
            taskRevision: task.revision + 1, contractVersion: task.contractVersion, workerId: task.workerId,
            objective: task.contract.objective, worktree: task.contract.worktree, branch: task.contract.branch,
            savedAt: Date.now(), state: task.state, messageId: '', messageSeq: 0, data: action.checkpoint };
        } else {
          if (action.type !== 'result') throw new HiveError(400, 'Unknown task action');
          this.evidence(actor, [...action.result.evidenceSeqs, ...action.result.checks.flatMap(c => c.evidenceSeqs)]);
          this.evidence(this.hive.getAgent(task.assignerId), [...action.result.evidenceSeqs, ...action.result.checks.flatMap(c => c.evidenceSeqs)]);
          task.result = action.result; task.review = null; task.state = 'result_submitted';
        }
      }
      task.revision++;
      messageId = this.write(actor, task, { taskId, channelId: task.channelId, revision: task.revision,
        contractVersion: task.contractVersion, actorId: actor.id, actorRole: actor.role as 'brain' | 'worker',
        assignerId: task.assignerId, workerId: task.workerId,
        ...(previousWorkerId !== task.workerId ? { previousWorkerId } : {}),
        ...(action.type === 'checkpoint' ? { checkpointVersion: task.checkpoint!.version } : {}),
        ...(task.claim ? { claimVersion: task.claim.version } : {}), action }, input.requestId, hash, false);
    });
    return duplicate! ?? this.published(actor, taskId, messageId);
  }
  /** Called inside the receipt transaction; no chat message or model wake. */
  recordReceipt(workerId: string, seqs: number[], at: number): string[] {
    return (this.db.prepare(`UPDATE task_records SET received_at = ? WHERE worker_id = ? AND received_at IS NULL
      AND dispatch_seq IN (SELECT value FROM json_each(?)) RETURNING id`).all(at, workerId, JSON.stringify(seqs)) as { id: string }[]).map(r => r.id);
  }
}
