import type { EvidenceCollectorHealth } from '../shared/evidence-health.ts';
import type { AdaptiveEvidenceStore, EvidenceGap, EvidenceScope } from './adaptive-evidence.ts';

/** Executions whose gap markers are named individually while the store is unwritable; beyond that, one overflow marker. */
export const EVIDENCE_GAP_MARKER_LIMIT = 64;

type PendingGap = { scope: Omit<EvidenceScope, 'phase'>; policyVersion: string; gap: EvidenceGap };

/**
 * Collector health, separate from Jev provider availability. A failed evidence write cannot be recorded in the same
 * failing database, so its gap marker is held in a bounded in-memory set and persisted on the next successful write
 * (or when the Human reads the health, or on shutdown). A process crash while markers are unpersisted loses them:
 * that residual case is documented, not hidden. Never stores raw errors, prompts or keys.
 */
export class EvidenceCollectorMonitor {
  #gaps = new Map<string, PendingGap>();
  /** Time of the first failure that could not be named individually, until it is persisted. */
  #overflowSince: number | null = null;
  #health: EvidenceCollectorHealth = { status: 'healthy', failures: { begin: 0, finish: 0, marker: 0 }, lastFailureAt: null,
    lastRecoveredAt: null, pendingGaps: 0, persistedGaps: 0, discardedGaps: 0, overflow: false };
  constructor(private readonly changed: (health: EvidenceCollectorHealth) => void = () => {}) {}

  health(): EvidenceCollectorHealth { return { ...this.#health, failures: { ...this.#health.failures } }; }
  /** True while this execution has a gap marker (or an unattributed one) not yet persisted. */
  pendingFor(executionId: string): boolean { return this.#gaps.has(executionId) || this.#overflowSince !== null; }
  hasPending(): boolean { return this.#gaps.size > 0 || this.#overflowSince !== null; }

  failed(kind: 'begin' | 'finish', scope: Omit<EvidenceScope, 'phase'>, policyVersion: string, now = Date.now()) {
    const unit: EvidenceGap = { missedBegins: kind === 'begin' ? 1 : 0, missedFinishes: kind === 'finish' ? 1 : 0, unattributed: 0, firstAt: now, lastAt: now };
    const existing = this.#gaps.get(scope.executionId);
    if (existing) {
      const g = existing.gap;
      existing.gap = { ...g, missedBegins: g.missedBegins + unit.missedBegins, missedFinishes: g.missedFinishes + unit.missedFinishes, lastAt: now };
    } else if (this.#gaps.size < EVIDENCE_GAP_MARKER_LIMIT) this.#gaps.set(scope.executionId, { scope: { ...scope }, policyVersion, gap: unit });
    else this.#overflowSince ??= now;
    this.#health.failures[kind]++;
    this.#health.lastFailureAt = now;
    this.#publish();
  }

  /** Persists held markers; each marker is its own transaction, so one stuck marker never blocks the others. */
  flush(store: () => AdaptiveEvidenceStore) {
    if (!this.hasPending()) return;
    // A still-failing store only counts; publishing it would make every retry a realtime event.
    let changed = false;
    for (const [executionId, pending] of this.#gaps) {
      try {
        const outcome = store().recordGap(pending.scope, pending.policyVersion, pending.gap);
        this.#gaps.delete(executionId); changed = true;
        if (outcome === 'persisted') this.#health.persistedGaps++; else this.#health.discardedGaps++;
      } catch { this.#health.failures.marker++; break; }
    }
    if (this.#overflowSince !== null && !this.#gaps.size) {
      try {
        this.#health.persistedGaps += store().recordUnattributedGap(this.#overflowSince);
        this.#overflowSince = null; changed = true;
      } catch { this.#health.failures.marker++; }
    }
    if (changed && !this.hasPending()) this.#health.lastRecoveredAt = Date.now();
    if (changed) this.#publish();
  }

  #publish() {
    const h = this.#health;
    h.pendingGaps = this.#gaps.size; h.overflow = this.#overflowSince !== null;
    h.status = this.hasPending() ? 'degraded' : h.lastFailureAt === null ? 'healthy' : 'recovered';
    this.changed(this.health());
  }
}
