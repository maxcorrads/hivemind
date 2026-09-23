import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AdaptiveRoutingEvent, AdaptiveTopologyDecision } from '../shared/adaptive-topology.ts';
import { encodeJevCallCursor, type JevCallCursor } from '../shared/jev-calls.ts';
import type { JevCall, JevCallLogView, JevCallOutcome, JevCallSummary, JevCallTrigger, JevRequestGroup } from '../shared/jev-calls.ts';
import { HiveError } from '../shared/types.ts';

/** Human-only local history; the oldest calls of a project are pruned beyond this bound. */
export const JEV_CALLS_PER_PROJECT = 1000;
const REQUEST_EXCERPT = 280;
/** Exported for tests that build a page boundary. */
export const GROUPS_PER_PAGE = 50;

export type JevExchange = { sent: unknown | null; received: unknown | null; error: string | null };
export type JevCallContext = {
  executionId: string; channelId: string; projectId: string; brainId: string | null;
  phase: JevCallSummary['phase']; trigger: JevCallTrigger;
};

function requestOf(sent: unknown): string {
  const text = (sent as { state?: { request?: unknown } } | null)?.state?.request;
  return typeof text === 'string' ? text.slice(0, REQUEST_EXCERPT) : '';
}

/** Records every Jev exchange with the exact payloads; the API key is never part of either. */
export class JevCallLog {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS jev_calls (
      id TEXT PRIMARY KEY, route_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      execution_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      summary TEXT NOT NULL, sent TEXT, received TEXT, outcome TEXT);
      CREATE INDEX IF NOT EXISTS idx_jev_calls_project ON jev_calls(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jev_calls_execution ON jev_calls(execution_id, created_at);`);
  }

  record(context: JevCallContext, exchange: JevExchange, decision: AdaptiveTopologyDecision): JevCallSummary {
    const summary: JevCallSummary = {
      id: randomUUID(), routeId: decision.routeId, projectId: context.projectId, channelId: context.channelId,
      executionId: context.executionId, brainId: context.brainId, createdAt: Date.now(), phase: context.phase,
      trigger: context.trigger, request: requestOf(exchange.sent), status: decision.providerStatus,
      targetTopology: decision.targetTopology, targetWorkers: decision.targetWorkers, confidence: decision.confidence,
      reason: decision.reason, error: exchange.error, model: decision.model, latencyMs: decision.latencyMs,
      inputTokens: decision.inputTokens, outputTokens: decision.outputTokens, outcome: null,
    };
    this.db.prepare(`INSERT INTO jev_calls(id,route_id,project_id,channel_id,execution_id,created_at,summary,sent,received)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(summary.id, summary.routeId, summary.projectId, summary.channelId, summary.executionId,
      summary.createdAt, JSON.stringify(summary), exchange.sent === null ? null : JSON.stringify(exchange.sent),
      exchange.received === null ? null : JSON.stringify(exchange.received));
    this.db.prepare(`DELETE FROM jev_calls WHERE project_id=? AND id NOT IN
      (SELECT id FROM jev_calls WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
      .run(summary.projectId, summary.projectId, JEV_CALLS_PER_PROJECT);
    return summary;
  }

  /** Called with the routing audit event that consumed a Jev answer. */
  settle(event: AdaptiveRoutingEvent): JevCallSummary | null {
    if (!event.routeId) return null;
    const outcome: JevCallOutcome = { kind: event.kind, applied: event.applied, appliedTopology: event.appliedTopology,
      appliedWorkers: event.appliedWorkers, warning: event.warning };
    const changed = this.db.prepare('UPDATE jev_calls SET outcome=? WHERE route_id=?').run(JSON.stringify(outcome), event.routeId).changes;
    if (!changed) return null;
    const row = this.db.prepare('SELECT summary,outcome FROM jev_calls WHERE route_id=?').get(event.routeId);
    return row ? this.summaryOf(row) : null;
  }

  private summaryOf(row: Record<string, unknown>): JevCallSummary {
    const summary = JSON.parse(String(row.summary)) as JevCallSummary;
    return { ...summary, outcome: row.outcome ? JSON.parse(String(row.outcome)) as JevCallOutcome : null };
  }

  /**
   * Requests (executions) with the newest activity first, each with its calls in order.
   * Pages are keyed by the compound cursor (lastAt, executionId) of the last group returned, so groups
   * sharing the boundary millisecond are neither skipped nor repeated.
   */
  view(projectId: string, cursor?: JevCallCursor | null): JevCallLogView {
    const lastAt = cursor?.lastAt ?? Number.MAX_SAFE_INTEGER;
    // Without an execution id (legacy `before=<ms>`), the boundary millisecond is excluded as before.
    const after = cursor?.executionId ?? null;
    const groups = this.db.prepare(`SELECT execution_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at, COUNT(*) AS n
      FROM jev_calls WHERE project_id=? GROUP BY execution_id
      HAVING MAX(created_at) < ? OR (? IS NOT NULL AND MAX(created_at) = ? AND execution_id > ?)
      ORDER BY last_at DESC, execution_id LIMIT ?`).all(projectId, lastAt, after, lastAt, after ?? '', GROUPS_PER_PAGE + 1);
    const requests: JevRequestGroup[] = groups.slice(0, GROUPS_PER_PAGE).map(group => {
      const calls = this.db.prepare('SELECT summary,outcome FROM jev_calls WHERE execution_id=? ORDER BY created_at, rowid')
        .all(String(group.execution_id)).map(row => this.summaryOf(row));
      const first = calls[0]!;
      return { executionId: String(group.execution_id), channelId: first.channelId, brainId: first.brainId,
        request: calls.find(call => call.request)?.request ?? '', firstAt: Number(group.first_at), lastAt: Number(group.last_at),
        callCount: Number(group.n), calls };
    });
    const hasMore = groups.length > GROUPS_PER_PAGE;
    const last = requests.at(-1);
    return { requests, hasMore, nextCursor: hasMore && last ? encodeJevCallCursor({ lastAt: last.lastAt, executionId: last.executionId }) : null };
  }

  get(projectId: string, id: string): JevCall {
    const row = this.db.prepare('SELECT summary,outcome,sent,received FROM jev_calls WHERE id=? AND project_id=?').get(id, projectId);
    if (!row) throw new HiveError(404, 'Jev call not found');
    return { ...this.summaryOf(row), sent: row.sent ? JSON.parse(String(row.sent)) : null,
      received: row.received ? JSON.parse(String(row.received)) : null };
  }
}
