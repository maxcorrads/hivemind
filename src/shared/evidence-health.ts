/**
 * Human-only health of the classifier evidence collector (#135). It is tracked separately from Jev provider
 * availability: a successful classification does not imply a successful measurement.
 */

/** `complete`: every attempt since the initial one is accounted for. `incomplete`: a known loss. `unknown`: cannot tell. */
export type EvidenceCapture = 'complete' | 'incomplete' | 'unknown';

export type EvidenceCaptureReason =
  /** Some attempts were not recorded (write failure); a gap marker was persisted or is held in memory. */
  | 'collection_gap'
  /** Older attempt detail was pruned by retention; lifetime counters remain. */
  | 'history_truncated'
  /** The recorder was installed (or its record recreated) after the execution began. */
  | 'recorder_installed_mid_execution'
  /** Attempts without a recorded outcome and no gap marker explaining them (in flight, or a crash). */
  | 'attempts_pending'
  /** Jev was called for this execution but no evidence record exists. */
  | 'not_recorded'
  /** Recorded before collector health tracking existed; a silent write failure cannot be ruled out. */
  | 'legacy_record'
  /** The evidence store could not be read. */
  | 'recorder_unavailable';

export type EvidenceCaptureView = { capture: EvidenceCapture; reasons: EvidenceCaptureReason[] };

/** Reasons that are known losses; any other reason only makes the capture unknown. */
export const INCOMPLETE_CAPTURE_REASONS: readonly EvidenceCaptureReason[] =
  ['collection_gap', 'history_truncated', 'recorder_installed_mid_execution'];

export function classifyCapture(reasons: EvidenceCaptureReason[]): EvidenceCaptureView {
  const unique = [...new Set(reasons)];
  const capture: EvidenceCapture = unique.some(reason => INCOMPLETE_CAPTURE_REASONS.includes(reason)) ? 'incomplete'
    : unique.length ? 'unknown' : 'complete';
  return { capture, reasons: unique };
}

/**
 * `healthy`: no write failure since this server started. `degraded`: a failure whose gap marker is still held only
 * in memory (not yet persisted). `recovered`: every marker since the last failure was persisted or its execution deleted.
 */
export type EvidenceCollectorStatus = 'healthy' | 'degraded' | 'recovered';

export type EvidenceCollectorHealth = {
  status: EvidenceCollectorStatus;
  /** Counters since this server started; categories only, never raw database errors. */
  failures: { begin: number; finish: number; marker: number };
  lastFailureAt: number | null;
  lastRecoveredAt: number | null;
  /** Executions whose gap marker is held only in memory (lost if the process stops before it can be written). */
  pendingGaps: number;
  /** Gap markers written to the evidence store since this server started. */
  persistedGaps: number;
  /** Markers dropped because their channel was deleted (its evidence was deleted with it). */
  discardedGaps: number;
  /** True while more executions failed than the bounded in-memory marker set can name individually. */
  overflow: boolean;
};

export const HEALTHY_EVIDENCE_COLLECTOR: EvidenceCollectorHealth = {
  status: 'healthy', failures: { begin: 0, finish: 0, marker: 0 }, lastFailureAt: null, lastRecoveredAt: null,
  pendingGaps: 0, persistedGaps: 0, discardedGaps: 0, overflow: false,
};

export const CAPTURE_REASON_LABELS: Record<EvidenceCaptureReason, string> = {
  collection_gap: 'some attempts were not recorded',
  history_truncated: 'older attempt detail was pruned',
  recorder_installed_mid_execution: 'recording started after the execution began',
  attempts_pending: 'attempts without a recorded outcome',
  not_recorded: 'no evidence record',
  legacy_record: 'recorded before health tracking',
  recorder_unavailable: 'evidence store unreadable',
};
