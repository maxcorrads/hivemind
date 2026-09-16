import type { InboxStatus, QueueEstimate } from "../src/shared/types.ts";

export function QueueBadge({ count = 0, estimate }: { count?: number; estimate?: QueueEstimate }) {
  const n = estimate?.atLeast ?? count;
  const partial = estimate?.exact === false;
  if (!n && !partial) return null;
  const title = partial
    ? (n ? `At least ${n} waiting; more history remains to scan` : "Queue size unknown; more history remains to scan")
    : `${n} waiting`;
  return <em className="queue-badge" title={title}>{n > 99 ? "99+" : partial ? (n ? `${n}+` : "…") : n}</em>;
}

export function InboxReceipt({ status }: { status?: InboxStatus }) {
  if (!status) return null;
  return <span className="inbox-receipt">
    {status.awaitingReceipt > 0 && <span title="Offered to the client, not yet confirmed. Retained for redelivery.">Receipt pending: {status.awaitingReceipt}</span>}
    {status.acknowledgedMessages > 0 && <span title="Confirmed received. This does not mean the tasks were accepted, completed or reviewed.">Received: {status.acknowledgedMessages}</span>}
  </span>;
}
