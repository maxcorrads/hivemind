import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AdaptiveTopologyDecision } from '../shared/adaptive-topology.ts';
import { classifyCapture, type EvidenceCaptureReason, type EvidenceCaptureView } from '../shared/evidence-health.ts';
import { Storage } from './storage.ts';
import { validJevModel } from './adaptive-config.ts';
import { ADAPTIVE_TOPOLOGY_CONTRACT_VERSION } from './adaptive-topology-provider.ts';
import { jevAnswerState } from '../shared/jev-outcome.ts';

export const EVIDENCE_VERSION = 'adaptive-evidence-v1';
export const EVIDENCE_RUN_LIMIT = 50;
export const EVIDENCE_ATTEMPT_LIMIT = 500;
const modes = ['single', 'brain_one_worker', 'brain_multi_dm', 'brain_multi_room'];
export type EvidenceScope = { executionId: string; channelId: string; projectId: string; phase: 'initial' | 'continuous' };
export type EvidenceInput = { topology: string | null; workers: number; usableWorkers: number; policyVersion: string };
type RunRow = { execution_id: string; snapshot: string };
type Totals = { started: number; finished: number; ok: number; unavailable: number; usageObservations: number;
  inputTokens: number; outputTokens: number; latencyMs: number; latencyObservations: number; prunedAttempts: number;
  /**
   * Subsets of `ok` (#209): answers below MIN_TOPOLOGY_CONFIDENCE or incoherent (`uncertain`), and of those the
   * incoherent ones. Absent on runs recorded before #209.
   */
  uncertain?: number; incoherent?: number };
export type EvidenceAttempt = { ordinal: number; phase: EvidenceScope['phase']; status: 'pending' | 'ok' | 'unavailable';
  currentTopology: string | null; currentWorkers: number; usableWorkers: number;
  targetTopology: string | null; targetWorkers: number | null; confidence: number | null;
  latencyMs: number | null; inputTokens: number | null; outputTokens: number | null; model: string | null;
  /** `ok` attempts only (#209): whether routing could act on the answer. Absent on attempts recorded before it. */
  certainty?: 'confident' | 'uncertain' | 'incoherent' | null;
  /** Requested Jev identifier (alias or pinned), kept apart from the resolved `model`. Absent before #134. */
  requestedModel?: string | null };
type RunState = { policyVersion: string; firstRecordedAt: number; lastRecordedAt: number; totals: Totals; models: string[]; modelsTruncated: boolean;
  /** Absent on runs recorded before #134: requested identifiers are then unknown, not empty. */
  requestedModels?: string[]; requestedModelsTruncated?: boolean;
  /** Jev contract versions of the finished attempts (#207). Absent on runs recorded before it: those were all v2. */
  contractVersions?: string[];
  /** Collector-health tracking (#135), kept inside the snapshot JSON (no DDL). Absent on records made before it existed. */
  capture?: CaptureState };
/** Attempts known to be missing from this record: begins/finishes that failed, or failures that could not be attributed. */
export type EvidenceGap = { missedBegins: number; missedFinishes: number; unattributed: number; firstAt: number; lastAt: number };
type CaptureState = { version: 1; firstPhase: EvidenceScope['phase'] | null; gap: EvidenceGap | null; legacy?: true };
const newCapture = (firstPhase: CaptureState['firstPhase']): CaptureState => ({ version: 1, firstPhase, gap: null });
function mergeGap(a: EvidenceGap | null, b: EvidenceGap): EvidenceGap {
  if (!a) return { ...b };
  return { missedBegins: add(a.missedBegins, b.missedBegins), missedFinishes: add(a.missedFinishes, b.missedFinishes),
    unattributed: add(a.unattributed, b.unattributed), firstAt: Math.min(a.firstAt, b.firstAt), lastAt: Math.max(a.lastAt, b.lastAt) };
}
/**
 * Why a record is not a complete capture. `memoryGap`: a gap marker the live collector holds but has not persisted yet.
 * Pruned detail is reported separately so lifetime counters can still be totals when nothing else is missing.
 */
function captureReasons(state: RunState, first: Pick<EvidenceAttempt, 'ordinal' | 'phase'> | undefined, memoryGap = false): EvidenceCaptureReason[] {
  const reasons: EvidenceCaptureReason[] = [], capture = state.capture, t = state.totals;
  if (!capture || capture.legacy) reasons.push('legacy_record');
  if (capture?.gap || memoryGap) reasons.push('collection_gap');
  if (t.prunedAttempts > 0) reasons.push('history_truncated');
  // Legacy records infer the first phase from retained detail; undefined means it can no longer be known.
  const firstPhase = capture && !capture.legacy ? capture.firstPhase : first?.ordinal === 1 ? first.phase : undefined;
  if (firstPhase === 'continuous' || (firstPhase === null && !capture?.gap)) reasons.push('recorder_installed_mid_execution');
  if (t.started > t.finished && !capture?.gap && !memoryGap) reasons.push('attempts_pending');
  return reasons;
}
function pruneAttempts(db: DatabaseSync, executionId: string): number {
  return Number(db.prepare(`DELETE FROM adaptive_evidence_attempts WHERE execution_id=? AND id NOT IN
    (SELECT id FROM adaptive_evidence_attempts WHERE execution_id=? ORDER BY rowid DESC LIMIT ?)`)
    .run(executionId, executionId, EVIDENCE_ATTEMPT_LIMIT).changes);
}
function pruneRuns(db: DatabaseSync, scope: EvidenceScope): void {
  const hasExecutions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_topology_executions'").get();
  const active = hasExecutions ? db.prepare(`SELECT execution_id FROM adaptive_topology_executions
    WHERE channel_id=? AND json_extract(snapshot, '$.completedAt') IS NULL`).all(scope.channelId).map(row => String(row.execution_id)) : [];
  // Rejected initial requests must not evict the executions that still own the channel (one per brain).
  // They and the attempt being recorded count toward the hard per-channel limit.
  db.prepare(`DELETE FROM adaptive_evidence_runs WHERE channel_id=? AND execution_id NOT IN
    (SELECT execution_id FROM adaptive_evidence_runs WHERE channel_id=?
      ORDER BY (execution_id=? OR execution_id IN (SELECT value FROM json_each(?))) DESC,
        json_extract(snapshot, '$.lastRecordedAt') DESC, rowid DESC LIMIT ?)`)
    .run(scope.channelId, scope.channelId, scope.executionId, JSON.stringify(active), EVIDENCE_RUN_LIMIT);
}
const safeInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function add(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < 0) throw new Error('Evidence counter overflow');
  return sum;
}

/** Numeric/enum allowlist only. Never accepts request text, config objects or raw provider envelopes. */
export class AdaptiveEvidenceStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  begin(scope: EvidenceScope, input: EvidenceInput): string {
    if (!scope.executionId || !scope.channelId || !scope.projectId || !['initial', 'continuous'].includes(scope.phase))
      throw new Error('Invalid evidence scope');
    if (!(input.topology === null || modes.includes(input.topology)) || !safeInt(input.workers) || !safeInt(input.usableWorkers) ||
      !/^[a-z0-9.-]{1,80}$/i.test(input.policyVersion)) throw new Error('Invalid evidence snapshot');
    return Storage.for(this.db).transaction(() => {
      const existing = this.db.prepare('SELECT snapshot,channel_id,project_id FROM adaptive_evidence_runs WHERE execution_id=?').get(scope.executionId);
      if (existing && (existing.channel_id !== scope.channelId || existing.project_id !== scope.projectId)) throw new Error('Evidence scope conflict');
      const state: RunState = existing ? JSON.parse(String(existing.snapshot)) as RunState : {
        policyVersion: input.policyVersion, firstRecordedAt: Date.now(), lastRecordedAt: Date.now(), models: [], modelsTruncated: false,
        requestedModels: [], requestedModelsTruncated: false, contractVersions: [],
        capture: newCapture(scope.phase),
        totals: { started: 0, finished: 0, ok: 0, unavailable: 0, usageObservations: 0,
          inputTokens: 0, outputTokens: 0, latencyMs: 0, latencyObservations: 0, prunedAttempts: 0, uncertain: 0, incoherent: 0 },
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
      pruneRuns(this.db, scope);
      return id;
    });
  }
  finish(id: string, decision: AdaptiveTopologyDecision): void {
    Storage.for(this.db).transaction(() => {
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
      attempt.requestedModel = validJevModel(decision.requestedModel) ? decision.requestedModel : null;
      if (attempt.requestedModel && state.requestedModels && !state.requestedModels.includes(attempt.requestedModel)) {
        if (state.requestedModels.length < 16) state.requestedModels.push(attempt.requestedModel); else state.requestedModelsTruncated = true;
      }
      // A run that straddles a contract change exports as `mixed`, so a study never pools the two contracts.
      const contract = CONTRACT_VERSIONS.includes(decision.contractVersion) ? decision.contractVersion : 'unknown';
      state.contractVersions ??= [LEGACY_CONTRACT_VERSION];
      if (!state.contractVersions.includes(contract)) state.contractVersions.push(contract);
      attempt.targetTopology = modes.includes(decision.targetTopology) ? decision.targetTopology : null;
      attempt.targetWorkers = safeInt(decision.targetWorkers) ? decision.targetWorkers : null;
      attempt.confidence = typeof decision.confidence === 'number' && decision.confidence >= 0 && decision.confidence <= 1 ? decision.confidence : null;
      attempt.latencyMs = duration(decision.latencyMs) ? decision.latencyMs : null;
      const known = safeInt(decision.inputTokens) && safeInt(decision.outputTokens);
      attempt.inputTokens = known ? decision.inputTokens : null; attempt.outputTokens = known ? decision.outputTokens : null;
      totals.finished = add(totals.finished, 1); totals[attempt.status] = add(totals[attempt.status], 1);
      // An uncertain or incoherent answer is a successful call (#209): counted as `ok`, and in these subsets.
      if (attempt.status === 'ok') {
        const state = jevAnswerState(decision);
        attempt.certainty = state === 'incoherent' ? 'incoherent' : state === 'uncertain' ? 'uncertain' : 'confident';
        if (attempt.certainty !== 'confident' && totals.uncertain !== undefined) totals.uncertain = add(totals.uncertain, 1);
        if (attempt.certainty === 'incoherent' && totals.incoherent !== undefined) totals.incoherent = add(totals.incoherent, 1);
      }
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
  /**
   * Persists a conservative collection-gap marker for attempts the collector failed to record. A record that does not
   * exist yet (its first begin failed, or retention evicted it) is created as gap-only evidence, never as a complete
   * capture. Returns `discarded` when the channel no longer exists: its evidence was deleted with it.
   */
  recordGap(scope: Omit<EvidenceScope, 'phase'>, policyVersion: string, gap: EvidenceGap): 'persisted' | 'discarded' {
    return Storage.for(this.db).transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM channels WHERE id=?').get(scope.channelId)) return 'discarded';
      const existing = this.db.prepare('SELECT snapshot,channel_id,project_id FROM adaptive_evidence_runs WHERE execution_id=?').get(scope.executionId);
      if (existing && (existing.channel_id !== scope.channelId || existing.project_id !== scope.projectId)) return 'discarded';
      const state: RunState = existing ? JSON.parse(String(existing.snapshot)) as RunState : {
        policyVersion, firstRecordedAt: gap.firstAt, lastRecordedAt: gap.lastAt, models: [], modelsTruncated: false,
        requestedModels: [], requestedModelsTruncated: false, contractVersions: [], capture: newCapture(null),
        totals: { started: 0, finished: 0, ok: 0, unavailable: 0, usageObservations: 0,
          inputTokens: 0, outputTokens: 0, latencyMs: 0, latencyObservations: 0, prunedAttempts: 0, uncertain: 0, incoherent: 0 },
      };
      state.capture ??= { ...newCapture(null), legacy: true };
      state.capture.gap = mergeGap(state.capture.gap, gap);
      state.lastRecordedAt = Math.max(state.lastRecordedAt, Date.now());
      this.db.prepare(`INSERT INTO adaptive_evidence_runs(execution_id,channel_id,project_id,snapshot) VALUES(?,?,?,?)
        ON CONFLICT(execution_id) DO UPDATE SET snapshot=excluded.snapshot`)
        .run(scope.executionId, scope.channelId, scope.projectId, JSON.stringify(state));
      pruneRuns(this.db, { ...scope, phase: 'continuous' });
      return 'persisted';
    });
  }
  /**
   * Marks every retained record that may have been affected by failures the bounded in-memory marker set could not
   * name individually: records of executions still running and records touched since the first such failure.
   */
  recordUnattributedGap(since: number, now = Date.now()): number {
    return Storage.for(this.db).transaction(() => {
      const hasExecutions = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_topology_executions'").get();
      const rows = this.db.prepare(`SELECT execution_id,snapshot FROM adaptive_evidence_runs WHERE json_extract(snapshot,'$.lastRecordedAt')>=?
        ${hasExecutions ? `OR execution_id IN (SELECT execution_id FROM adaptive_topology_executions WHERE json_extract(snapshot,'$.completedAt') IS NULL)` : ''}`)
        .all(since);
      for (const row of rows) {
        const state = JSON.parse(String(row.snapshot)) as RunState;
        state.capture ??= { ...newCapture(null), legacy: true };
        state.capture.gap = mergeGap(state.capture.gap, { missedBegins: 0, missedFinishes: 0, unattributed: 1, firstAt: since, lastAt: now });
        this.db.prepare('UPDATE adaptive_evidence_runs SET snapshot=? WHERE execution_id=?').run(JSON.stringify(state), String(row.execution_id));
      }
      return rows.length;
    });
  }
}

/**
 * Human-only capture state of one execution's evidence, or null when nothing was recorded for it.
 * `memoryGap`: the live collector holds an unpersisted gap marker for this execution.
 */
export function evidenceCapture(db: DatabaseSync, executionId: string, memoryGap = false): EvidenceCaptureView | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_evidence_runs'").get())
    return memoryGap ? classifyCapture(['collection_gap']) : null;
  const run = db.prepare('SELECT snapshot FROM adaptive_evidence_runs WHERE execution_id=?').get(executionId) as RunRow | undefined;
  if (!run) return memoryGap ? classifyCapture(['collection_gap']) : null;
  const first = db.prepare('SELECT snapshot FROM adaptive_evidence_attempts WHERE execution_id=? ORDER BY rowid LIMIT 1').get(executionId);
  return classifyCapture(captureReasons(JSON.parse(run.snapshot) as RunState,
    first ? JSON.parse(String(first.snapshot)) as EvidenceAttempt : undefined, memoryGap));
}

const LEGACY_CONTRACT_VERSION = 'adaptive-routing-v2';
const CONTRACT_VERSIONS: string[] = [LEGACY_CONTRACT_VERSION, ADAPTIVE_TOPOLOGY_CONTRACT_VERSION];
/** One version for a homogeneous run; `mixed` when its attempts used different contracts. */
function contractVersionOf(state: RunState): string {
  const versions = state.contractVersions;
  if (!versions) return LEGACY_CONTRACT_VERSION;
  if (versions.length > 1) return 'mixed';
  return versions[0] ?? ADAPTIVE_TOPOLOGY_CONTRACT_VERSION;
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
        inputTokens: a.inputTokens, outputTokens: a.outputTokens, requestedModel: a.requestedModel ?? null, model: a.model,
        certainty: a.certainty ?? null };
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
  const reasons = captureReasons(state, attempts[0]), gap = state.capture?.gap ?? null;
  const capture = classifyCapture(reasons);
  // Pruned detail keeps exact lifetime counters; every other reason means the counters are not full-run totals.
  const aggregate = classifyCapture(reasons.filter(reason => reason !== 'history_truncated'));
  const usageComplete = t.usageObservations === t.started && aggregate.capture === 'complete';
  return {
    schemaVersion: 1, evidenceClass: EVIDENCE_VERSION, contractVersion: contractVersionOf(state), policyVersion: state.policyVersion,
    executionAlias: 'execution-1', models: state.models, modelsTruncated: state.modelsTruncated,
    requestedModels: state.requestedModels ?? null, requestedModelsTruncated: state.requestedModelsTruncated ?? null,
    coverage: { startedAt: state.firstRecordedAt, endedAt: state.lastRecordedAt, attemptsStarted: t.started,
      attemptsFinished: t.finished, pendingAttempts: t.started - t.finished, retainedAttempts: attempts.length,
      prunedAttempts: t.prunedAttempts, historyComplete: capture.capture === 'complete' && t.prunedAttempts === 0 &&
        attempts[0]?.ordinal === 1 && attempts[0]?.phase === 'initial',
      usageComplete, collection: 'since_recorder_installation', countsAre: 'classifier_attempts_not_verified_billable_calls',
      capture: capture.capture, captureReasons: capture.reasons, aggregateCapture: aggregate.capture,
      collectionGap: gap && { missedBegins: gap.missedBegins, missedFinishes: gap.missedFinishes, unattributed: gap.unattributed } },
    overhead: { successfulAttempts: t.ok, unavailableAttempts: t.unavailable,
      // Subsets of successfulAttempts (#209); null on runs recorded before these counters existed.
      uncertainAttempts: t.uncertain ?? null, incoherentAttempts: t.incoherent ?? null,
      tokenObservations: t.usageObservations, unknownUsageAttempts: t.started - t.usageObservations,
      knownInputTokens: t.inputTokens, knownOutputTokens: t.outputTokens,
      totalInputTokens: usageComplete ? t.inputTokens : null, totalOutputTokens: usageComplete ? t.outputTokens : null,
      summedLatencyMs: t.latencyObservations === t.started && aggregate.capture === 'complete' ? t.latencyMs : null,
      knownLatencyMs: t.latencyMs, latencyObservations: t.latencyObservations, monetaryCost: null },
    attempts, policyEvents, policyEventCoverage: 'retained_tail_only',
    limitations: ['No prompt, API key, project/worker name, raw provider response or stable execution identifier is exported.',
      'Classification attempts include capacity retries and responses later discarded as stale; they are not applied-transition counts.',
      'Summed classifier latency is overhead, not elapsed execution wall time. Do not add it to end-to-end wall time.',
      'No historical backfill, provider billing reconciliation, quality assessment or counterfactual savings is inferred.',
      'Capture state reflects persisted gap markers only; a process crash while the store was unwritable can leave a gap unrecorded.',
      'requestedModels is what Hivemind asked for; models is what the provider reported. Even a pinned identifier is not assumed immutable.'],
  };
}
