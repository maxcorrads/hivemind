import type { TaskEnvelope } from "../src/shared/tasks.ts";
import { decisionSummary } from "./message-stream.ts";

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

/** The one line that says what this task event is about; the full contract stays behind "Details". */
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

function tone(envelope: TaskEnvelope): string {
  const type = envelope.action.type;
  if (type === "block" || type === "reject" || (envelope.action.type === "review" && envelope.action.decision !== "accepted")) return "warn";
  if (type === "accept" || type === "result" || type === "review") return "ok";
  return "info";
}

/** Compact task event in the stream: status chip, objective, assigner → worker, Open and the raw contract. */
export function TaskEventCard({ envelope, route, body, onOpen }: {
  envelope: TaskEnvelope;
  route: string | undefined;
  body: string;
  onOpen?: () => void;
}) {
  return (
    <section className="stream-card task-event" aria-label="Task event">
      <div className="card-top">
        <span className={`chip chip-${tone(envelope)}`}>{taskEventLabel(envelope)}</span>
        <small>Task · revision {envelope.revision}</small>
      </div>
      <p className="card-title">{taskEventHeadline(envelope)}</p>
      {route && <p className="card-meta">{route}</p>}
      <div className="card-actions">
        {onOpen && <button type="button" className="card-btn" onClick={onOpen}>Open</button>}
        <details>
          <summary>Details</summary>
          <div className="card-raw">{body}</div>
        </details>
      </div>
    </section>
  );
}

/** Compact Human decision request; answering happens in the thread's DecisionCard, which holds the authority. */
export function DecisionRequestCard({ body, onOpen }: { body: string; onOpen?: () => void }) {
  const { question, from, deadline } = decisionSummary(body);
  const due = deadline ? new Date(deadline) : null;
  return (
    <section className="stream-card decision-request" aria-label="Decision request">
      <div className="card-top">
        <span className="chip chip-warn">Decision needed</span>
        {from && <small>from {from}</small>}
      </div>
      <p className="card-title">{question}</p>
      {due && !Number.isNaN(due.getTime()) && <p className="card-meta">Needed by {due.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>}
      <div className="card-actions">
        {onOpen && <button type="button" className="card-btn primary" onClick={onOpen}>Answer</button>}
        <details>
          <summary>Details</summary>
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
