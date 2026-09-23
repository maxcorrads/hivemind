import { CAPTURE_REASON_LABELS, type EvidenceCaptureView, type EvidenceCollectorHealth } from "../src/shared/evidence-health.ts";

/** Collector health in plain words; null when there is nothing to report. Human-only, never raw errors. */
export function collectorHealthLabel(health: EvidenceCollectorHealth | null | undefined): string | null {
  if (!health || health.status === "healthy") return null;
  if (health.status === "degraded") {
    const held = health.overflow ? "too many to track individually" : `${health.pendingGaps} execution${health.pendingGaps === 1 ? "" : "s"}`;
    return `Jev overhead measurement is failing to save (${held}). Routing is unaffected; affected captures are incomplete. ` +
      "A gap marker is held in memory until the store accepts writes again; it is lost if the server stops first.";
  }
  return `Jev overhead measurement recovered after write failures. ${health.persistedGaps} gap marker${health.persistedGaps === 1 ? "" : "s"} saved; ` +
    "affected executions are reported as incomplete.";
}

/** Whether one execution's Jev overhead was completely measured; null when nothing was recorded. */
export function captureLabel(evidence: EvidenceCaptureView | undefined): string | null {
  if (!evidence) return null;
  if (evidence.capture === "complete") return "Measurement complete · every Jev attempt of this execution was recorded.";
  const why = evidence.reasons.map(reason => CAPTURE_REASON_LABELS[reason]).join(" · ");
  return `Measurement ${evidence.capture}${why ? ` · ${why}` : ""}. Recorded usage is not a full-execution total.`;
}

export function CollectorHealthNotice({ health }: { health: EvidenceCollectorHealth | null | undefined }) {
  const label = collectorHealthLabel(health);
  if (!label) return null;
  const degraded = health?.status === "degraded";
  return <p className={degraded ? "routing-warning" : "help-p"} role={degraded ? "alert" : "status"}>{degraded ? "⚠ " : ""}{label}</p>;
}
