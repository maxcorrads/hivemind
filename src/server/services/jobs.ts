import { createHash, randomUUID } from 'node:crypto';
import { jobEventSchema, jobReferenceSchema, type JobView } from '../../shared/jobs.ts';
import { HiveError, type Agent } from '../../shared/types.ts';
import type { TaskSnapshot } from '../../shared/tasks.ts';
import type { Core, AgentDirectory, MessageReader, ChannelAccess } from './ports.ts';
import type { TaskStore } from '../tasks.ts';

type Row = { id: string; project_id: string; brain_id: string; origin_message_id: string | null;
  title: string; state: JobView['state']; revision: number; created_at: number; updated_at: number; closed_at: number | null };
type Deps = Core & { identity: AgentDirectory; tasks: Pick<TaskStore, 'get' | 'view'>;
  messageQueries: Pick<MessageReader, 'getMessageById'>; channels: ChannelAccess };

/** Project jobs group tasks without granting access to any referenced conversation. */
export class JobStore {
  constructor(private readonly deps: Deps) {}
  private get db() { return this.deps.storage.db; }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HiveError(404, 'Job not found');
    return row;
  }
  get(actor: Agent, id: string): JobView {
    const row = this.row(id);
    if (actor.role !== 'human' && (actor.role !== 'brain' || row.project_id !== actor.projectId || row.brain_id !== actor.id))
      throw new HiveError(403, 'Job belongs to another project');
    const states = this.db.prepare("SELECT json_extract(snapshot,'$.state') AS state FROM task_records WHERE job_id=?")
      .all(id) as { state: string }[];
    const counts = { total: states.length, completed: 0, cancelled: 0, paused: 0, active: 0 };
    for (const { state } of states) {
      if (state === 'accepted_complete') counts.completed++;
      else if (state === 'cancelled' || state === 'rejected') counts.cancelled++;
      else if (state === 'paused') counts.paused++;
      else counts.active++;
    }
    return { id, projectId: row.project_id, brainId: row.brain_id, originMessageId: row.origin_message_id,
      title: row.title, state: row.state, revision: row.revision, createdAt: row.created_at,
      updatedAt: row.updated_at, closedAt: row.closed_at, counts };
  }
  list(actor: Agent, projectId?: string): JobView[] {
    if (actor.role !== 'human' && actor.role !== 'brain') throw new HiveError(403, 'Only Human and brains list jobs');
    const project = actor.role === 'human' ? projectId : actor.projectId;
    return (this.db.prepare(`SELECT id FROM jobs ${project ? 'WHERE project_id=?' : ''} ORDER BY updated_at DESC,id`)
      .all(...(project ? [project] : [])) as { id: string }[]).filter(row => actor.role === 'human' || this.row(row.id).brain_id === actor.id).map(row => this.get(actor, row.id));
  }
  event(brain: Agent, raw: unknown): JobView {
    const parsed = jobEventSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid job event: provide requestId, type open and title');
    const { requestId, ...input } = parsed.data;
    return this.resolve(brain, { title: input.title, ...(input.originMessageId ? { originMessageId: input.originMessageId } : {}) }, requestId);
  }
  resolve(brain: Agent, raw: unknown, requestId: string): JobView {
    if (brain.role !== 'brain' || !brain.projectId) throw new HiveError(403, 'Only a project brain opens jobs');
    const parsed = jobReferenceSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid job: provide id or title');
    const input = parsed.data;
    if ('id' in input) {
      const job = this.get(brain, input.id);
      if (job.brainId !== brain.id) throw new HiveError(403, 'Job belongs to another brain');
      if (job.closedAt !== null) throw new HiveError(409, 'Job was closed by Human');
      return job;
    }
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.deps.storage.transaction(() => {
      const prior = this.db.prepare('SELECT job_id,request_hash FROM job_events WHERE actor_id=? AND request_id=?')
        .get(brain.id, requestId) as { job_id: string; request_hash: string } | undefined;
      if (prior) {
        if (prior.request_hash !== hash) throw new HiveError(409, 'requestId was used for a different job');
        return this.get(brain, prior.job_id);
      }
      if (input.originMessageId) {
        const message = this.deps.messageQueries.getMessageById(input.originMessageId);
        const channel = this.deps.channels.getChannel(message.channelId);
        if (message.authorId !== 'human' || channel.projectId !== brain.projectId || !this.deps.channels.canSeeChannel(brain, channel))
          throw new HiveError(403, 'originMessageId must reference a visible Human request in this project');
      }
      const id = randomUUID(), at = Date.now();
      this.db.prepare("INSERT INTO jobs(id,project_id,brain_id,origin_message_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)")
        .run(id, brain.projectId, brain.id, input.originMessageId ?? null, input.title, at, at);
      this.db.prepare('INSERT INTO job_events(id,job_id,actor_id,request_id,request_hash,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), id, brain.id, requestId, hash, at);
      this.changed(id);
      return this.get(brain, id);
    });
  }
  attach(brain: Agent, taskId: string, jobId: string): TaskSnapshot {
    return this.deps.storage.transaction(() => {
      const job = this.get(brain, jobId), task = this.deps.tasks.get(brain, taskId);
      if (brain.role !== 'brain' || task.assignerId !== brain.id || job.brainId !== brain.id)
        throw new HiveError(403, 'Only the assigning brain links its task to its job');
      if (job.closedAt !== null) throw new HiveError(409, 'Job was closed by Human');
      const existing = this.db.prepare('SELECT job_id FROM task_records WHERE id=?').get(taskId) as { job_id: string | null };
      if (existing.job_id && existing.job_id !== jobId) throw new HiveError(409, 'Task already belongs to another job');
      this.db.prepare("UPDATE task_records SET job_id=?,snapshot=json_set(snapshot,'$.jobId',?) WHERE id=?").run(jobId, jobId, taskId);
      this.syncForTask(taskId);
      const view = this.deps.tasks.view(brain, taskId);
      this.deps.storage.afterCommit(() => this.deps.bus.emit('task', view));
      return view;
    });
  }
  syncForTask(taskId: string): void {
    const record = this.db.prepare('SELECT job_id FROM task_records WHERE id=?').get(taskId) as { job_id: string | null } | undefined;
    if (!record?.job_id) return;
    const job = this.get(this.deps.identity.getAgent('human'), record.job_id);
    if (job.closedAt !== null) return;
    const { counts } = job;
    const state: JobView['state'] = counts.active ? 'active' : counts.paused ? 'paused' :
      counts.total ? counts.cancelled === counts.total ? 'cancelled' : 'done' : 'active';
    this.db.prepare('UPDATE jobs SET state=?,revision=revision+1,updated_at=? WHERE id=?').run(state, Date.now(), job.id);
    this.changed(job.id);
  }
  close(actor: Agent, id: string, expectedRevision: number): JobView {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human closes jobs');
    return this.deps.storage.transaction(() => {
      const job = this.get(actor, id);
      if (job.revision !== expectedRevision) throw new HiveError(409, 'Job changed; refresh its revision');
      if (job.counts.active || job.counts.paused) throw new HiveError(409, 'Finish or cancel every task before closing the job');
      if (job.closedAt === null) {
        this.db.prepare("UPDATE jobs SET state=?,closed_at=?,updated_at=?,revision=revision+1 WHERE id=?")
          .run(job.counts.cancelled === job.counts.total && job.counts.total > 0 ? 'cancelled' : 'done', Date.now(), Date.now(), id);
        this.changed(id);
      }
      return this.get(actor, id);
    });
  }
  private changed(id: string): void {
    this.deps.storage.afterCommit(() => this.deps.bus.emit('job', this.get(this.deps.identity.getAgent('human'), id)));
  }
}
