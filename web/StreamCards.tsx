import type { TaskEnvelope } from "../src/shared/tasks.ts";

const TASK_LABELS: Record<string, string> = {
  assign: "Assigned", revise: "Revised", accept: "Accepted", reject: "Rejected", block: "Blocked",
  result: "Result submitted", checkpoint: "Checkpoint", claim: "Claimed", renew_claim: "Claim renewed",
  release_claim: "Claim released", reconcile_claim: "Claim reconciled",
};

export function taskEventLabel(envelope: TaskEnvelope): string {
  const action = envelope.action;
  if (action.type === "review") return action.decision === "accepted" ? "Review: accepted" : "Changes requested";
  return TASK_LABELS[action.type] ?? action.type.replaceAll("_", " ");
}

/** The one line that says what this task event is about; the full contract stays behind "Contract details". */
export function taskEventHeadline(envelope: TaskEnvelope): string {
  const action = envelope.action;
  if ("contract" in action && action.contract) return action.contract.objective;
  switch (action.type) {
    case "reject": return action.reason;
    case "block": return `Needs: ${action.needed}`;
    case "result": return action.result.summary;
    case "review": return action.summary;
    case "checkpoint": return `Next: ${action.checkpoint.nextAction}`;
    case "accept": return "Worker accepted the current contract";
    default: return "Advisory claim · no lock or change of task authority";
  }
}

/** The chip's tone: blocked or rejected work is bad, changes requested a warning, progress ok, the rest accent. */
function tone(envelope: TaskEnvelope): string {
  const action = envelope.action;
  if (action.type === "block" || action.type === "reject") return "bad";
  if (action.type === "review") return action.decision === "accepted" ? "ok" : "warn";
  if (action.type === "accept" || action.type === "result") return "ok";
  return "accent";
}

/**
 * Compact task event in the stream: status chip and short task id, objective, assigner → worker, then a footer
 * with Open task and the raw contract behind Contract details.
 */
export function TaskEventCard({ envelope, route, body, onOpen }: {
  envelope: TaskEnvelope;
  route: string | undefined;
  body: string;
  onOpen?: () => void;
}) {
  return (
    <section className="stream-card task-event" aria-label="Task event">
      <div className="card-body">
        <div className="card-top">
          <span className={`tone-chip ${tone(envelope)}`}>{taskEventLabel(envelope)}</span>
          <small className="card-id" title={`Task ${envelope.taskId}`}>{`${envelope.taskId.slice(0, 8)} · rev ${envelope.revision}`}</small>
        </div>
        <p className="card-title">{taskEventHeadline(envelope)}</p>
        {route && <p className="card-meta">{route}</p>}
      </div>
      <div className="card-actions">
        {onOpen && <button type="button" className="card-btn" onClick={onOpen}>Open task</button>}
        <details>
          <summary>Contract details</summary>
          <div className="card-raw">{body}</div>
        </details>
      </div>
    </section>
  );
}

/** A centered rule in the stream: a day ("Today", "Yesterday", a date) or where unread messages start. */
export function StreamDivider({ label, unread = false }: { label: string; unread?: boolean }) {
  return (
    <div className={`stream-divider ${unread ? "unread" : ""}`} role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}
