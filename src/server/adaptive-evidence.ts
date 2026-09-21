import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AdaptiveTopologyDecision } from '../shared/adaptive-topology.ts';

export const EVIDENCE_VERSION = 'adaptive-evidence-v1';
export const EVIDENCE_RUN_LIMIT = 50;
export const EVIDENCE_ATTEMPT_LIMIT = 500;
const modes = ['single', 'brain_one_worker', 'brain_multi_dm', 'brain_multi_room'];
export type EvidenceScope = { executionId: string; channelId: string; projectId: string; phase: 'initial' | 'continuous' };
export type EvidenceInput = { topology: string | null; workers: number; usableWorkers: number; policyVersion: string };
type RunRow = { execution_id: string; snapshot: string };
type Totals = { started: number; finished: number; ok: number; unavailable: number; usageObservations: number;
  inputTokens: number; outputTokens: number; latencyMs: number; latencyObservations: number; prunedAttempts: number };
export type EvidenceAttempt = { ordinal: number; phase: EvidenceScope['phase']; status: 'pending' | 'ok' | 'unavailable';
  currentTopology: string | null; currentWorkers: number; usableWorkers: number;
  targetTopology: string | null; targetWorkers: number | null; confidence: number | null;
  latencyMs: number | null; inputTokens: number | null; outputTokens: number | null; model: string | null };
type RunState = { policyVersion: string; firstRecordedAt: number; lastRecordedAt: number; totals: Totals; models: string[]; modelsTruncated: boolean };
function pruneAttempts(db: DatabaseSync, executionId: string): number {
  return Number(db.prepare(`DELETE FROM adaptive_evidence_attempts WHERE execution_id=? AND id NOT IN
    (SELECT id FROM adaptive_evidence_attempts WHERE execution_id=? ORDER BY rowid DESC LIMIT ?)`)
    .run(executionId, executionId, EVIDENCE_ATTEMPT_LIMIT).changes);
}
const safeInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function add(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < 0) throw new Error('Evidence counter overflow');
  return sum;
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('SAVEPOINT adaptive_evidence_write');
  try { const value = work(); db.exec('RELEASE adaptive_evidence_write'); return value; }
  catch (error) { db.exec('ROLLBACK TO adaptive_evidence_write; RELEASE adaptive_evidence_write'); throw error; }
}

/** Numeric/enum allowlist only. Never accepts request text, config objects or raw provider envelopes. */
export class AdaptiveEvidenceStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_evidence_runs (
      execution_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adaptive_evidence_channel ON adaptive_evidence_runs(channel_id);
      CREATE TABLE IF NOT EXISTS adaptive_evidence_attempts (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES adaptive_evidence_runs(execution_id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adaptive_evidence_execution ON adaptive_evidence_attempts(execution_id);`);
  }
  begin(scope: EvidenceScope, input: EvidenceInput): string {
    if (!scope.executionId || !scope.channelId || !scope.projectId || !['initial', 'continuous'].includes(scope.phase))
      throw new Error('Invalid evidence scope');
    if (!(input.topology === null || modes.includes(input.topology)) || !safeInt(input.workers) || !safeInt(input.usableWorkers) ||
      !/^[a-z0-9.-]{1,80}$/i.test(input.policyVersion)) throw new Error('Invalid evidence snapshot');
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT snapshot,channel_id,project_id FROM adaptive_evidence_runs WHERE execution_id=?').get(scope.executionId);
      if (existing && (existing.channel_id !== scope.channelId || existing.project_id !== scope.projectId)) throw new Error('Evidence scope conflict');
      const state: RunState = existing ? JSON.parse(String(existing.snapshot)) as RunState : {
        policyVersion: input.policyVersion, firstRecordedAt: Date.now(), lastRecordedAt: Date.now(), models: [], modelsTruncated: false,
        totals: { started: 0, finished: 0, ok: 0, unavailable: 0, usageObservations: 0,
          inputTokens: 0, outputTokens: 0, latencyMs: 0, latencyObservations: 0, prunedAttempts: 0 },
      };
      if (state.policyVersion !== input.policyVersion) throw new Error('Evidence policy changed within execution');
      state.totals.started = add(state.totals.started, 1); state.lastRecordedAt = Date.now();
      this.db.prepare(`INSERT INTO adaptive_evidence_runs(execution_id,channel_id,project_id,snapshot) VALUES(?,?,?,?)
        ON CONFLICT(execution_id) DO UPDATE SET snapshot=excluded.snapshot`)
        .run(scope.executionId, scope.channelId, scope.projectId, JSON.stringify(state));
      const id = randomUUID();
      const attempt: EvidenceAttempt = { ordinal: state.totals.started, phase: scope.phase, status: 'pending',
        currentTopology: input.topology, currentWorkers: input.workers, usableWorkers: input.usableWorkers,
        targetTopology: null, targetWorkers: null, confidence: null, latencyMs: null, inputTokens: null, outputTokens: null, model: null };
      this.db.prepare('INSERT INTO adaptive_evidence_attempts(id,execution_id,snapshot) VALUES(?,?,?)').run(id, scope.executionId, JSON.stringify(attempt));
      state.totals.prunedAttempts = add(state.totals.prunedAttempts, pruneAttempts(this.db, scope.executionId));
      this.db.prepare('UPDATE adaptive_evidence_runs SET snapshot=? WHERE execution_id=?').run(JSON.stringify(state), scope.executionId);
      this.db.prepare(`DELETE FROM adaptive_evidence_runs WHERE channel_id=? AND execution_id NOT IN
        (SELECT execution_id FROM adaptive_evidence_runs WHERE channel_id=? ORDER BY rowid DESC LIMIT ?)`)
        .run(scope.channelId, scope.channelId, EVIDENCE_RUN_LIMIT);
      return id;
    });
  }
  finish(id: string, decision: AdaptiveTopologyDecision): void {
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT execution_id,snapshot FROM adaptive_evidence_attempts WHERE id=?').get(id);
      if (!row) return;
      const attempt = JSON.parse(String(row.snapshot)) as EvidenceAttempt;
      if (attempt.status !== 'pending') return;
      const run = this.db.prepare('SELECT snapshot FROM adaptive_evidence_runs WHERE execution_id=?').get(String(row.execution_id));
      if (!run) return;
      const state = JSON.parse(String(run.snapshot)) as RunState, totals = state.totals;
      attempt.status = decision.providerStatus === 'ok' ? 'ok' : 'unavailable';
      attempt.model = typeof decision.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(decision.model) ? decision.model : null;
      if (attempt.model && !state.models.includes(attempt.model)) {
        if (state.models.length < 16) state.models.push(attempt.model); else state.modelsTruncated = true;
      }
      attempt.targetTopology = modes.includes(decision.targetTopology) ? decision.targetTopology : null;
      attempt.targetWorkers = safeInt(decision.targetWorkers) ? decision.targetWorkers : null;
      attempt.confidence = typeof decision.confidence === 'number' && decision.confidence >= 0 && decision.confidence <= 1 ? decision.confidence : null;
      attempt.latencyMs = duration(decision.latencyMs) ? decision.latencyMs : null;
      const known = safeInt(decision.inputTokens) && safeInt(decision.outputTokens);
      attempt.inputTokens = known ? decision.inputTokens : null; attempt.outputTokens = known ? decision.outputTokens : null;
      totals.finished = add(totals.finished, 1); totals[attempt.status] = add(totals[attempt.status], 1);
      if (known) {
        totals.usageObservations = add(totals.usageObservations, 1);
        totals.inputTokens = add(totals.inputTokens, decision.inputTokens!);
        totals.outputTokens = add(totals.outputTokens, decision.outputTokens!);
      }
      if (attempt.latencyMs !== null) {
        totals.latencyMs = add(totals.latencyMs, Math.ceil(attempt.latencyMs));
        totals.latencyObservations = add(totals.latencyObservations, 1);
      }
      state.lastRecordedAt = Date.now();
      this.db.prepare('UPDATE adaptive_evidence_attempts SET snapshot=? WHERE id=?').run(JSON.stringify(attempt), id);
      totals.prunedAttempts = add(totals.prunedAttempts, pruneAttempts(this.db, String(row.execution_id)));
      this.db.prepare('UPDATE adaptive_evidence_runs SET snapshot=? WHERE execution_id=?').run(JSON.stringify(state), String(row.execution_id));
    });
  }
}

/** Read-only export for the local Human/operator. Call inside a read transaction for a live database. */
export function exportAdaptiveEvidence(db: DatabaseSync, executionId: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_evidence_runs'").get())
    throw new Error('No Phase 2 evidence recorder in this database; historical usage is unknown');
  const run = db.prepare('SELECT execution_id,snapshot FROM adaptive_evidence_runs WHERE execution_id=?').get(executionId) as RunRow | undefined;
  if (!run) throw new Error('Execution evidence not found (not recorded or outside retention)');
  const state = JSON.parse(run.snapshot) as RunState, t = state.totals;
  const attempts = db.prepare('SELECT snapshot FROM adaptive_evidence_attempts WHERE execution_id=? ORDER BY rowid')
    .all(executionId).map(row => {
      const a = JSON.parse(String(row.snapshot)) as EvidenceAttempt;
      return { ordinal: a.ordinal, phase: a.phase, status: a.status, currentTopology: a.currentTopology,
        currentWorkers: a.currentWorkers, usableWorkers: a.usableWorkers, targetTopology: a.targetTopology,
        targetWorkers: a.targetWorkers, confidence: a.confidence, latencyMs: a.latencyMs,
        inputTokens: a.inputTokens, outputTokens: a.outputTokens, model: a.model };
    });
  const hasPolicyEvents = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_topology_events'").get());
  const policyEvents = hasPolicyEvents ? db.prepare('SELECT snapshot FROM adaptive_topology_events WHERE execution_id=? ORDER BY rowid LIMIT 500')
    .all(executionId).map(row => {
      const value = JSON.parse(String(row.snapshot)) as Record<string, unknown>;
      const mode = (v: unknown) => typeof v === 'string' && modes.includes(v) ? v : null;
      const number = (v: unknown) => safeInt(v) ? v : null;
      return { kind: ['evaluation','transition','warning','lock','status'].includes(String(value.kind)) ? value.kind : 'unknown',
        from: mode(value.fromTopology), target: mode(value.targetTopology), applied: mode(value.appliedTopology),
        targetWorkers: number(value.targetWorkers), appliedWorkers: number(value.appliedWorkers),
        changed: value.applied === true, hasWarning: typeof value.warning === 'string' && value.warning.length > 0 };
    }) : [];
  const usageComplete = t.usageObservations === t.started;
  return {
    schemaVersion: 1, evidenceClass: EVIDENCE_VERSION, contractVersion: 'adaptive-routing-v2', policyVersion: state.policyVersion,
    executionAlias: 'execution-1', models: state.models, modelsTruncated: state.modelsTruncated,
    coverage: { startedAt: state.firstRecordedAt, endedAt: state.lastRecordedAt, attemptsStarted: t.started,
      attemptsFinished: t.finished, pendingAttempts: t.started - t.finished, retainedAttempts: attempts.length,
      prunedAttempts: t.prunedAttempts, historyComplete: t.prunedAttempts === 0,
      usageComplete, collection: 'since_recorder_installation', countsAre: 'classifier_attempts_not_verified_billable_calls' },
    overhead: { successfulAttempts: t.ok, unavailableAttempts: t.unavailable,
      tokenObservations: t.usageObservations, unknownUsageAttempts: t.started - t.usageObservations,
      knownInputTokens: t.inputTokens, knownOutputTokens: t.outputTokens,
      totalInputTokens: usageComplete ? t.inputTokens : null, totalOutputTokens: usageComplete ? t.outputTokens : null,
      summedLatencyMs: t.latencyObservations === t.started ? t.latencyMs : null,
      knownLatencyMs: t.latencyMs, latencyObservations: t.latencyObservations, monetaryCost: null },
    attempts, policyEvents, policyEventCoverage: 'retained_tail_only',
    limitations: ['No prompt, API key, project/worker name, raw provider response or stable execution identifier is exported.',
      'Classification attempts include capacity retries and responses later discarded as stale; they are not applied-transition counts.',
      'Summed classifier latency is overhead, not elapsed execution wall time. Do not add it to end-to-end wall time.',
      'No historical backfill, provider billing reconciliation, quality assessment or counterfactual savings is inferred.'],
  };
}
