import type { Storage } from './storage.ts';

type Row = Record<string, unknown>;
type ExecutionKeys = {
  executionId: string; channelId: string; brainId: string; projectId: string; rootMessageId: string;
  supersededBy?: string | null;
};
type EventKeys = { id: string; executionId: string; channelId: string; projectId: string; createdAt: number };
export type DelegationRow = { root_id: string; worker_id: string; execution_id: string };

/**
 * Every adaptive_topology_* statement: executions (snapshots), conversation locks, the routing event
 * log, evaluated coordination events, and the task / free-form delegation links of an execution.
 * Callers own the transactions; nothing here reads another domain's tables.
 */
export class AdaptiveTopologyStore {
  constructor(private readonly storage: Pick<Storage, 'db'>) {}
  private get db() { return this.storage.db; }

  // Executions
  /** The brain's current execution in a channel. */
  currentExecution(channelId: string, brainId: string): Row | undefined {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE channel_id=? AND brain_id=? AND current=1').get(channelId, brainId);
  }
  channelExecutions(channelId: string): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE channel_id=? ORDER BY rowid').all(channelId);
  }
  execution(executionId: string): Row | undefined {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE execution_id=?').get(executionId);
  }
  /** A brain's executions in a project: current ones first. */
  brainExecutions(brainId: string, projectId: string): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE brain_id=? AND project_id=? ORDER BY current DESC, rowid')
      .all(brainId, projectId);
  }
  projectExecutions(projectId: string): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE project_id=?').all(projectId);
  }
  allExecutions(): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions').all();
  }
  /** Executions whose request is the given thread root. */
  rootedExecutions(rootMessageId: string): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE root_message_id=? ORDER BY rowid').all(rootMessageId);
  }
  /** Superseded executions of a project that are still running. */
  drainingExecutions(projectId: string): Row[] {
    return this.db.prepare(`SELECT snapshot FROM adaptive_topology_executions WHERE project_id=? AND current=0
      AND json_extract(snapshot,'$.completedAt') IS NULL`).all(projectId);
  }
  /** Superseded executions of a (channel, brain) that already finished. */
  finishedSupersededIds(channelId: string, brainId: string): string[] {
    return this.db.prepare(`SELECT execution_id FROM adaptive_topology_executions WHERE channel_id=? AND brain_id=? AND current=0
      AND json_extract(snapshot,'$.completedAt') IS NOT NULL`).all(channelId, brainId).map(row => String(row.execution_id));
  }
  /** The stored revision of an execution (0 before the first); undefined when it does not exist. */
  executionRevision(executionId: string): number | undefined {
    const row = this.db.prepare("SELECT COALESCE(json_extract(snapshot,'$.revision'),0) AS revision FROM adaptive_topology_executions WHERE execution_id=?")
      .get(executionId);
    return row ? Number(row.revision) : undefined;
  }
  /** Inserting a new execution requires its (channel, brain) predecessor to be retired first (unique current). */
  saveExecution(state: ExecutionKeys) {
    this.db.prepare(`INSERT INTO adaptive_topology_executions
      (execution_id,channel_id,brain_id,project_id,root_message_id,snapshot,current) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(execution_id) DO UPDATE SET root_message_id=excluded.root_message_id,snapshot=excluded.snapshot,current=excluded.current`)
      .run(state.executionId, state.channelId, state.brainId, state.projectId, state.rootMessageId, JSON.stringify(state), state.supersededBy ? 0 : 1);
  }
  forgetExecution(executionId: string) {
    this.db.prepare('DELETE FROM adaptive_topology_evaluated WHERE execution_id=?').run(executionId);
    this.db.prepare('DELETE FROM adaptive_topology_executions WHERE execution_id=?').run(executionId);
  }

  // Conversation locks
  conversationLock(channelId: string, brainId: string): unknown {
    return this.db.prepare('SELECT topology FROM adaptive_topology_locks WHERE channel_id=? AND brain_id=?').get(channelId, brainId)?.topology;
  }
  setConversationLock(channelId: string, brainId: string, topology: string | null) {
    if (topology === null) this.db.prepare('DELETE FROM adaptive_topology_locks WHERE channel_id=? AND brain_id=?').run(channelId, brainId);
    else this.db.prepare(`INSERT INTO adaptive_topology_locks(channel_id,brain_id,topology,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(channel_id,brain_id) DO UPDATE SET topology=excluded.topology,updated_at=excluded.updated_at`).run(channelId, brainId, topology, Date.now());
  }

  // Routing events
  /** Appends a routing event, keeping the latest 500 of its channel. */
  saveEvent(event: EventKeys) {
    this.db.prepare(`INSERT INTO adaptive_topology_events(id,execution_id,channel_id,project_id,created_at,snapshot)
      VALUES(?,?,?,?,?,?)`).run(event.id, event.executionId, event.channelId, event.projectId, event.createdAt, JSON.stringify(event));
    this.db.prepare(`DELETE FROM adaptive_topology_events WHERE channel_id=? AND rowid NOT IN
      (SELECT rowid FROM adaptive_topology_events WHERE channel_id=? ORDER BY rowid DESC LIMIT 500)`).run(event.channelId, event.channelId);
  }
  /** The latest 100 routing events of a channel, newest first. */
  recentEvents(channelId: string): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_events WHERE channel_id=? ORDER BY rowid DESC LIMIT 100').all(channelId);
  }

  // Evaluated coordination events (routing votes)
  /** Records an evaluated event, keeping the latest 5000 of the execution. */
  markEvaluated(executionId: string, eventId: string) {
    this.db.prepare('INSERT OR IGNORE INTO adaptive_topology_evaluated(execution_id,event_id) VALUES(?,?)').run(executionId, eventId);
    // Committed mutations retain their own durable retry ledger; this bounds only routing votes.
    this.db.prepare(`DELETE FROM adaptive_topology_evaluated WHERE execution_id=? AND rowid NOT IN
      (SELECT rowid FROM adaptive_topology_evaluated WHERE execution_id=? ORDER BY rowid DESC LIMIT 5000)`)
      .run(executionId, executionId);
  }
  wasEvaluated(executionId: string, eventId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM adaptive_topology_evaluated WHERE execution_id=? AND event_id=?').get(executionId, eventId));
  }
  clearEvaluated(executionId: string) {
    this.db.prepare('DELETE FROM adaptive_topology_evaluated WHERE execution_id=?').run(executionId);
  }

  // Structured task links
  /** The execution a task was admitted under, if any. */
  taskExecution(taskId: string): string | undefined {
    const row = this.db.prepare('SELECT execution_id FROM adaptive_topology_tasks WHERE task_id=?').get(taskId);
    return row ? String(row.execution_id) : undefined;
  }
  linkTask(taskId: string, executionId: string) {
    this.db.prepare('INSERT OR IGNORE INTO adaptive_topology_tasks(task_id,execution_id) VALUES(?,?)').run(taskId, executionId);
  }
  /** Execution of each linked task among `taskIds`. */
  taskExecutions(taskIds: string[]): Map<string, string> {
    const rows = this.db.prepare('SELECT task_id,execution_id FROM adaptive_topology_tasks WHERE task_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(taskIds));
    return new Map(rows.map(row => [String(row.task_id), String(row.execution_id)]));
  }

  // Free-form delegations (a worker bound to a thread root)
  delegationExecution(rootId: string, workerId: string): string | undefined {
    const row = this.db.prepare('SELECT execution_id FROM adaptive_topology_messages WHERE root_id=? AND worker_id=?').get(rootId, workerId);
    return row ? String(row.execution_id) : undefined;
  }
  bindDelegation(rootId: string, workerId: string, executionId: string, projectId: string) {
    this.db.prepare(`INSERT OR IGNORE INTO adaptive_topology_messages
      (root_id,worker_id,execution_id,project_id) VALUES(?,?,?,?)`)
      .run(rootId, workerId, executionId, projectId);
  }
  /** Distinct executions holding delegations on a thread root. */
  threadExecutions(rootId: string): string[] {
    return this.db.prepare('SELECT DISTINCT execution_id FROM adaptive_topology_messages WHERE root_id=?').all(rootId)
      .map(row => String(row.execution_id));
  }
  hasDelegations(rootId: string): boolean {
    return this.db.prepare('SELECT execution_id FROM adaptive_topology_messages WHERE root_id=?').all(rootId).length > 0;
  }
  releaseDelegation(rootId: string, workerId: string) {
    this.db.prepare('DELETE FROM adaptive_topology_messages WHERE root_id=? AND worker_id=?').run(rootId, workerId);
  }
  releaseExecutionDelegations(executionId: string) {
    this.db.prepare('DELETE FROM adaptive_topology_messages WHERE execution_id=?').run(executionId);
  }
  /** Delegations of a project or execution whose execution is still running (thread status not considered). */
  runningDelegations(of: { projectId: string } | { executionId: string }): DelegationRow[] {
    const [column, value] = 'projectId' in of ? ['a.project_id', of.projectId] : ['a.execution_id', of.executionId];
    return this.db.prepare(`SELECT a.root_id,a.worker_id,a.execution_id
      FROM adaptive_topology_messages a
      JOIN adaptive_topology_executions e ON e.execution_id=a.execution_id AND json_extract(e.snapshot,'$.completedAt') IS NULL
      WHERE ${column}=?`).all(value).map(row => ({
      root_id: String(row.root_id), worker_id: String(row.worker_id), execution_id: String(row.execution_id) }));
  }
}
