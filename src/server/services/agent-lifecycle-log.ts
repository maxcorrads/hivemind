import type { AgentLifecycleEvent } from '../../shared/agent-management.ts';
import { HiveError } from '../../shared/types.ts';
import type { Core } from './ports.ts';

export const AGENT_LIFECYCLE_PAGE_SIZE = 50;
export const AGENT_LIFECYCLE_MAX_PAGE_SIZE = 100;
export const AGENT_LIFECYCLE_SUMMARY_LIMIT = 400;

export type RecordAgentLifecycleEvent = Omit<AgentLifecycleEvent, 'seq' | 'at'> & { at?: number };
export type AgentLifecyclePage = {
  items: AgentLifecycleEvent[];
  hasMore: boolean;
  nextBefore: number | null;
};

/** Bounded, append-only history of an agent's lifecycle. Callers authorize Human reads. */
export class AgentLifecycleLog {
  constructor(private readonly deps: Core) {}

  record(input: RecordAgentLifecycleEvent): AgentLifecycleEvent {
    if (!input.summary.trim() || input.summary.length > AGENT_LIFECYCLE_SUMMARY_LIMIT)
      throw new HiveError(400, 'Invalid agent lifecycle summary');
    const at = input.at ?? Date.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new HiveError(400, 'Invalid agent lifecycle time');
    const result = this.deps.storage.db.prepare(`INSERT INTO agent_lifecycle_events
      (agent_id,project_id,actor_id,kind,summary,at,source) VALUES (?,?,?,?,?,?,?)`)
      .run(input.agentId, input.projectId, input.actorId, input.kind, input.summary, at, input.source);
    return { seq: Number(result.lastInsertRowid), agentId: input.agentId, projectId: input.projectId,
      actorId: input.actorId, kind: input.kind, summary: input.summary, at, source: input.source };
  }

  list(agentId: string, before?: number, limit = AGENT_LIFECYCLE_PAGE_SIZE): AgentLifecyclePage {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new HiveError(400, 'Invalid agent lifecycle cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_LIFECYCLE_MAX_PAGE_SIZE)
      throw new HiveError(400, 'Invalid agent lifecycle limit');
    const rows = this.deps.storage.db.prepare(`SELECT seq,agent_id AS agentId,project_id AS projectId,
        actor_id AS actorId,kind,summary,at,source FROM agent_lifecycle_events
      WHERE agent_id=? AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?`)
      .all(agentId, before ?? null, before ?? null, limit + 1) as AgentLifecycleEvent[];
    const items = rows.slice(0, limit).map(row => ({ ...row }));
    const hasMore = rows.length > limit;
    return { items, hasMore, nextBefore: hasMore ? items.at(-1)!.seq : null };
  }

  /** Age-based retention in bounded write transactions. */
  prune(cutoff: number, batch = 1000): number {
    if (!Number.isSafeInteger(cutoff) || !Number.isSafeInteger(batch) || batch < 1 || batch > 1000)
      throw new HiveError(400, 'Invalid agent lifecycle retention bound');
    let removed = 0;
    for (;;) {
      const count = Number(this.deps.storage.transaction(() => this.deps.storage.db.prepare(`DELETE FROM agent_lifecycle_events
        WHERE seq IN (SELECT seq FROM agent_lifecycle_events WHERE at<? ORDER BY seq LIMIT ?)`)
        .run(cutoff, batch).changes));
      removed += count;
      if (count < batch) return removed;
    }
  }
}
