import type { Storage } from './storage.ts';

type Row = Record<string, unknown>;
type ExecutionKeys = { executionId: string; channelId: string; brainId: string; projectId: string; rootMessageId: string };
type EventKeys = { id: string; executionId: string; channelId: string; projectId: string; createdAt: number };

/**
 * Every adaptive_topology_* statement (#211): one execution per (channel, brain), i.e. the Human request that brain is
 * serving there with Jev's latest advice, and the Human-only audit of what Jev advised. Nothing here is a lock, budget
 * or admission record. Callers own the transactions; nothing here reads another domain's tables.
 */
export class AdaptiveTopologyStore {
  constructor(private readonly storage: Pick<Storage, 'db'>) {}
  private get db() { return this.storage.db; }

  /** The brain's execution in a channel. */
  currentExecution(channelId: string, brainId: string): Row | undefined {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE channel_id=? AND brain_id=?').get(channelId, brainId);
  }
  channelExecutions(channelId: string): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE channel_id=? ORDER BY rowid').all(channelId);
  }
  execution(executionId: string): Row | undefined {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE execution_id=?').get(executionId);
  }
  /** A brain's executions in a project (whole rows), most recently updated first. */
  brainExecutions(brainId: string, projectId: string): Row[] {
    return this.db.prepare(`SELECT * FROM adaptive_topology_executions WHERE brain_id=? AND project_id=?
      ORDER BY json_extract(snapshot,'$.updatedAt') DESC, rowid DESC`).all(brainId, projectId);
  }
  /** Executions whose request is the given thread root. */
  rootedExecutions(rootMessageId: string): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE root_message_id=? ORDER BY rowid').all(rootMessageId);
  }
  /** Saves an execution; a new Human request replaces the brain's previous execution in the channel. */
  saveExecution(state: ExecutionKeys) {
    this.db.prepare('DELETE FROM adaptive_topology_executions WHERE channel_id=? AND brain_id=? AND execution_id!=?')
      .run(state.channelId, state.brainId, state.executionId);
    this.db.prepare(`INSERT INTO adaptive_topology_executions
      (execution_id,channel_id,brain_id,project_id,root_message_id,snapshot) VALUES(?,?,?,?,?,?)
      ON CONFLICT(execution_id) DO UPDATE SET root_message_id=excluded.root_message_id,snapshot=excluded.snapshot`)
      .run(state.executionId, state.channelId, state.brainId, state.projectId, state.rootMessageId, JSON.stringify(state));
  }

  /** Appends an audit event, keeping the latest 500 of its channel. */
  saveEvent(event: EventKeys) {
    this.db.prepare(`INSERT INTO adaptive_topology_events(id,execution_id,channel_id,project_id,created_at,snapshot)
      VALUES(?,?,?,?,?,?)`).run(event.id, event.executionId, event.channelId, event.projectId, event.createdAt, JSON.stringify(event));
    this.db.prepare(`DELETE FROM adaptive_topology_events WHERE channel_id=? AND rowid NOT IN
      (SELECT rowid FROM adaptive_topology_events WHERE channel_id=? ORDER BY rowid DESC LIMIT 500)`).run(event.channelId, event.channelId);
  }
  /** The latest 100 audit events of a channel, newest first. */
  recentEvents(channelId: string): Row[] {
    return this.db.prepare('SELECT snapshot FROM adaptive_topology_events WHERE channel_id=? ORDER BY rowid DESC LIMIT 100').all(channelId);
  }
}
